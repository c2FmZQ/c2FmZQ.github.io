/*
 * Copyright 2021-2022 TTBT Enterprises LLC
 *
 * This file is part of c2FmZQ (https://c2FmZQ.org/).
 *
 * c2FmZQ is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * c2FmZQ is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * c2FmZQ. If not, see <https://www.gnu.org/licenses/>.
 */

/* jshint -W083 */
/* jshint -W097 */
'use strict';

/**
 * c2FmZQ / Stingle client.
 *
 * @class
 */
class c2FmZQClient {
  constructor(options) {
    options.pathPrefix = options.pathPrefix || '/';
    this.options_ = options;
    this.vars_ = {};
    this.resetDB_();
  }

  /*
   * Initialize / restore saved data.
   */
  async init() {
    return Promise.all([
      this.loadVars_(),
      store.get('albums').then(v => {
        this.db_.albums = v || {};
      }),
      store.get('contacts').then(v => {
        this.db_.contacts = v || {};
      }),
    ]);
  }

  /*
   */
  async saveVars_() {
    return store.set('vars', this.vars_);
  }

  /*
   */
  async loadVars_() {
    this.vars_ = await store.get('vars') || {};
    for (let v of ['albumsTimeStamp', 'galleryTimeStamp', 'trashTimeStamp', 'albumFilesTimeStamp', 'contactsTimeStamp', 'deletesTimeStamp']) {
      if (this.vars_[v] === undefined) {
        this.vars_[v] = 0;
      }
    }
    if (this.vars_.server === undefined) {
      this.vars_.server = this.options_.pathPrefix;
    }
  }

  /*
   */
  resetDB_() {
    this.db_ = {
      albums: {},
      files: {
        'gallery': {},
        'trash': {},
      },
      contacts: {},
    };
  }

  /*
   */
  async isLoggedIn(clientId) {
    const loggedIn = typeof this.vars_.token === "string" && this.vars_.token.length > 0 ? this.vars_.email : '';
    const needKey = this.vars_.sk === undefined;
    return Promise.resolve({
      account: loggedIn,
      isAdmin: this.vars_.isAdmin,
      needKey: needKey
    });
  }

  async quota(clientId) {
    return Promise.resolve({
      usage: this.vars_.spaceUsed,
      quota: this.vars_.spaceQuota,
    });
  }

  async passwordForLogin_(salt, password) {
    return sodium.crypto_pwhash(64, password, salt,
      sodium.CRYPTO_PWHASH_OPSLIMIT_MODERATE,
      sodium.CRYPTO_PWHASH_MEMLIMIT_MODERATE,
      sodium.CRYPTO_PWHASH_ALG_ARGON2ID13)
      .then(p => p.toString('hex').toUpperCase());
  }

  async passwordForEncryption_(salt, password) {
    return sodium.crypto_pwhash(32, password, salt,
      sodium.CRYPTO_PWHASH_OPSLIMIT_MODERATE,
      sodium.CRYPTO_PWHASH_MEMLIMIT_MODERATE,
      sodium.CRYPTO_PWHASH_ALG_ARGON2ID13);
  }

  async passwordForValidation_(salt, password) {
    return sodium.sodium_hex2bin(salt)
      .then(salt => {
        return sodium.crypto_pwhash(128, password, salt,
          sodium.CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE,
          sodium.CRYPTO_PWHASH_MEMLIMIT_MODERATE,
          sodium.CRYPTO_PWHASH_ALG_ARGON2ID13);
      })
      .then(p => p.toString('hex').toUpperCase());
  }

  /*
   * Perform the login sequence:
   * - hash the password
   * - send login request
   * - decode / decrypt the keybundle
   */
  async login(clientId, args) {
    const {email, password, server} = args;
    console.log(`SW login ${email}`);
    if (!SAMEORIGIN) {
      this.vars_.server = server || this.vars_.server;
    }

    return this.sendRequest_(clientId, 'v2/login/preLogin', {email: email})
      .then(async resp => {
        console.log('SW hashing password');
        this.vars_.loginSalt = resp.parts.salt;
        const salt = await sodium.sodium_hex2bin(resp.parts.salt);
        const hashed = await this.passwordForLogin_(salt, password);
        return this.sendRequest_(clientId, 'v2/login/login', {email: email, password: hashed});
      })
      .then(async resp => {
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        this.vars_.token = resp.parts.token;
        this.vars_.serverPK = resp.parts.serverPublicKey;
        console.log('SW decrypting secret key');
        const keys = await this.decodeKeyBundle_(password, resp.parts.keyBundle);
        this.vars_.pk = keys.pk;
        if (keys.sk !== undefined) {
          this.vars_.sk = keys.sk;
          this.vars_.keyIsBackedUp = true;
        } else {
          this.vars_.keyIsBackedUp = false;
        }
        console.log('SW logged in');
        this.vars_.email = email;
        this.vars_.userId = resp.parts.userId;
        this.vars_.isAdmin = resp.parts._admin === '1';
        this.vars_.enableNotifications = args.enableNotifications;

        console.log('SW save password hash');
        this.vars_.passwordSalt = (await sodium.randombytes_buf(16)).toString('hex');
        this.vars_.password = await this.passwordForValidation_(this.vars_.passwordSalt, password);

        await this.saveVars_();
        if (this.vars_.keyIsBackedUp) {
          this.enableNotifications(clientId, this.vars_.enableNotifications);
        }
        return {
          account: email,
          isAdmin: this.vars_.isAdmin,
          needKey: this.vars_.sk === undefined,
        };
      });
  }

  async enableNotifications(clientId, onoff) {
    if (!self.registration.pushManager || !self.registration.pushManager.getSubscription) {
      return;
    }
    if (!onoff) {
      return self.registration.pushManager.getSubscription()
        .then(async sub => {
          if (sub === null) {
            return;
          }
          console.log('SW disable push notifications');
          const ep = sub.endpoint;
          sub.unsubscribe();
          return this.sendRequest_(clientId, 'v2x/config/push', {
            token: this.vars_.token,
            params: await this.makeParams_({endpoint: ep}),
          })
          .then(() => false)
          .catch(() => false);
        });
    }
    const options = {
      'userVisibleOnly': true,
    };
    return self.registration.pushManager.getSubscription()
      .then(async sub => {
        if (sub !== null) {
          return sub;
        }
        return this.sendRequest_(clientId, 'v2x/config/push', {token: this.vars_.token})
          .then(resp => {
            if (resp.status !== 'ok') {
              throw resp.status;
            }
            options.applicationServerKey = resp.parts.applicationServerKey;
            return self.registration.pushManager.permissionState(options);
          })
          .then(state => {
            if (state !== 'granted') {
              throw 'permission state: ' + state;
            }
            console.log('SW enable push notifications');
            return self.registration.pushManager.subscribe(options);
          });
      })
      .then(async sub => {
        return this.sendRequest_(clientId, 'v2x/config/push', {
          token: this.vars_.token,
          params: await this.makeParams_({
            endpoint: sub.endpoint,
            auth: self.base64RawUrlEncode(new Uint8Array(sub.getKey('auth'))),
            p256dh: self.base64RawUrlEncode(new Uint8Array(sub.getKey('p256dh'))),
          }),
        });
      })
      .then(resp => {
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        return true;
      });
  }

  async checkPassword_(password) {
    const hash = await this.passwordForValidation_(this.vars_.passwordSalt, password);
    return hash === this.vars_.password;
  }

  async keyBackupEnabled(clientId) {
    return this.vars_.keyIsBackedUp === true;
  }

  async changeKeyBackup(clientId, password, doBackup) {
    if (!await this.checkPassword_(password)) {
      throw new Error('incorrect password');
    }
    console.log('SW reuploading keys');
    const params = {
      keyBundle: await this.makeKeyBundle_(password, await sodiumPublicKey(this.vars_.pk), doBackup ? await sodiumSecretKey(this.vars_.sk) : undefined),
    };
    return this.sendRequest_(clientId, 'v2/keys/reuploadKeys', {
      token: this.vars_.token,
      params: await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      this.vars_.keyIsBackedUp = doBackup;
      return this.saveVars_()
        .then(() => resp.status);
    });
  }

  async restoreSecretKey(clientId, backupPhrase) {
    return sodium.sodium_hex2bin(bip39.mnemonicToEntropy(backupPhrase.trim()))
      .then(sk => {
        return this.checkKey_(clientId, this.vars_.email, this.vars_.pk, sk)
        .then(res => {
          if (res !== true) {
            throw new Error('incorrect backup phrase');
          }
          this.vars_.sk = sk;
          this.enableNotifications(clientId, this.vars_.enableNotifications);
          return this.saveVars_();
        });
      });
  }

  async checkKey_(clientId, email, pk, sk) {
    return this.sendRequest_(clientId, 'v2/login/checkKey', {'email': email})
      .then(async resp => {
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        this.vars_.serverPK = resp.parts.serverPK;
        const challenge = self.base64DecodeToBinary(resp.parts.challenge);
        return sodium.crypto_box_seal_open(challenge, await sodiumPublicKey(pk), await sodiumSecretKey(sk));
      })
      .then(r => r.toString().startsWith('validkey_'));
  }

  async createAccount(clientId, args) {
    const {email, password, enableBackup, server} = args;
    console.log('SW createAccount', email, enableBackup);
    if (!SAMEORIGIN) {
      this.vars_.server = server || this.vars_.server;
    }
    const kp = await sodium.crypto_box_keypair();
    const sk = await sodium.crypto_box_secretkey(kp);
    const pk = await sodium.crypto_box_publickey(kp);
    console.log('SW encrypting secret key');
    const bundle = await this.makeKeyBundle_(password, pk, enableBackup ? sk : undefined);
    const salt = await sodium.randombytes_buf(16);
    console.log('SW hashing password');
    const hashed = await this.passwordForLogin_(salt, password);
    const form = {
      email: email,
      password: hashed,
      salt: salt.toString('hex').toUpperCase(),
      keyBundle: bundle,
      isBackup: enableBackup ? '1' : '0',
    };
    console.log('SW creating account');
    return this.sendRequest_(clientId, 'v2/register/createAccount', form)
      .then(resp => {
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        this.vars_.pk = pk.getBuffer();
        this.vars_.sk = sk.getBuffer();
        return this.saveVars_();
      })
      .then(() => this.login(clientId, args))
      .then(v => {
        if (!enableBackup) {
          self.sendMessage(clientId, {type: 'info', msg: 'Your secret key is NOT backed up. You will need a backup phrase next time you login.'});
        }
        return v;
      });
  }

  async recoverAccount(clientId, args) {
    const {email, password, enableBackup, backupPhrase, server} = args;
    console.log('SW recoverAccount', enableBackup);
    if (!SAMEORIGIN) {
      this.vars_.server = server || this.vars_.server;
    }
    const sk = await sodiumSecretKey(await sodium.sodium_hex2bin(bip39.mnemonicToEntropy(backupPhrase)));
    const pk = await sodium.crypto_box_publickey_from_secretkey(sk);
    if (await this.checkKey_(clientId, email, pk, sk) !== true) {
      throw new Error('incorrect backup phrase');
    }
    this.vars_.pk = pk.getBuffer();
    this.vars_.sk = sk.getBuffer();
    await this.saveVars_();
    console.log('SW encrypting secret key');
    const bundle = await this.makeKeyBundle_(password, pk, enableBackup ? sk : undefined);
    const salt = await sodium.randombytes_buf(16);
    console.log('SW hashing password');
    const hashed = await this.passwordForLogin_(salt, password);
    const params = {
      newPassword: hashed,
      newSalt: salt.toString('hex').toUpperCase(),
      keyBundle: bundle,
      isBackup: enableBackup ? '1' : '0',
    };
    const form = {
      email: email,
      params: await this.makeParams_(params),
    };
    console.log('SW recovering account');
    return this.sendRequest_(clientId, 'v2/login/recoverAccount', form)
      .then(resp => {
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        return this.login(clientId, args);
      })
      .then(v => {
        if (!enableBackup) {
          self.sendMessage(clientId, {type: 'info', msg: _T('no-key-backup-warning')});
        }
        return v;
      });
  }

  async updateProfile(clientId, args) {
    console.log('SW updateProfile');
    if (!await this.checkPassword_(args.password)) {
      throw new Error('incorrect password');
    }
    const curr = await this.mfaStatus(clientId);
    const maybeSetMFA = async () => {
      if (args.setMFA !== curr.mfaEnabled || args.passKey !== curr.passKey) {
        const params = {
          requireMFA: args.setMFA ? '1' : '0',
          passKey: args.passKey ? '1' : '0',
        };
        const resp = await this.sendRequest_(clientId, 'v2x/mfa/enable', {
          token: this.vars_.token,
          params: await this.makeParams_(params),
        });
        if (resp.status !== 'ok') {
          throw new Error('MFA update failed');
        }
      }
    };
    if (!args.setMFA) {
      await maybeSetMFA();
    }

    if (args.setOTP !== curr.otpEnabled) {
      const params = {
        key: ''+args.otpKey,
        code: ''+args.otpCode,
      };
      const resp = await this.sendRequest_(clientId, 'v2x/config/setOTP', {
        token: this.vars_.token,
        params: await this.makeParams_(params),
      });
      if (resp.status !== 'ok') {
        throw new Error('OTP update failed');
      }
    }
    if (this.vars_.email !== args.email) {
      const resp = await this.sendRequest_(clientId, 'v2/login/changeEmail', {
        token: this.vars_.token,
        params: await this.makeParams_({newEmail: args.email}),
      });
      if (resp.status !== 'ok') {
        throw new Error('email update failed');
      }
      this.vars_.email = args.email;
    }
    if (args.newPassword !== '') {
      const salt = await sodium.randombytes_buf(16);
      const pk = await sodiumPublicKey(this.vars_.pk);
      const sk = this.vars_.keyIsBackedUp ? await sodiumSecretKey(this.vars_.sk) : undefined;
      const bundle = await this.makeKeyBundle_(args.newPassword, pk, sk);
      const hashed = await this.passwordForLogin_(salt, args.newPassword);
      const params = {
        keyBundle: bundle,
        newPassword: hashed,
        newSalt: salt.toString('hex').toUpperCase(),
      };
      const resp = await this.sendRequest_(clientId, 'v2/login/changePass', {
        token: this.vars_.token,
        params: await this.makeParams_(params),
      });
      if (resp.status !== 'ok') {
        throw new Error('password update failed');
      }
      this.vars_.loginSalt = salt.toString('hex').toUpperCase();
      this.vars_.token = resp.parts.token;
      const salt2 = (await sodium.randombytes_buf(16)).toString('hex');
      this.vars_.passwordSalt = salt2;
      this.vars_.password = await this.passwordForValidation_(salt2, args.newPassword);
    }
    if (args.keyChanges.length > 0) {
      const params = {
        updates: JSON.stringify(args.keyChanges),
      };
      const resp = await this.sendRequest_(clientId, 'v2x/config/webauthn/updateKeys', {
        token: this.vars_.token,
        params: await this.makeParams_(params),
      });
      if (resp.status !== 'ok') {
        throw new Error('key update failed');
      }
    }
    if (args.setMFA) {
      await maybeSetMFA();
    }
    return this.saveVars_();
  }

  async listSecurityKeys(clientId) {
    console.log('SW listSecurityKeys');
    const resp = await this.sendRequest_(clientId, 'v2x/config/webauthn/keys', {
      token: this.vars_.token,
    });
    if (resp.status !== 'ok') {
      throw new Error('error');
    }
    return resp.parts.keys;
  }

  async addSecurityKey(clientId, args) {
    console.log('SW addSecurityKey');
    if (!args?.password || args.attestationObject && !await this.checkPassword_(args.password)) {
      throw new Error('incorrect password');
    }
    const params = {};
    if (args?.keyName) {
      params.keyName = args.keyName;
      params.discoverable = args.discoverable ? '1' : '0';
      params.clientDataJSON = self.base64RawUrlEncode(args.clientDataJSON);
      params.attestationObject = self.base64RawUrlEncode(args.attestationObject);
      params.transports = JSON.stringify(args.transports);
    } else {
      params.passKey = args.usePassKey ? '1' : '0';
    }
    const resp = await this.sendRequest_(clientId, 'v2x/config/webauthn/register', {
      token: this.vars_.token,
      params: await this.makeParams_(params),
    });
    if (resp.status !== 'ok') {
      throw new Error('error');
    }
    return resp.parts.attestationOptions;
  }

  async mfaStatus(clientId) {
    console.log('SW mfaStatus');
    const resp = await this.sendRequest_(clientId, 'v2x/mfa/status', {token: this.vars_.token});
    if (resp.status !== 'ok') {
      throw new Error('error');
    }
    return resp.parts;
  }

  async mfaCheck(clientId, passKey) {
    console.log('SW mfaCheck');
    const resp = await this.sendRequest_(clientId, 'v2x/mfa/check', {
      token: this.vars_.token,
      params: await this.makeParams_({
        passKey: passKey ? '1' : '0',
      }),
    });
    if (resp.status !== 'ok') {
      throw new Error('error');
    }
    return true;
  }

  async deleteAccount(clientId, password) {
    console.log('SW DELETE ACCOUNT!');
    const salt = await sodium.sodium_hex2bin(this.vars_.loginSalt);
    const params = {
      password: await this.passwordForLogin_(salt, password),
    };
    const resp = await this.sendRequest_(clientId, 'v2/login/deleteUser', {
      token: this.vars_.token,
      params: await this.makeParams_(params),
    });
    if (resp.status !== 'ok') {
      throw resp.status;
    }
    return this.logout(clientId);
  }

  async makeKeyBundle_(password, pk, sk) {
    const out = [0x53, 0x50, 0x4B, 0x1]; // 'SPK', 1
    out.push(sk === undefined ? 0x2 : 0x0);
    out.push(...pk.getBuffer());

    if (sk !== undefined) {
      const salt = await sodium.randombytes_buf(16);
      const key = await this.passwordForEncryption_(salt, password);
      const nonce = await sodium.randombytes_buf(24);
      const esk = await sodium.crypto_secretbox(sk.getBuffer(), nonce, key);
      out.push(...esk);
      out.push(...salt);
      out.push(...nonce);
    }
    return self.base64StdEncode(out);
  }

  async backupPhrase(clientId, password) {
    return this.checkPassword_(password)
    .then(ok => {
      if (!ok) {
        throw new Error('incorrect password');
      }
      return sodiumSecretKey(this.vars_.sk);
    })
    .then(sk => bip39.entropyToMnemonic(sk.getBuffer()));
  }

  /*
   * Logout and clear all saved data.
   */
  async logout(clientId) {
    console.log('SW logout');
    return this.enableNotifications(clientId, false)
      .then(() => this.sendRequest_(clientId, 'v2/login/logout', {'token': this.vars_.token}))
      .then(() => console.log('SW logged out'))
      .catch(console.error)
      .finally(async () => {
        this.vars_ = {};
        this.resetDB_();
        await store.clear();
        await this.deleteCache_();
        this.loadVars_();
        console.log('SW internal data cleared');
      });
  }

  /*
   * Send a getUpdates request, and process the response.
   */
  async getUpdates(clientId) {
    if (this.gettingUpdates_) {
      return;
    }
    this.gettingUpdates_ = true;
    const data = {
      'token': this.vars_.token,
      'filesST': this.vars_.galleryTimeStamp,
      'trashST': this.vars_.trashTimeStamp,
      'albumsST': this.vars_.albumsTimeStamp,
      'albumFilesST': this.vars_.albumFilesTimeStamp,
      'cntST': this.vars_.contactsTimeStamp,
      'delST': this.vars_.deletesTimeStamp,
    };
    return this.sendRequest_(clientId, 'v2/sync/getUpdates', data)
      .then(async resp => {
        console.log('SW getUpdates', resp);
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        // Quota
        this.vars_.spaceUsed = parseInt(resp.parts.spaceUsed);
        this.vars_.spaceQuota = parseInt(resp.parts.spaceQuota);

        /* contacts */
        for (let c of resp.parts.contacts) {
          this.db_.contacts[''+c.userId] = c;
          if (c.dateModified > this.vars_.contactsTimeStamp) {
            this.vars_.contactsTimeStamp = c.dateModified;
          }
        }

        /*  albums */
        const pk = await sodiumPublicKey(this.vars_.pk);
        const sk = await sodiumSecretKey(this.vars_.sk);
        for (let a of resp.parts.albums) {
          try {
            const apk = base64DecodeToBytes(a.publicKey);
            const ask = await sodium.crypto_box_seal_open(base64DecodeToBytes(a.encPrivateKey), pk, sk);

            const md = await Promise.all([
              base64DecodeToBytes(a.metadata),
              sodiumPublicKey(apk),
              sodiumSecretKey(ask),
            ]).then(v => sodium.crypto_box_seal_open(...v));
            const bytes = new Uint8Array(md);
            if (bytes[0] !== 1) {
              throw new Error('unexpected metadata version');
            }
            let size = 0;
            for (let i = 1; i < 5; i++) {
              size = (size << 8) + bytes[i];
            }
            if (5+size > bytes.length) {
              throw new Error('invalid album metadata');
            }
            const name = self.bytesToString(md.slice(5, 5+size));
            let members = [];
            if (typeof a.members === 'string') {
              members = a.members.split(',').filter(m => m !== '');
            }
            const obj = {
              'albumId': a.albumId,
              'pk': apk,
              'encSK': a.encPrivateKey,
              'encName': await this.encrypt_(self.bytesFromString(name)),
              'cover': a.cover,
              'members': members,
              'isOwner': a.isOwner === 1,
              'isShared': a.isShared === 1,
              'permissions': a.permissions,
              'dateModified': a.dateModified,
              'dateCreated': a.dateCreated,
            };
            if (a.dateModified > this.vars_.albumsTimeStamp) {
              this.vars_.albumsTimeStamp = a.dateModified;
            }
            this.db_.albums[a.albumId] = obj;
          } catch (error) {
            console.error('SW getUpdates', a, error);
          }
        }

        let changed = {};

        /* gallery files */
        for (let f of resp.parts.files) {
          try {
            changed.gallery = true;
            const obj = await this.convertFileUpdate_(f, 0);
            this.insertFile_('gallery', f.file, obj);
            if (f.dateModified > this.vars_.galleryTimeStamp) {
              this.vars_.galleryTimeStamp = f.dateModified;
            }
          } catch (error) {
            console.error('SW getUpdates', f, error);
          }
        }

        /* trash files */
        for (let f of resp.parts.trash) {
          try {
            changed.trash = true;
            const obj = await this.convertFileUpdate_(f, 1);
            this.insertFile_('trash', f.file, obj);
            if (f.dateModified > this.vars_.trashTimeStamp) {
              this.vars_.trashTimeStamp = f.dateModified;
            }
          } catch (error) {
            console.error('SW getUpdates', f, error);
          }
        }

        /* album files */
        for (let f of resp.parts.albumFiles) {
          try {
            changed[f.albumId] = true;
            let obj = await this.convertFileUpdate_(f, 2);
            obj.albumId = f.albumId;
            this.insertFile_(f.albumId, f.file, obj);
            if (f.dateModified > this.vars_.albumFilesTimeStamp) {
              this.vars_.albumFilesTimeStamp = f.dateModified;
            }
          } catch (error) {
            console.error('SW getUpdates', f, error);
          }
        }

        /* deletes */
        for (let d of resp.parts.deletes) {
          try {
            let f;
            switch (d.type) {
              case 1: // A file is removed from the gallery.
                f = await this.getFile_('gallery', d.file);
                if (f?.dateModified < d.date) {
                  this.deleteFile_('gallery', d.file);
                  changed.gallery = true;
                }
                break;
              case 2: // A file is removed from the trash (and moved somewhere else).
              case 3: // A file is deleted from the trash.
                f = await this.getFile_('trash', d.file);
                if (f?.dateModified < d.date) {
                  this.deleteFile_('trash', d.file);
                  changed.trash = true;
                }
                break;
              case 4: // An album is deleted.
                if (this.db_.albums[d.albumId]?.dateModified < d.date) {
                  delete this.db_.albums[d.albumId];
                  changed[d.albumId] = true;
                }
                break;
              case 5: // A file is removed from an album.
                f = await this.getFile_(d.albumId, d.file);
                if (f?.dateModified < d.date) {
                  this.deleteFile_(d.albumId, d.file);
                  changed[d.albumId] = true;
                }
                break;
              case 6: // A contact is removed.
                let id = ''+d.file;
                if (this.db_.contacts[id]?.dateModified < d.date) {
                  delete this.db_.contacts[id];
                }
                break;
              default:
                console.error('SW Unexpected delete type', d);
                break;
            }
            if (d.date > this.vars_.deletesTimeStamp) {
              this.vars_.deletesTimeStamp = d.date;
            }
          } catch (error) {
            console.error('SW getUpdates', d, error);
          }
        }
        const p = [
          this.saveVars_(),
          store.set('albums', this.db_.albums),
          store.set('contacts', this.db_.contacts),
          Promise.all(Object.keys(changed).map(collection => this.indexCollection_(collection))),
        ];
        return Promise.all(p)
          .then(v => {
            this.fetchMissingThumbnails_()
            .catch(err => {
              console.log('Error fetching thumbnails', err);
            });
            return v;
          });
      })
      .finally(() => {
        this.gettingUpdates_ = false;
      });
  }

  async emptyTrash(clientId) {
    let params = {
      time: ''+Date.now(),
    };
    return this.sendRequest_(clientId, 'v2/sync/emptyTrash', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async deleteFiles(clientId, files) {
    let params = {
      count: ''+files.length,
    };
    for (let i = 0; i < files.length; i++) {
      params[`filename${i}`] = files[i];
    }
    return this.sendRequest_(clientId, 'v2/sync/delete', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async changeCover(clientId, albumId, cover) {
    let params = {
      albumId: albumId,
      cover: cover,
    };
    return this.sendRequest_(clientId, 'v2/sync/changeAlbumCover', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async moveFiles(clientId, from, to, files, isMove) {
    const fromAlbumId = from === 'gallery' || from === 'trash' ? '' : from;
    const toAlbumId = to === 'gallery' || to === 'trash' ? '' : to;
    const headers = [];
    if (fromAlbumId !== '' || toAlbumId !== '') {
      // Need new headers
      const pk = await sodiumPublicKey(fromAlbumId === '' ? this.vars_.pk : this.db_.albums[fromAlbumId].pk);
      const sk = await sodiumSecretKey(fromAlbumId === '' ? this.vars_.sk : this.decryptAlbumSK_(fromAlbumId));
      const pk2 = await sodiumPublicKey(toAlbumId === '' ? this.vars_.pk : this.db_.albums[toAlbumId].pk);

      for (let i = 0; i < files.length; i++) {
        let f = await this.getFile_(from, files[i]);
        let hdrs = f.origHeaders.split('*');
        hdrs[0] = await this.reEncryptHeader_(hdrs[0], pk, sk, pk2);
        hdrs[1] = await this.reEncryptHeader_(hdrs[1], pk, sk, pk2);
        headers[i] = hdrs.join('*');
      }
    }
    let params = {
      setFrom: from === 'gallery' ? '0' : from === 'trash' ? '1' : '2',
      setTo: to === 'gallery' ? '0' : to === 'trash' ? '1' : '2',
      albumIdFrom: fromAlbumId,
      albumIdTo: toAlbumId,
      isMoving: isMove ? '1' : '0',
      count: ''+files.length,
    };
    for (let i = 0; i < files.length; i++) {
      params[`filename${i}`] = files[i];
      if (headers.length > 0) {
        params[`headers${i}`] = headers[i];
      }
    }
    return this.sendRequest_(clientId, 'v2/sync/moveFile', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async encrypt_(data) {
    const pk = await sodiumPublicKey(this.vars_.pk);
    return sodium.crypto_box_seal(new Uint8Array(data), pk);
  }

  async decrypt_(data) {
    const pk = await sodiumPublicKey(this.vars_.pk);
    const sk = await sodiumSecretKey(this.vars_.sk);
    if (typeof data === 'object' && data.type === 'Buffer') {
      data = data.data;
    }
    try {
      return sodium.crypto_box_seal_open(new Uint8Array(data), pk, sk);
    } catch (error) {
      console.error('SW decrypt_', error);
      throw error;
    }
  }

  async decryptString_(data) {
    return this.decrypt_(data).then(r => self.bytesToString(r));
  }

  async decryptAlbumSK_(albumId) {
    const pk = await sodiumPublicKey(this.vars_.pk);
    const sk = await sodiumSecretKey(this.vars_.sk);
    if (!(albumId in this.db_.albums)) {
      throw new Error('invalid albumId');
    }
    const a = this.db_.albums[albumId];
    return sodiumSecretKey(sodium.crypto_box_seal_open(base64DecodeToBytes(a.encSK), pk, sk));
  }

  async insertFile_(collection, file, obj) {
    return store.set(`files/${collection}/${file}`, obj);
  }

  async deleteFile_(collection, file) {
    return store.del(`files/${collection}/${file}`);
  }

  async getFile_(collection, file) {
    return store.get(`files/${collection}/${file}`);
  }

  async deletePrefix_(prefix) {
    return store.keys()
      .then(keys => keys.filter(k => k.startsWith(prefix)))
      .then(keys => Promise.all(keys.map(k => store.del(k))));
  }

  /*
   */
  async convertFileUpdate_(up, set) {
    const encHeaders = up.headers.split('*');
    return {
      'file': up.file,
      'set': set,
      'headers': [
        await this.decryptHeader_(encHeaders[0], up.albumId),
        await this.decryptHeader_(encHeaders[1], up.albumId),
      ],
      'origHeaders': up.headers,
      'dateCreated': up.dateCreated,
      'dateModified': up.dateModified,
    };
  }

  async indexCollection_(collection) {
    await this.deletePrefix_(`index/${collection}`);

    const prefix = `files/${collection}/`;
    const keys = (await store.keys()).filter(k => k.startsWith(prefix));
    let out = [];
    for (let k of keys) {
      const file = k.substring(prefix.length);
      const f = await this.getFile_(collection, file);
      if (!f) {
        continue;
      }
      const obj = {
        'collection': collection,
        'file': f.file,
        'isImage': f.headers[0].fileType === 2,
        'isVideo': f.headers[0].fileType === 3,
        'fileName': await this.decryptString_(f.headers[0].encFileName),
        'dateCreated': f.dateCreated,
        'dateModified': f.dateModified,
      };
      if (obj.isVideo) {
        obj.duration =  f.headers[0].duration;
      }
      obj.url = await this.getDecryptUrl_(f, false);
      obj.thumbUrl = await this.getDecryptUrl_(f, true);
      out.push(obj);
    }
    out.sort((a, b) => b.dateCreated - a.dateCreated);
    let p = [];
    for (let i = 0; i < out.length; i+=100) {
      let n = ('000000' + i).slice(-6);
      let obj = {
        start: i,
        total: out.length,
        files: out.slice(i, Math.min(i+100, out.length)),
      };
      p.push(store.set(`index/${collection}/${n}`, obj));
    }
    return Promise.all(p);
  }

  async getContact(clientId, email) {
    const params = {
      email: email,
    };
    return this.sendRequest_(clientId, 'v2/sync/getContact', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(async resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      const c = resp.parts.contact;
      this.db_.contacts[''+c.userId] = c;
      await store.set('contacts', this.db_.contacts);
      c.userId = ''+c.userId;
      return c;
    });
  }

  async getContacts(clientId) {
    const contacts = Object.values(this.db_.contacts).map(c => {
      c.userId = ''+c.userId;
      return c;
    });
    contacts.sort((a, b) => {
      if (a.email < b.email) return -1;
      if (a.email > b.email) return 1;
      return 0;
    });
    return contacts;
  }

  /*
   */
  async getFiles(clientId, collection, offset = 0) {
    const n = ('000000' + offset).slice(-6);
    return store.get(`index/${collection}/${n}`);
  }

  /*
   */
  async getCollections(clientId) {
    return new Promise(async resolve => {
      let {url} = await this.getCover(clientId, 'gallery');
      let out = [
        {
          'collection': 'gallery',
          'name': 'gallery',
          'cover': url,
          'isOwner': true,
          'isShared': false,
          'canAdd': true,
          'canCopy': true,
        },
        {
          'collection': 'trash',
          'name': 'trash',
          'cover': null,
          'isOwner': true,
          'isShared': false,
        },
      ];

      let albums = [];
      for (let n in this.db_.albums) {
        if (!this.db_.albums.hasOwnProperty(n)) {
          continue;
        }
        const a = this.db_.albums[n];
        let {url} = await this.getCover(clientId, a.albumId);
        albums.push({
          'collection': a.albumId,
          'name': await this.decryptString_(a.encName),
          'cover': url,
          'members': a.members.map(m => {
            if (m === this.vars_.userId) return {userId: m, email: this.vars_.email, myself: true};
            if (m in this.db_.contacts) return {userId: m, email: this.db_.contacts[m].email};
            return {userId: m, email: '#'+m};
          }).sort(),
          'isOwner': a.isOwner,
          'isShared': a.isShared,
          'canAdd': a.permissions?.match(/^11../) !== null,
          'canShare': a.permissions?.match(/^1.1./) !== null,
          'canCopy': a.permissions?.match(/^1..1/) !== null,
        });
      }
      albums.sort((a, b) => {
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
      });
      out.push(...albums);
      resolve(out);
    });
  }

  async getCover(clientId, collection, opt_code) {
    let code = opt_code;
    if (code === undefined && collection in this.db_.albums) {
      code = this.db_.albums[collection].cover;
    }
    if (code === '__b__') {
      return {url:null, code:code};
    }
    let file = code || '';
    if (file === '') {
      const idx = await store.get(`index/${collection}/000000`);
      if (idx?.files?.length > 0) {
        file = idx.files[0].file;
      }
    }
    if (file === '') {
      return {url:null, code:code};
    }
    const f = await this.getFile_(collection, file);
    if (!f) {
      return {url:null, code:code};
    }
    const url = await this.getDecryptUrl_(f, true);
    return {url:url, code:code};
  }

  async getDecryptUrl_(f, isThumb) {
    if (!f) {
      return null;
    }
    let collection = f.albumId;
    if (f.set === 0) collection = 'gallery';
    else if (f.set === 1) collection = 'trash';
    const fn = await this.decryptString_(f.headers[0].encFileName);
    let url = `${this.options_.pathPrefix}jsdecrypt/${fn}?collection=${collection}&file=${f.file}`;
    if (isThumb) {
      url += '&isThumb=1';
    }
    return url;
  }

  async getContentUrl_(f) {
    const file = await this.getFile_(f.collection, f.file);
    return this.sendRequest_(null, 'v2/sync/getUrl', {
      'token': this.vars_.token,
      'file': file.file,
      'set': file.set,
      'thumb': f.isThumb ? '1' : '0',
    })
    .then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.parts.url;
    });
  }

  /*
   */
  async makeParams_(obj) {
    return Promise.all([
      sodium.randombytes_buf(24),
      sodiumSecretKey(this.vars_.sk),
      sodiumPublicKey(this.vars_.serverPK),
    ])
    .then(async v => {
      const m = await sodium.crypto_box(JSON.stringify(obj), ...v);
      const out = new Uint8Array(v[0].byteLength + m.byteLength);
      out.set(v[0]);
      out.set(m, v[0].byteLength);
      return out;
    })
    .then(v => self.base64StdEncode(v));
  }

  /*
   */
  async decodeKeyBundle_(password, bundle) {
    const bytes = base64DecodeToBytes(bundle);
    if (bytes.length !== 37 && bytes.length !== 125) {
      throw new Error('bundle is too short');
    }
    // Check header.
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== 'SPK') {
      throw new Error('invalid bundle header');
    }
    // Check version
    if (bytes[3] !== 1) {
      throw new Error('invalid bundle version');
    }
    // Check type
    if (bytes[4] !== 0 && bytes[4] !== 2) {
      throw new Error('unexpected bundle type');
    }
    const pk = new Uint8Array(bytes.slice(5, 37));

    if (bytes[4] !== 0) {
      return {pk}; // secret key not in bundle.
    }
    const esk = new Uint8Array(bytes.slice(37, -40));
    const salt = new Uint8Array(bytes.slice(-40, -24));
    const nonce = new Uint8Array(bytes.slice(-24));

    const key = await this.passwordForEncryption_(salt, password);
    const sk = await sodium.crypto_secretbox_open(esk, nonce, key);
    return {pk, sk};
  }

  /*
   */
  async decryptHeader_(encHeader, albumId) {
    const bytes = base64DecodeToBytes(encHeader);
    if (String.fromCharCode(bytes[0], bytes[1]) !== 'SP') {
      throw new Error('invalid header');
    }
    if (bytes[2] !== 1) {
      throw new Error('unexpected header version');
    }
    //const fileId = bytes.slice(3, 35);
    let size = 0;
    for (let i = 35; i < 39; i++) {
      size = (size << 8) + bytes[i];
    }
    let pk = this.vars_.pk;
    let sk = this.vars_.sk;
    if (albumId !== '') {
      pk = this.db_.albums[albumId].pk;
      sk = this.decryptAlbumSK_(albumId);
    }
    const hdr = await Promise.all([sodiumPublicKey(pk),sodiumSecretKey(sk)])
      .then(v => sodium.crypto_box_seal_open(new Uint8Array(bytes.slice(39, 39+size)), ...v));
    //const version = hdr[0];
    const chunkSize = hdr[1]<<2 | hdr[2]<<16 | hdr[3]<<8 | hdr[4];
    if (chunkSize < 0 || chunkSize > 10485760) {
      throw new Error('invalid chunk size');
    }
    const dataSize = hdr[5]<<56 | hdr[6]<<48 | hdr[7]<<40 | hdr[8]<<32 | hdr[9]<<24 | hdr[10]<<16 | hdr[11]<<8 | hdr[12];
    if (dataSize < 0) {
      throw new Error('invalid data size');
    }
    const symKey = new Uint8Array(hdr.slice(13, 45));
    const fileType = hdr[45];
    const fnSize = hdr[46]<<24 | hdr[47]<<16 | hdr[48]<<8 | hdr[49];
    if (fnSize < 0 || fnSize+50 > hdr.length) {
      throw new Error('invalid filename size');
    }
    const fn = self.bytesToString(hdr.slice(50, 50+fnSize));
    const dur = hdr[50+fnSize]<<24 | hdr[51+fnSize]<<16 | hdr[52+fnSize]<<8 | hdr[53+fnSize];
    if (dur < 0) {
      throw new Error('invalid duration');
    }

    const header = {
        chunkSize: chunkSize,
        dataSize: dataSize,
        encKey: await this.encrypt_(symKey),
        fileType: fileType,
        encFileName: await this.encrypt_(self.bytesFromString(fn.replace(/^ */, ''))),
        duration: dur,
        headerSize: bytes.length,
    };
    return header;
  }

  async reEncryptHeader_(encHeader, pk, sk, toPK) {
    const bytes = base64DecodeToBytes(encHeader);
    if (String.fromCharCode(bytes[0], bytes[1]) !== 'SP') {
      throw new Error('invalid header');
    }
    if (bytes[2] !== 1) {
      throw new Error('unexpected header version');
    }
    let size = 0;
    for (let i = 35; i < 39; i++) {
      size = (size << 8) + bytes[i];
    }
    const hdr = await sodium.crypto_box_seal_open(new Uint8Array(bytes.slice(39, 39+size)), pk, sk);
    const newEncHeader = await sodium.crypto_box_seal(hdr, toPK);
    if (newEncHeader.byteLength !== size) {
      console.error(`SW reEncryptHeader_ ${newEncHeader.byteLength} !== ${size}`);
      throw new Error('Re-encrypted header has unexpected size');
    }
    bytes.set(newEncHeader, 39);
    return self.base64RawUrlEncode(bytes);
  }

  async makeMetadata_(pk, name) {
    const encoded = self.bytesFromString(name);
    const md = [ 1 ];
    md.push(...self.bigEndian(encoded.byteLength, 4));
    md.push(...encoded);
    const enc = await sodium.crypto_box_seal(new Uint8Array(md), pk);
    return self.base64StdEncode(enc);
  }

  async renameCollection(clientId, collection, name) {
    const pk = await sodiumPublicKey(this.db_.albums[collection].pk);
    const params = {
      albumId: collection,
      metadata: await this.makeMetadata_(pk, name),
    };
    return this.sendRequest_(clientId, 'v2/sync/renameAlbum', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  makePermissions(perms) {
    return '1' + (perms.canAdd ? '1' : '0') + (perms.canShare ? '1' : '0') + (perms.canCopy ? '1' : '0');
  }

  async shareCollection(clientId, collection, perms, members) {
    members.push(this.vars_.userId);
    const album = {
      albumId: collection,
      isShared: '1',
      permissions: this.makePermissions(perms),
      members: members.join(','),
    };
    const sk = (await this.decryptAlbumSK_(collection)).getBuffer();
    const sharingKeys = {};
    for (let i = 0; i < members.length; i++) {
      if (members[i] === this.vars_.userId) {
        continue;
      }
      const pk = await sodiumPublicKey(base64DecodeToBytes(this.db_.contacts[''+members[i]].publicKey));
      const enc = await sodium.crypto_box_seal(sk, pk);
      sharingKeys[''+members[i]] = self.base64StdEncode(enc);
    }
    const params = {
      album: JSON.stringify(album),
      sharingKeys: JSON.stringify(sharingKeys),
    };
    return this.sendRequest_(clientId, 'v2/sync/share', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async unshareCollection(clientId, collection) {
    const params = {
      albumId: collection,
    };
    return this.sendRequest_(clientId, 'v2/sync/unshareAlbum', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async removeMembers(clientId, collection, members) {
    const album = {
      albumId: collection,
    };
    let p = [];
    for (let i = 0; i < members.length; i++) {
      const params = {
        album: JSON.stringify(album),
        memberUserId: members[i],
      };
      p.push(this.sendRequest_(clientId, 'v2/sync/removeAlbumMember', {
        'token': this.vars_.token,
        'params': await this.makeParams_(params),
      }).then(resp => {
        if (resp.status !== 'ok') {
          throw resp.status;
        }
        return resp.status;
      }));
    }
    return Promise.all(p);
  }

  async updatePermissions(clientId, collection, perms) {
    const album = {
      albumId: collection,
      permissions: this.makePermissions(perms),
    };
    const params = {
      album: JSON.stringify(album),
    };
    return this.sendRequest_(clientId, 'v2/sync/editPerms', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async leaveCollection(clientId, collection) {
    const params = {
      albumId: collection,
    };
    return this.sendRequest_(clientId, 'v2/sync/leaveAlbum', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async createCollection(clientId, name) {
    const kp = await sodium.crypto_box_keypair();
    const sk = await sodium.crypto_box_secretkey(kp);
    const pk = await sodium.crypto_box_publickey(kp);
    const encSK = await sodium.crypto_box_seal(sk.getBuffer(), await sodiumPublicKey(this.vars_.pk));

    const params = {
      albumId: self.base64RawUrlEncode(await sodium.randombytes_buf(32)),
      dateCreated: ''+Date.now(),
      dateModified: ''+Date.now(),
      metadata: await this.makeMetadata_(pk, name),
      encPrivateKey: self.base64StdEncode(encSK),
      publicKey: self.base64StdEncode(pk.getBuffer()),
    };
    return this.sendRequest_(clientId, 'v2/sync/addAlbum', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(async resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      const obj = {
        'albumId': params.albumId,
        'pk': pk.getBuffer(),
        'encSK': params.encPrivateKey,
        'encName': await this.encrypt_(self.bytesFromString(name)),
        'cover': '',
        'members': '',
        'isOwner': true,
        'isShared': false,
        'permissions': '',
        'dateModified': params.dateModified,
        'dateCreated': params.dateCreated,
      };
      this.db_.albums[obj.albumId] = obj;
      await store.set('albums', this.db_.albums);
      return params.albumId;
    });
  }

  async deleteCollection(clientId, collection) {
    const prefix = `files/${collection}/`;
    const files = (await store.keys()).filter(k => k.startsWith(prefix)).map(k => k.substring(prefix.length));
    if (files.length > 0) {
      await this.moveFiles(clientId, collection, 'trash', files, true);
    }

    const params = {
      albumId: collection,
    };
    return this.sendRequest_(clientId, 'v2/sync/deleteAlbum', {
      'token': this.vars_.token,
      'params': await this.makeParams_(params),
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return resp.status;
    });
  }

  async generateOTP(clientId) {
    return this.sendRequest_(clientId, 'v2x/config/generateOTP', {
      'token': this.vars_.token,
    }).then(resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      return {key: resp.parts.key, img: resp.parts.img};
    });
  }

  async adminUsers(clientId, changes) {
    const params = {};
    if (changes !== undefined) {
      params.changes = JSON.stringify(changes);
    }
    return this.sendRequest_(clientId, 'v2x/admin/users', {
      token: this.vars_.token,
      params: await this.makeParams_(params),
    }).then(async resp => {
      if (resp.status !== 'ok') {
        throw resp.status;
      }
      const enc = self.base64DecodeToBinary(resp.parts.users);
      return sodium.crypto_box_seal_open(enc, await sodiumPublicKey(this.vars_.pk), await sodiumSecretKey(this.vars_.sk));
    })
    .then(j => JSON.parse(j));
  }

  async onpush(data) {
    if (!data) {
      return;
    }
    const enc = self.base64DecodeToBinary(data);
    const m = await sodium.crypto_box_seal_open(enc, await sodiumPublicKey(this.vars_.pk), await sodiumSecretKey(this.vars_.sk));
    const js = JSON.parse(self.bytesToString(m));
    console.log('SW onpush:', js);
    let album;
    switch (js.type) {
      case 1: // New user registration
        await self.showNotif(_T('new-user-title', js.target), {
          tag: `new-user:${js.target}:${js.id}`,
        });
        break;
      case 2: // New content in album
        await this.getUpdates('');
        album = this.db_.albums[js.target];
        if (album) {
          const name = await this.decryptString_(album.encName);
          await self.showNotif(name, {
            tag: `new-content:${js.target}`,
            body: _T('new-content-body'),
          });
        }
        break;
      case 3: // New member in album
        await this.getUpdates('');
        album = this.db_.albums[js.target];
        const name = album ? await this.decryptString_(album.encName) : _T('collection');
        const members = js.data.members;
        if (members && members.includes(this.vars_.userId)) {
          await self.showNotif(name, {
            tag: `new-collection:${js.target}`,
            body: _T('new-collection-body'),
          });
        } else if (members && members.length) {
          await self.showNotif(name, {
            tag: `new-member:${js.target}`,
            body: _T('new-members-body'),
          });
        }
        break;
      case 4: // Test notification
        await self.showNotif(_T('push-notifications-title'), {
          tag: `test-notification:${js.id}`,
          body: _T('push-notifications-body'),
        });
        break;
      case 5: // Remote MFA
        if (js.data.expires > Date.now()) {
          let tag = `remote-mfa:${js.data.session}`;
          await self.showNotif(_T('remote-mfa-title'), {
            tag: tag,
            body: _T('remote-mfa-body'),
            actions: [
              {
                action: 'approve',
                title: _T('approve'),
              },
              {
                action: 'deny',
                title: _T('deny'),
              },
            ],
            requireInteraction: true,
            vibrate: [100,50,100],
          });
          setTimeout(() => {
            self.registration.getNotifications({tag}).then(nn => nn.map(n => n.close()));
          }, 30000);
        } else {
          console.log('SW Remote MFA expired');
        }
        break;
    }
  }

  async approveRemoteMFA(session) {
    return this.sendRequest_('', 'v2x/mfa/approve', {
      token: this.vars_.token,
      params: await this.makeParams_({session}),
    });
  }

  /*
   */
  async sendRequest_(clientId, endpoint, data) {
    //console.log('SW', this.vars_.server + endpoint);
    let enc = [];
    for (let n in data) {
      if (!data.hasOwnProperty(n)) {
        continue;
      }
      enc.push(encodeURIComponent(n) + '=' + encodeURIComponent(data[n]));
    }
    return fetch(this.vars_.server + endpoint, {
      method: 'POST',
      mode: SAMEORIGIN ? 'same-origin' : 'cors',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-c2FmZQ-capabilities': (self.capabilities||[]).join(','),
      },
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      body: enc.join('&'),
    })
    .catch(err => {
      if (err instanceof TypeError) {
        throw new Error(_T('network-error'));
      }
      throw err;
    })
    .then(resp => {
      if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}`);
      }
      return resp.json();
    })
    .then(resp => {
      if (resp.infos.length > 0) {
        self.sendMessage(clientId, {type: 'info', msg: resp.infos.join('\n')});
      }
      if (resp.errors.length > 0) {
        self.sendMessage(clientId, {type: 'error', msg: resp.errors.join('\n')});
      }
      if (!data.mfa && resp.status === 'nok' && resp.parts.mfa) {
        console.log(`SW got request for MFA on ${endpoint}`);
        return self.sendRPC(clientId, 'getMFA', resp.parts.mfa)
          .then(res => {
            data.mfa = JSON.stringify(res || {});
            return this.sendRequest_(clientId, endpoint, data);
          });
      }
      if (resp.parts && resp.parts.logout === "1") {
        this.vars_ = {};
        this.resetDB_();
        store.clear();
        sendLoggedOut();
      }
      return resp;
    });
  }

  async setCachePreference(clientId, v) {
    console.log('SW setCachePreference', v);
    if (!['no-store','private','encrypted'].includes(v)) {
      throw new Error('invalid cache option');
    }
    this.vars_.cachePref = v;
    if (v !== 'encrypted') {
      await this.deleteCache_();
    }
    return this.saveVars_()
      .then(v => {
        this.fetchMissingThumbnails_()
        .catch(err => {
          console.log('Error fetching thumbnails', err);
        });
        return v;
      });
  }

  async cachePreference() {
    return this.vars_.cachePref || 'encrypted';
  }

  async ping() {
    console.log('SW ping');
    return true;
  }

  async openCache_() {
    if (!this.cache_) {
      this.cache_ = await self.caches.open('local');
    }
    return this.cache_;
  }

  async deleteCache_() {
    await self.caches.delete('local');
    this.cache_ = null;
  }

  async fetchMissingThumbnails_() {
    if (this.fetchingMissingThumbnails) {
      return;
    }
    this.fetchingMissingThumbnails = true;
    return this.fetchMissingThumbnailsNow_()
      .finally(() => {
        this.fetchingMissingThumbnails = false;
      });
  }

  async fetchMissingThumbnailsNow_() {
    await this.openCache_();
    if (this.vars_.cachePref && this.vars_.cachePref !== 'encrypted') {
      return;
    }
    const set = {};
    (await store.keys()).filter(k => k.startsWith('files/')).map(k => {
      const p = k.lastIndexOf('/');
      const c = k.substring(6, p);
      const f = k.substring(p+1);
      set[f] = c;
    });
    (await this.cache_.keys()).forEach(req => {
      const url = req.url;
      const off = url.lastIndexOf('local/tn/');
      if (off !== -1) {
        const key = url.substring(off+9);
        if (Object.hasOwn(set, key)) {
          delete set[key];
        } else {
          this.cache_.delete(req);
        }
      }
    });
    const total = Object.keys(set).length;
    if (total === 0) {
      return;
    }
    let count = 0;
    for (const [file, collection] of Object.entries(set)) {
      if (++count % 10 === 0) {
        console.log(`Downloading thumbnails: ${count}/${total}`);
      }
      await this.fetchThumbnail_(file, collection);
      self.sendMessage('', {type: 'keep-alive'});
    }
    console.log(`Downloaded thumbnails: ${count}/${total}`);
  }

  async fetchThumbnail_(name, collection) {
    if (this.vars_.cachePref && this.vars_.cachePref !== 'encrypted') {
      throw new Error('caching disabled');
    }
    const cacheKey = `local/tn/${name}`;
    const cached = await this.cache_.keys(cacheKey);
    if (cached.length) {
      return;
    }
    const file = await this.getFile_(collection, name);
    if (!file) {
      return;
    }
    if (this.saveBandwidth_()) {
      return;
    }
    const startOffset = file.headers[1].headerSize;
    const strategy = new ByteLengthQueuingStrategy({
      highWaterMark: 5*(file.headers[1].chunkSize+40),
    });
    const symKey = await sodiumKey(this.decrypt_(file.headers[1].encKey));
    const chunkSize = file.headers[1].chunkSize;

    return this.getContentUrl_({file:name,collection:collection,isThumb:true})
    .then(url => fetch(url, {
      method: 'GET',
      headers: {
        range: `bytes=${startOffset}-`,
      },
      mode: SAMEORIGIN ? 'same-origin' : 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    }))
    .then(resp => {
      if (!resp.ok) {
        throw new Error(`Status: ${resp.status}`);
      }
      return this.cache_.put(cacheKey, new Response(resp.body, {status:200, statusText:'OK', headers:resp.headers}));
    });
  }

  async manageFullSizeCache_(name) {
    if (!this.cacheLRU_) {
      try {
        const r = await store.get('cacheLRU');
        if (r) {
          this.cacheLRU_ = JSON.parse(r);
        }
      } catch(err) {}
      if (!this.cacheLRU_) {
        this.cacheLRU_ = {n:[]};
        (await this.cache_.keys()).forEach(req => {
          const url = req.url;
          const off = url.lastIndexOf('local/fs/');
          if (off !== -1) {
            this.cacheLRU_.n.push(url.substring(off+9));
          }
        });
      }
    }
    const off = this.cacheLRU_.n.indexOf(name);
    if (off !== -1) {
      this.cacheLRU_.n.splice(off, 1);
    }
    this.cacheLRU_.n.push(name);

    const full = async () => {
      if (this.cacheLRU_.n.length === 0) return false;
      if (this.cacheLRU_.n.length > 1000) return true;
      if ('estimate' in navigator.storage) {
        const est = await navigator.storage.estimate();
        if (est.usage > est.quota / 2) {
          return true;
        }
      }
      return false;
    };

    while(await full()) {
      let it = this.cacheLRU_.n.shift();
      await this.cache_.delete(`local/fs/${it}`);
    }
    return store.set('cacheLRU', JSON.stringify(this.cacheLRU_));
  }

  saveBandwidth_() {
    if ('connection' in navigator) {
      const c = navigator.connection;
      if (c.saveData) {
        console.log('SW data saving is enabled on device');
        return true;
      }
    }
    return false;
  }

  /*
   */
  async handleFetchEvent(event) {
    const url = new URL(event.request.url);
    if (url.pathname.endsWith('/jsapi')) {
      const p = new Promise(resolve => {
        const params = url.searchParams;
        const func = params.get('func');
        let args = [];
        try {
          args = JSON.parse(self.base64DecodeToString(params.get('args')));
        } catch (e) {
          console.log('SW invalid args', params.get('args'));
        }
        const allowedMethods = [
          'isLoggedIn',
          'quota',
          'keyBackupEnabled',
          'logout',
          'getContact',
          'getContacts',
          'getFiles',
          'getCollections',
          'getCover',
          'getUpdates',
          'moveFiles',
          'emptyTrash',
          'deleteFiles',
          'changeCover',
          'renameCollection',
          'shareCollection',
          'unshareCollection',
          'removeMembers',
          'updatePermissions',
          'leaveCollection',
          'createCollection',
          'deleteCollection',
          'setCachePreference',
          'cachePreference',
          'enableNotifications',
          'mfaStatus',
          'ping',
        ];
        if (allowedMethods.includes(func)) {
          this[func](null, ...args)
          .then(result => {
            let headers = {};
            if (func === 'logout') {
              headers['Clear-Site-Data'] = '*';
            }
            resolve(new Response(JSON.stringify({'resolve': result}), {'status': 200, 'statusText': 'OK', 'headers': headers}));
          })
          .catch(error => {
            console.log(`SW ${func} failed`, error);
            resolve(new Response(JSON.stringify({'reject': error.toString()}), {'status': 200, 'statusText': 'OK'}));
          });
        } else {
          console.log('SW method not allowed', func);
          resolve(new Response('', {'status': 503, 'statusText': 'method not allowed'}));
        }
      });
      return p;
    }

    if (event.request.url.indexOf('/jsdecrypt/') === -1) {
      return new Response('No such endpoint', {'status': 404, 'statusText': 'Not found'});
    }

    if (!this.cache_) {
      await this.openCache_();
    }

    const p = new Promise(async (resolve, reject) => {
      const ext = url.pathname.replace(/^.*(\.[^.]+)$/, '$1').toLowerCase();
      const params = url.searchParams;
      const f = {
        collection: params.get('collection'),
        file: params.get('file'),
        isThumb: params.get('isThumb'),
      };
      const file = await this.getFile_(f.collection, f.file);
      if (!file) {
        return resolve(new Response('Not found', {'status': 404, 'statusText': 'Not found'}));
      }
      let startOffset = file.headers[0].headerSize;
      let chunkNum = 0;
      let chunkOffset = 0;
      let reqOffset = 0;
      let haveRange = false;
      if (event.request.headers.has('range')) {
        haveRange = true;
        const range = event.request.headers.get('range');
        const re = /^bytes=([0-9]+)-$/;
        const m = re.exec(range);
        reqOffset = m ? parseInt(m[1]) : 0;
        if (reqOffset > 0) {
          chunkNum = Math.floor(reqOffset / file.headers[0].chunkSize);
          chunkOffset = reqOffset % file.headers[0].chunkSize;
          startOffset += chunkNum * (file.headers[0].chunkSize+40);
        }
      }

      let ctype = 'application/octet-stream';
      switch (ext) {
        case '.jpg': case '.jpeg':
          ctype = 'image/jpeg'; break;
        case '.png':
          ctype = 'image/png'; break;
        case '.gif':
          ctype = 'image/gif'; break;
        case '.webp':
          ctype = 'image/webp'; break;
        case '.avif':
          ctype = 'image/avif'; break;
        case '.mp4':
          ctype = 'video/mp4'; break;
        case '.avi':
          ctype = 'video/avi'; break;
        case '.wmv':
          ctype = 'video/x-ms-wmv'; break;
        case '.3gp':
          ctype = 'video/3gpp'; break;
        case '.m1v': case '.m2v': case '.mp2': case '.mpg': case '.mpeg':
          ctype = 'video/mpeg'; break;
        case '.qt': case '.mov': case '.moov':
          ctype = 'video/quicktime'; break;
        case '.mjpg':
          ctype = 'video/x-motion-jpeg'; break;
        case '.pdf':
          ctype = 'application/pdf'; break;
        case '.txt':
          ctype = 'text/plain'; break;
        case '.gz': case '.tgz':
          ctype = 'application/gzip'; break;
        default:
          console.log(`SW Using default content-type for ${ext}`); break;
      }

      const strategy = new ByteLengthQueuingStrategy({
        highWaterMark: 5*(file.headers[0].chunkSize+40),
      });
      const fileSize = file.headers[f.isThumb?1:0].dataSize;
      if (fileSize <= 0) {
        resolve(new Response(new Blob(), {'status': 200, 'statusText': 'OK'}));
        return;
      }
      if (reqOffset > fileSize) {
        resolve(new Response(new Blob(),
          {'status': 416, 'statusText': 'Range Not Satisfiable'}));
        return;
      }
      const symKey = await sodiumKey(this.decrypt_(file.headers[f.isThumb?1:0].encKey));
      const chunkSize = file.headers[f.isThumb?1:0].chunkSize;

      const cachePref = await this.cachePreference();
      const useCache = cachePref === 'encrypted';
      const cacheKey = `local/${f.isThumb?'tn':'fs'}/${f.file}`;

      let skipChunks = 0;
      let addToCache = false;
      let resp;
      if (useCache) {
        resp = await this.cache_.match(cacheKey)
          .then(v => {
            if (v && !f.isThumb) {
              this.manageFullSizeCache_(f.file)
              .catch(err => console.log('SW cache error', err));
            }
            return v;
          });
        if (resp) {
          skipChunks = chunkNum;
        }
      }
      if (!resp) {
        addToCache = useCache && reqOffset === 0;
        resp = await this.getContentUrl_(f)
          .then(url => fetch(url, {
              method: 'GET',
              headers: {
                range: `bytes=${startOffset}-`,
              },
              mode: SAMEORIGIN ? 'same-origin' : 'cors',
              credentials: 'omit',
              redirect: 'error',
              referrerPolicy: 'no-referrer',
            }))
          .catch(() => new Response('', {'status': 502, 'statusText': 'network error'}));
      }
      if (!resp.ok) {
        console.log('SW fetch resp', resp.status);
        return resolve(new Response('', {'status': 502, 'statusText': 'network error'}));
      }
      let onAbort;
      let body = resp.body;
      if (addToCache) {
        const [rs1, rs2] = body.tee();
        body = rs1;
        const stream = new CacheStream(rs2);
        onAbort = stream.cancel.bind(stream);
        this.cache_.put(cacheKey, new Response(new ReadableStream(stream), {status:200, statusText:'OK', headers:resp.headers}))
        .then(() => {
          if (!f.isThumb) {
            this.manageFullSizeCache_(f.file)
            .catch(err => console.log('SW cache error', err));
          }
        })
        .catch(err => {
          console.log(`SW ${cacheKey} not cached`);
        });
      }
      const rs = new ReadableStream(new Decrypter(body.getReader(), symKey, chunkSize, chunkNum, chunkOffset, skipChunks, onAbort), strategy);
      let h = {
        'accept-ranges': 'bytes',
        'cache-control': 'no-store, immutable',
        'content-type': ctype,
      };
      if (cachePref === 'private') {
        h['cache-control'] = 'private, max-age=3600';
      }
      if (haveRange) {
        h['content-range'] = `bytes ${reqOffset}-${fileSize-1}/${fileSize}`;
      } else {
        h['content-length'] = fileSize;
      }
      resolve(new Response(rs, {
        'status': haveRange ? 206 : 200,
        'statusText': haveRange ? 'Partial Content' : 'OK',
        'headers': h,
      }));
    });
    return p;
  }

  async cancelUpload(clientId) {
    this.cancelUpload_.cancel = true;
    this.uploadData_.forEach(b => {
      b.err = 'canceled';
    });
  }

  async upload(clientId, collection, files) {
    if (files.length === 0) {
      return;
    }
    if (this.cancelUpload_ === undefined) {
      this.cancelUpload_ = { cancel: false };
    }
    if (this.uploadData_?.length > 0 && this.cancelUpload_.cancel) {
      return Promise.reject('canceled');
    }
    this.cancelUpload_.cancel = false;

    if (this.streamingUploadWorks_ === undefined) {
      try {
        const ok = await this.testUploadStream_();
        this.streamingUploadWorks_ = ok === true;
      } catch (e) {
        this.streamingUploadWorks_ = false;
      }
    }
    console.log(this.streamingUploadWorks_ ? 'SW streaming upload is supported by browser' : 'SW streaming upload is NOT supported by browser');

    for (let i = 0; i < files.length; i++) {
      files[i].uploadedBytes = 0;
      files[i].tn = base64DecodeToBytes(files[i].thumbnail.split(',')[1]);
      files[i].tnSize = files[i].tn.byteLength;
      delete files[i].thumbnail;
    }

    if (this.uploadData_) {
      return new Promise((resolve, reject) => {
        this.uploadData_.push({collection, files, resolve, reject});
      });
    }
    this.uploadData_ = [];

    const p = new Promise(async (resolve, reject) => {
      this.uploadData_.push({collection, files, resolve, reject});

      for (let b = 0; b < this.uploadData_?.length; b++) {
        let batch = this.uploadData_[b];
        for (let i = 0; i < batch.files.length && !batch.err; i++) {
          try {
            await this.uploadFile_(clientId, batch.collection, batch.files[i]);
            delete batch.files[i].tn;
          } catch (err) {
            const name = batch.files[i].name || batch.files[i].file.name;
            console.log(`SW Upload of ${name} failed`, err);
            batch.err = err;
          }
        }
        if (batch.err) {
          batch.reject(batch.err);
        } else {
          batch.resolve();
        }
        batch.done = true;
      }
    });

    const notify = () => {
      if (!this.uploadData_) return;
      const state = {
        numFiles: 0,
        numBytes: 0,
        numFilesDone: 0,
        numBytesDone: 0,
      };
      let allDone = true;
      this.uploadData_.forEach(b => {
        if (!b.done && !b.err) allDone = false;
        b.files.forEach(f => {
          state.numFiles += 1;
          state.numBytes += f.file.size;
          state.numBytes += f.tnSize;
          if (f.done) {
            state.numFilesDone += 1;
            state.numBytesDone += f.file.size;
            state.numBytesDone += f.tnSize;
          } else {
            state.numBytesDone += f.uploadedBytes;
          }
        });
      });
      state.done = allDone;
      sendUploadProgress(state);
      if (allDone) {
        this.uploadData_ = null;
      } else {
        self.setTimeout(notify, 500);
      }
    };
    notify();

    return p;
  }

  async uploadFile_(clientId, collection, file) {
    let pk;
    if (collection === 'gallery') {
      pk = await sodiumPublicKey(this.vars_.pk);
    } else {
      if (!(collection in this.db_.albums)) {
        throw new Error(`invalid album ${collection}`);
      }
      pk = await sodiumPublicKey(this.db_.albums[collection].pk);
    }
    const [hdr, hdrBin, hdrBase64] = await this.makeHeaders_(pk, file);

    const boundary = Array.from(self.crypto.getRandomValues(new Uint8Array(32))).map(v => ('0'+v.toString(16)).slice(-2)).join('');
    const rs = new ReadableStream(new UploadStream(boundary, hdr, hdrBin, hdrBase64, collection, file, this.vars_.token, this.cancelUpload_));

    if (this.cancelUpload_.cancel) {
      throw new Error('canceled');
    }

    let body = rs;
    if (!this.streamingUploadWorks_) {
      // Streaming upload is supported in chrome 105+.
      // https://bugs.chromium.org/p/chromium/issues/detail?id=688906
      body = await self.stream2blob(rs);
    }

    return fetch(this.vars_.server + 'v2/sync/upload', {
      method: 'POST',
      mode: SAMEORIGIN ? 'same-origin' : 'cors',
      headers: {
        'Content-Type': 'multipart/form-data; boundary='+boundary,
      },
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
      body: body,
      duplex: 'half',
    })
    .then(async resp => {
      if (!resp.ok) {
        if (!resp.body) {
          throw new Error(`${resp.status} ${resp.statusText}`);
        }
        const blob = await self.stream2blob(resp.body);
        const body = await blob.text();
        throw body;
      }
      file.done = true;
      return 'ok';
    })
    .catch(err => {
      if (this.cancelUpload_.cancel) {
        return Promise.reject('canceled');
      }
      return Promise.reject(err);
    });
  }

  async testUploadStream_() {
    // https://developer.chrome.com/articles/fetch-streaming-requests/#feature-detection
    const supportsRequestStreams = (() => {
      let duplexAccessed = false;

      const hasContentType = new Request('', {
        body: new ReadableStream(),
        method: 'POST',
        get duplex() {
          duplexAccessed = true;
          return 'half';
        },
      }).headers.has('Content-Type');

      return duplexAccessed && !hasContentType;
    })();
    return supportsRequestStreams;
  }

  async makeHeaders_(pk, file) {
    const fileId = self.crypto.getRandomValues(new Uint8Array(32));
    let fileType = 1;
    if (file.file.type.startsWith('image/')) fileType = 2;
    if (file.file.type.startsWith('video/')) fileType = 3;

    const headers = [{
      version: 1,
      chunkSize: 1 << 20,
      dataSize: file.file.size,
      symmetricKey: self.crypto.getRandomValues(new Uint8Array(32)),
      fileType: fileType,
      fileName: file.name || file.file.name,
      duration: Math.floor(file.duration),
    }, {
      version: 1,
      chunkSize: 1 << 20,
      dataSize: file.tnSize,
      symmetricKey: self.crypto.getRandomValues(new Uint8Array(32)),
      fileType: fileType,
      fileName: file.name || file.file.name,
      duration: Math.floor(file.duration),
    }];

    const binHeaders = [];
    const b64Headers = [];
    for (let i = 0; i < 2; i++) {
      const encFileName = self.bytesFromString(headers[i].fileName);
      let h = [];
      h.push(headers[i].version);
      h.push(...self.bigEndian(headers[i].chunkSize, 4));
      h.push(...self.bigEndian(headers[i].dataSize, 8));
      h.push(...headers[i].symmetricKey);
      h.push(headers[i].fileType);
      h.push(...self.bigEndian(encFileName.byteLength, 4));
      h.push(...encFileName);
      h.push(...self.bigEndian(headers[i].duration, 4));
      const encHeader = await sodium.crypto_box_seal(new Uint8Array(h), pk);
      let out = [];
      out.push(0x53, 0x50, 0x1); // 'S', 'P', 1
      out.push(...fileId);
      out.push(...self.bigEndian(encHeader.byteLength, 4));
      out.push(...encHeader);
      binHeaders.push(new Uint8Array(out));
      b64Headers.push(self.base64RawUrlEncode(out));
    }
    return [headers, binHeaders, b64Headers.join('*')];
  }
}

/*
 * A Transformer to decrypt a stream.
 */
class Decrypter {
  constructor(reader, symKey, chunkSize, n, offset, skipChunks, onAbort) {
    this.reader_ = reader;
    this.symmetricKey_ = symKey;
    this.chunkSize_ = chunkSize;
    this.encChunkSize_ = chunkSize + 40;
    this.buf_ = new Uint8Array(0);
    this.n_ = n;
    this.offset_ = offset;
    this.skipChunks_ = skipChunks;
    this.onAbort_ = onAbort;
    this.canceled_ = false;
  }

  async start(/*controller*/) {
    this.symmetricKey_ = await sodiumKey(this.symmetricKey_);
  }

  async pull(controller) {
    while (this.buf_.byteLength < this.encChunkSize_) {
      let {done, value} = await this.reader_.read();
      if (this.canceled_) {
        controller.close();
        return;
      }
      if (done) {
        if (this.skipChunks_ > 0) {
          controller.close();
          return;
        }
        return this.decryptChunk(controller).then(() => {
          controller.close();
        });
      }
      const tmp = new Uint8Array(this.buf_.byteLength + value.byteLength);
      tmp.set(this.buf_);
      tmp.set(value, this.buf_.byteLength);
      this.buf_ = tmp;

      while (this.buf_.byteLength >= this.encChunkSize_ && this.skipChunks_ > 0) {
        this.buf_ = this.buf_.slice(this.encChunkSize_);
        this.skipChunks_--;
      }
    }
    while (this.buf_.byteLength >= this.encChunkSize_) {
      if (this.canceled_) return;
      await this.decryptChunk(controller);
    }
  }

  cancel(/*reason*/) {
    this.canceled_ = true;
    this.reader_.cancel();
    if (this.onAbort_) {
      this.onAbort_();
    }
  }

  async decryptChunk(controller) {
    if (this.buf_.byteLength === 0) {
      return;
    }
    try {
      this.n_++;
      const nonce = Uint8Array.from(this.buf_.slice(0, 24));
      const end = this.buf_.byteLength >= this.encChunkSize_ ? this.encChunkSize_ : this.buf_.byteLength;
      const enc = this.buf_.slice(24, end);
      const ck = await sodium.crypto_kdf_derive_from_key(32, this.n_, '__data__', this.symmetricKey_);
      let dec = new Uint8Array(await sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(enc, nonce, ck, ''));
      this.buf_ = this.buf_.slice(end);
      if (this.offset_ > 0) {
        dec = dec.slice(this.offset_);
        this.offset_ = 0;
      }
      controller.enqueue(dec);
    } catch (e) {
      controller.error(new Error('decryption error'));
      console.error('SW decryptChunk', e);
      this.cancel();
    }
  }
}

class CacheStream {
  constructor(rs) {
    this.reader_ = rs.getReader();
    this.canceled_ = false;
  }
  async pull(controller) {
    if (this.canceled_) {
      this.reader_.cancel();
      controller.error(new Error('canceled stream'));
      return;
    }
    const {value, done} = await this.reader_.read();
    if (value) {
      controller.enqueue(value);
    }
    if (done) {
      controller.close();
    }
  }
  cancel() {
    this.canceled_ = true;
  }
}

class UploadStream {
  constructor(boundary, hdr, hdrBin, hdrBase64, collection, file, token, cancel) {
    this.boundary_ = boundary;
    this.hdr_ = hdr;
    this.hdrBin_ = hdrBin;
    this.hdrBase64_ = hdrBase64;
    this.set_ = collection === 'gallery' ? 0 : 2;
    this.albumId_ = collection === 'gallery' ? '' : collection;
    this.file_ = file;
    this.token_ = token;
    this.cancel_ = cancel;
    this.filename_ = self.base64RawUrlEncode(self.crypto.getRandomValues(new Uint8Array(32))) + '.sp';
  }

  async start(controller) {
    const fields = {
      headers: this.hdrBase64_,
      set: this.set_,
      albumId: this.albumId_,
      dateCreated: '' + (this.file_.dateCreated || this.file_.file.lastModified),
      dateModified: '' + (this.file_.dateModified || this.file_.file.lastModified),
      version: '1',
      token: this.token_,
    };
    let s = '';
    for (let k in fields) {
      if (!fields.hasOwnProperty(k)) {
        continue;
      }
      s += `--${this.boundary_}\r\n` +
        `Content-Disposition: form-data; name="${k}"\r\n` +
        `\r\n` +
        `${fields[k]}\r\n`;
    }
    controller.enqueue(self.bytesFromBinary(s));

    this.queue_ = [
      {
        name: 'file',
        key: await sodiumKey(this.hdr_[0].symmetricKey),
        hdrBin: this.hdrBin_[0],
        chunkSize: this.hdr_[0].chunkSize,
        reader: this.file_.file.stream().getReader(),
        n: 0,
      },
      {
        name: 'thumb',
        key: await sodiumKey(this.hdr_[1].symmetricKey),
        hdrBin: this.hdrBin_[1],
        chunkSize: this.hdr_[1].chunkSize,
        reader: (new Blob([this.file_.tn])).stream().getReader(),
        n: 0,
      },
    ];
  }

  checkCanceled() {
    if (this.cancel_.cancel) {
      this.cancel();
    }
    return this.cancel_.cancel;
  }

  async pull(controller) {
    if (this.queue_.length === 0) {
      controller.enqueue(self.bytesFromBinary(`--${this.boundary_}--\r\n`));
      controller.close();
      return;
    }
    if (this.checkCanceled()) return Promise.reject('canceled');

    return new Promise(async (resolve, reject) => {
      const q = this.queue_[0];
      if (q.n === 0) {
        controller.enqueue(self.bytesFromBinary(`--${this.boundary_}\r\n` +
        `Content-Disposition: form-data; name="${q.name}"; filename="${this.filename_}"\r\n` +
        `Content-Type: application/octet-stream\r\n` +
        `\r\n`));
        q.n = 1;
        q.buf = new Uint8Array(0);
        controller.enqueue(q.hdrBin);
      }
      let eof = false;
      while (q.buf.byteLength < q.chunkSize) {
        if (this.checkCanceled()) return reject('canceled');
        let {done, value} = await q.reader.read();
        if (done) {
          eof = true;
          break;
        }
        const tmp = new Uint8Array(q.buf.byteLength + value.byteLength);
        tmp.set(q.buf);
        tmp.set(value, q.buf.byteLength);
        q.buf = tmp;
      }
      while (q.buf.byteLength >= q.chunkSize) {
        if (this.checkCanceled()) return reject('canceled');
        let chunk = q.buf.slice(0, q.chunkSize);
        q.buf = q.buf.slice(q.chunkSize);
        this.file_.uploadedBytes += chunk.byteLength;
        controller.enqueue(await this.encryptChunk_(q.n, chunk, q.key));
        q.n++;
      }
      if (eof) {
        if (this.checkCanceled()) return reject('canceled');
        if (q.buf.byteLength > 0) {
          this.file_.uploadedBytes += q.buf.byteLength;
          controller.enqueue(await this.encryptChunk_(q.n, q.buf, q.key));
        }
        controller.enqueue(self.bytesFromBinary(`\r\n`));
        this.queue_.shift();
      }
      return resolve();
    });
  }

  cancel(/*reason*/) {
    for (let i = 0; i < this.queue_.length; i++) {
      if (this.queue_[i]?.reader?.close) {
        this.queue_[i].reader.close();
      }
    }
    this.queue_ = [];
  }

  async encryptChunk_(n, data, key) {
    const nonce = await sodium.randombytes_buf(24);
    const ck = await sodium.crypto_kdf_derive_from_key(32, n, '__data__', key);
    const enc = await sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(data, nonce, ck, '');
    const out = new Uint8Array(nonce.byteLength + enc.byteLength);
    out.set(nonce, 0);
    out.set(enc, nonce.byteLength);
    return out;
  }
}
