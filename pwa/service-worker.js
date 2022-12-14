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

/* jshint -W079 */
/* jshint -W097 */
'use strict';

self.importScripts('version.js');
console.log(`SW Version ${VERSION}`, DEVEL ? 'DEVEL' : '');

const MANIFEST = [
  'c2fmzq.webmanifest',
  'c2fmzq-client.js',
  'c2.png',
  'c2-bg.png',
  'c2-144x144.png',
  'clear.png',
  'index.html',
  'lang.js',
  'main.js',
  'store.js',
  'style.css',
  'ui.js',
  'version.js',
  'thirdparty/browser-libs.js',
  'thirdparty/filerobot-image-editor.min.js',
  'thirdparty/libs.js',
];

self.importScripts('thirdparty/libs.js');
self.importScripts('lang.js');
self.importScripts('store.js');
self.importScripts('c2fmzq-client.js');

self.store = new Store();
self.initp = null;
self._T = Lang.text;

self.notifs = new Store('notifications');
self.notifs.passphrase = 'notifications';

self.rpcId_ = Math.floor(Math.random() * 1000000000);
self.rpcWait_ = {};

async function initApp(storeKey) {
  const p = new Promise(async (resolve, reject) => {
    if (self.store.passphrase || !storeKey) {
      sendHello();
      return resolve();
    }
    try {
      await store.open(storeKey);
    } catch (err) {
      if (err.message === 'Wrong passphrase') {
        console.log('SW Wrong passphrase');
        sendHello(err.message);
        return resolve();
      }
      return reject(err);
    }
    self.sodium = await self.SodiumPlus.auto();
    const app = new c2FmZQClient({
      pathPrefix: self.location.href.replace(/^(.*\/)[^\/]*/, '$1'),
    });
    await app.init();
    self.app = app;
    console.log('SW app ready');
    sendHello();
    await self.store.release();
    setTimeout(self.checkNotifications.bind(self), 500);
    setTimeout(self.checkPushsubscriptionchanges.bind(self), 500);
    return resolve();
  })
  .finally(() => {
    self.initp = null;
  });
  if (self.initp) {
    console.log('SW initApp called concurrently');
    return self.initp.then(() => p);
  }
  self.initp = p;
  return p;
}

function fixme() {
  self.sendMessage('', {type: 'fixme'});
  setInterval(() => {
    self.sendMessage('', {type: 'fixme'});
  }, 5000);
}

function checkNotifications() {
  if (self.checkingNotifications) {
    setTimeout(self.checkNotifications.bind(self), 500);
    return;
  }
  self.checkingNotifications = true;
  self.notifs.keys()
  .then(keys => keys.filter(k => k.startsWith("notifs/")))
  .then(keys => {
    if (keys.length === 0) {
      return;
    }
    if (!self.app) {
      self.showNotif(_T('notification-encrypted-title', keys.length), {
        tag: 'encrypted',
        body: _T('notification-encrypted-body'),
        requireInteraction: true,
      });
      return;
    }
    self.registration.getNotifications({tag:'encrypted'}).then(nn => nn.forEach(n => n.close()));
    keys.forEach(k => {
      self.notifs.get(k)
        .then(v => self.app.onpush(v))
        .finally(() => self.notifs.del(k));
    });
  })
  .finally(() => {
    self.checkingNotifications = false;
  });
}

function checkPushsubscriptionchanges() {
  if (self.checkingPushsubscriptionchanges) {
    setTimeout(self.checkPushsubscriptionchanges.bind(self), 500);
    return;
  }
  self.checkingPushsubscriptionchanges = true;
  self.notifs.keys()
  .then(keys => keys.filter(k => k.startsWith("pushsubscriptionchange/")))
  .then(keys => {
    if (keys.length === 0 || !self.app) {
      return;
    }
    keys.forEach(k => {
      self.notifs.get(k)
        .then(v => self.app.enableNotifications('', true))
        .then(() => self.notifs.del(k));
    });
  })
  .finally(() => {
    self.checkingPushsubscriptionchanges = false;
  });
}

function bytesFromString(s) {
  return new TextEncoder('utf-8').encode(s);
}

function bytesToString(a) {
  return new TextDecoder('utf-8').decode(a);
}

function bytesFromBinary(bin) {
  let array = [];
  for (let i = 0; i < bin.length; i++) {
    array.push(bin.charCodeAt(i));
  }
  return new Uint8Array(array);
}

function bigEndian(n, size) {
  let a = [];
  while (size-- > 0) {
    a.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array(a);
}

function base64RawUrlEncode(v) {
  return base64StdEncode(v).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64StdEncode(v) {
  if (Array.isArray(v)) {
    v = new Uint8Array(v);
  }
  return base64.fromByteArray(v);
}

function base64DecodeToBinary(s) {
  return String.fromCharCode(...base64DecodeToBytes(s));
}

function base64DecodeToString(s) {
  return self.bytesToString(base64DecodeToBytes(s));
}

function base64DecodeToBytes(v) {
  v = v.replaceAll('-', '+').replaceAll('_', '/');
  while (v.length % 4 !== 0) {
    v += '=';
  }
  return base64.toByteArray(v);
}

async function stream2blob(rs) {
  const reader = rs.getReader();
  const buf = [];
  while (true) {
    let {done, value} = await reader.read();
    if (done) break;
    buf.push(value);
  }
  return new Blob(buf);
}

async function sodiumPublicKey(k) {
  return sodiumKey(k, 'public');
}

async function sodiumSecretKey(k) {
  return sodiumKey(k, 'secret');
}

async function sodiumKey(k, type) {
  k = await Promise.resolve(k);
  if (typeof k === 'object') {
    if (k instanceof X25519SecretKey) return k;
    if (k instanceof X25519PublicKey) return k;
    if (k instanceof CryptographyKey) return k;
    if (k.type === 'Buffer') {
      k = new Uint8Array(k.data);
    } else if (k[0] !== undefined && k[31] !== undefined) {
      const kk = new Array(32);
      for (let i = 0; i < 32; i++) {
        kk[i] = k[i];
      }
      k = kk;
    }
  }
  if (typeof k === 'string' && k.length !== 32) {
    k = base64DecodeToBytes(k);
  }
  if (Array.isArray(k)) {
    k = new Uint8Array(k);
  }
  try {
    switch (type) {
      case 'public': return X25519PublicKey.from(k);
      case 'secret': return X25519SecretKey.from(k);
      default: return CryptographyKey.from(k);
    }
  } catch (e) {
    console.error('SW sodiumKey', k, e);
    return null;
  }
}

function sendHello(err) {
  const key = self.store.passphrase;
  console.log(`SW Sending hello ${VERSION}`);
  let msg = {
    type: 'hello',
    storeKey: key,
    version: VERSION,
  };
  if (err) {
    msg.err = err;
  }
  self.sendMessage('', msg);
}

function sendLoggedOut() {
  console.log('SW Sending logged out');
  self.sendMessage('', {type: 'loggedout'});
}

function sendUploadProgress(p) {
  self.sendMessage('', {type: 'upload-progress', progress: p});
}

async function sendMessage(id, m) {
  const clients = await self.clients.matchAll({type: 'window'});
  if (clients.length === 0) {
    console.log(`SW no clients ${VERSION}`);
    return;
  }
  for (let c of clients) {
    if (id === '' || c.id === id) {
      try {
        c.postMessage(m);
      } catch (err) {
        console.log('SW sendMessage failed', m, err);
      }
    }
  }
}

async function showNotif(title, options) {
  options.badge = './c2.png';
  return self.registration.showNotification(title, options);
}

async function sendRPC(clientId, f, ...args) {
  const id = self.rpcId_++;
  return new Promise((resolve, reject) => {
    self.rpcWait_[id] = {resolve, reject};
    return sendMessage(clientId, {
      type: 'rpc',
      id: id,
      func: f,
      args: args,
    });
  });
}

self.addEventListener('push', event => {
  const data = event.data ? event.data.text() : null;
  event.waitUntil(
    self.notifs.set('notifs/' + new Date().getTime(), data)
    .then(() => self.checkNotifications())
  );
});

self.addEventListener('pushsubscriptionchange', event => {
  console.log('SW pushsubscriptionchange', event);
  event.waitUntil(
    self.notifs.set('pushsubscriptionchange/' + new Date().getTime(), event.oldSubscription.options)
    .then(() => self.checkPushsubscriptionchanges())
  );
});

self.addEventListener('notificationclick', event => {
  const tag = event.notification.tag;
  let jumpTo;
  if (tag.startsWith('new-content:') || tag.startsWith('new-member:') || tag.startsWith('new-collection:')) {
    jumpTo = tag.substring(tag.indexOf(':')+1);
  }
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type: "window"})
    .then(list => {
      if (tag.startsWith('remote-mfa:')) {
        if (event.action && event.action === 'deny') {
          console.log('SW Remove MFA denied');
          return;
        }
        if (!self.app) {
          throw new Error('app is not ready');
        }
        return self.app.approveRemoteMFA(tag.substring(tag.indexOf(':')+1));
      }

      let url = self.registration.scope;
      if (jumpTo) {
        url += '#' + btoa(JSON.stringify({collection: jumpTo}));
      }
      let client;
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && c.focus) {
          client = c;
          break;
        }
      }
      if (!client) {
        return self.clients.openWindow(url);
      }
      return client.focus()
        .catch(err => console.log('SW focus:', err))
        .then(() => new Promise((resolve) => setTimeout(resolve, 500)))
        .then(() => {
          if (jumpTo) {
            return client.navigate(url).catch(err => console.log('SW navigate:', err));
          }
        })
        .then(() => {
          if (jumpTo) {
            return self.sendMessage(client.id, {type: 'jumpto', collection: jumpTo});
          }
        });
    })
  );
});

self.addEventListener('install', event => {
  if (DEVEL) {
    console.log(`SW install ${VERSION} DEVEL`);
    event.waitUntil(self.skipWaiting());
    return;
  }
  console.log(`SW install ${VERSION}`);
  event.waitUntil(
    self.caches.open(VERSION).then(c => c.addAll(MANIFEST))
  );
});

self.addEventListener('activate', event => {
  if (DEVEL) {
    console.log(`SW activate ${VERSION} DEVEL`);
    event.waitUntil(
      self.caches.keys()
      .then(keys => keys.filter(k => k !== 'local').map(k => self.caches.delete(k)))
      .then(p => Promise.all(p))
      .then(r => console.log('SW cache deletes', r))
      .then(() => self.clients.claim())
    );
    return;
  }
  console.log(`SW activate ${VERSION}`);
  event.waitUntil(
    self.caches.keys()
    .then(keys => keys.filter(k => k !== VERSION && k !== 'local').map(k => self.caches.delete(k)))
    .then(p => Promise.all(p))
    .then(r => console.log('SW cache deletes', r))
    .then(() => self.clients.claim())
  );
});

self.addEventListener('unhandledrejection', event => {
  self.sendMessage('', {type: 'error', msg: event.reason});
});

self.addEventListener('statechange', event => {
  console.log('SW state change', event);
});

self.addEventListener('resume', event => {
  console.log('SW resume', event);
});

async function handleRpcRequest(clientId, event) {
  if (!self.app) {
    console.log('SW handleRpcRequest not ready');
    setTimeout(() => {
      self.handleRpcRequest(clientId, event);
    }, 100);
    return;
  }
  const methods = [
    'login',
    'createAccount',
    'recoverAccount',
    'upload',
    'cancelUpload',
    'backupPhrase',
    'changeKeyBackup',
    'restoreSecretKey',
    'updateProfile',
    'deleteAccount',
    'generateOTP',
    'addSecurityKey',
    'listSecurityKeys',
    'adminUsers',
    'mfaCheck',
  ];
  if (!methods.includes(event.data.func)) {
    console.log('SW RPC method not allowed', event.data.func);
    self.sendMessage(clientId, {type: 'rpc-result', id: event.data.id, func: event.data.func, reject: 'method not allowed'});
    return;
  }
  await store.open();
  self.app[event.data.func](clientId, ...event.data.args)
  .then(e => {
    self.sendMessage(clientId, {type: 'rpc-result', id: event.data.id, func: event.data.func, resolve: e});
  })
  .catch(e => {
    self.sendMessage(clientId, {type: 'rpc-result', id: event.data.id, func: event.data.func, reject: e});
  })
  .finally(() => store.release());
}

self.addEventListener('message', async event => {
  const clientId = event.source.id;
  switch(event.data?.type) {
    case 'nop':
      break;
    case 'hello':
      console.log(`SW Received hello ${event.data.version}`);
      if (event.data.version !== VERSION) {
        console.log(`SW Version mismatch: ${event.data.version} != ${VERSION}`);
      }
      Lang.current = event.data.lang || 'en-US';
      self.capabilities = event.data.capabilities;
      initApp(event.data.storeKey);
      break;
    case 'rpc':
      self.handleRpcRequest(clientId, event);
      break;
    case 'rpc-result':
      if (event.data.id in self.rpcWait_) {
        if (event.data.reject !== undefined) {
          self.rpcWait_[event.data.id].reject(event.data.reject);
        } else {
          self.rpcWait_[event.data.id].resolve(event.data.resolve);
        }
        delete self.rpcWait_[event.data.id];
      }
      break;
    default:
      console.log('SW Received unexpected message', event.data);
      break;
  }
});

self.addEventListener('fetch', event => {
  const reqUrl = event.request.url.replace(/#.*$/, '');
  if (!reqUrl.startsWith(self.registration.scope)) {
    console.error('SW fetch req out of scope', reqUrl, self.registration.scope);
    event.respondWith('request out of scope', {'status': 403, 'statusText': 'Permission denied'});
    return;
  }
  const url = new URL(reqUrl);
  const scope = new URL(self.registration.scope);
  let rel = url.pathname.slice(scope.pathname.length);
  if (rel === '') {
    rel = 'index.html';
  }
  if (MANIFEST.includes(rel)) {
    event.respondWith(
      self.caches.match(rel).then(resp => {
        if (resp) return resp;
        console.log(`SW fetch ${rel}, no cache`);
        return fetch(event.request);
      })
    );
    return;
  }

  let count = 0;
  const p = new Promise(async (resolve, reject) => {
    const handler = async () => {
      if (self.app) {
        await store.open();
        return resolve(self.app.handleFetchEvent(event));
      }
      if (count++ > 100) {
        fixme();
        console.log(event.request);
        return reject(new Error('timeout'));
      }
      setTimeout(handler, 100);
    };
    handler();
  })
  .finally(() => store.release());
  event.respondWith(p);
});

initApp(null);
console.log(`SW loaded ${VERSION}`);
