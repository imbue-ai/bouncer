// ChromePolyfill.js — Polyfill for chrome.* APIs in WKWebView
// Uses localStorage for storage and in-page event dispatch for messaging.

(function() {
  'use strict';

  if (typeof window.chrome !== 'undefined' && window.chrome._polyfilled) return;

  const SYNC_PREFIX = 'ff_sync_';
  const LOCAL_PREFIX = 'ff_local_';

  // --- Storage change listeners ---
  const storageChangeListeners = [];

  function fireStorageChange(changes, areaName) {
    for (const cb of storageChangeListeners) {
      try { cb(changes, areaName); } catch (e) { console.error('[ChromePolyfill] storage.onChanged error:', e); }
    }
  }

  // --- Native-backed shared storage ---
  // chrome.storage on iOS must be shared across origins (x.com, m.youtube.com)
  // so settings and API keys follow the user between sites — matching the
  // desktop extension, where everything lives in one global chrome.storage and
  // only the per-platform `descriptions_<site>` keys differ (by key name).
  // localStorage is per-origin, so reads/writes route through a native
  // UserDefaults store via the `feedfilterStorage` reply handler. Any values
  // left in this origin's localStorage from before this shipped are migrated
  // up to the native store on first access and then cleared, so nobody loses
  // their filters/keys. If the native handler is missing we fall back to the
  // old per-origin localStorage behavior.
  function hasStorageBridge() {
    return typeof webkit !== 'undefined'
      && webkit.messageHandlers
      && webkit.messageHandlers.feedfilterStorage;
  }

  function nativeStorageCall(op, payload) {
    return webkit.messageHandlers.feedfilterStorage.postMessage(Object.assign({ op: op }, payload));
  }

  function parseRaw(raw) {
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function makeStorageArea(prefix, areaName) {
    function legacyRaw(key) {
      try { return localStorage.getItem(prefix + key); } catch (e) { return null; }
    }
    function clearLegacy(key) {
      try { localStorage.removeItem(prefix + key); } catch (e) {}
    }

    // Resolve { key: rawJsonString } for the requested keys (or all keys when
    // getAll), preferring the native store and falling back to — then
    // migrating up — any leftover legacy localStorage values.
    async function readRaws(keyList, getAll) {
      if (!hasStorageBridge()) {
        const out = {};
        if (getAll) {
          for (let i = 0; i < localStorage.length; i++) {
            const fk = localStorage.key(i);
            if (fk && fk.indexOf(prefix) === 0) out[fk.slice(prefix.length)] = localStorage.getItem(fk);
          }
        } else {
          for (const k of keyList) { const r = legacyRaw(k); if (r !== null) out[k] = r; }
        }
        return out;
      }

      let nativeRaw = {};
      try {
        nativeRaw = (await nativeStorageCall(getAll ? 'getAll' : 'get', getAll ? { prefix } : { prefix, keys: keyList })) || {};
      } catch (e) { nativeRaw = {}; }

      const out = {};
      const migrate = {};
      if (getAll) {
        for (const k of Object.keys(nativeRaw)) out[k] = nativeRaw[k];
        for (let i = 0; i < localStorage.length; i++) {
          const fk = localStorage.key(i);
          if (fk && fk.indexOf(prefix) === 0) {
            const k = fk.slice(prefix.length);
            if (!(k in out)) { const r = localStorage.getItem(fk); if (r !== null) { out[k] = r; migrate[k] = r; } }
          }
        }
      } else {
        for (const k of keyList) {
          if (nativeRaw[k] != null) out[k] = nativeRaw[k];
          else { const r = legacyRaw(k); if (r !== null) { out[k] = r; migrate[k] = r; } }
        }
      }

      const mk = Object.keys(migrate);
      if (mk.length) {
        try { await nativeStorageCall('set', { prefix, items: migrate }); } catch (e) {}
        for (const k of mk) clearLegacy(k);
      }
      return out;
    }

    return {
      get(keys, callback) {
        const defaults = {};
        let keyList = [];
        let getAll = false;
        if (keys === null || keys === undefined) getAll = true;
        else if (typeof keys === 'string') keyList = [keys];
        else if (Array.isArray(keys)) keyList = keys.slice();
        else if (typeof keys === 'object') { for (const [k, v] of Object.entries(keys)) defaults[k] = v; keyList = Object.keys(keys); }

        const work = readRaws(keyList, getAll).then((raws) => {
          const result = Object.assign({}, defaults);
          for (const k of Object.keys(raws)) result[k] = parseRaw(raws[k]);
          return result;
        });

        if (typeof callback === 'function') { work.then(callback); return undefined; }
        return work;
      },

      set(items, callback) {
        const stringified = {};
        for (const [key, value] of Object.entries(items)) stringified[key] = JSON.stringify(value);

        const work = (async () => {
          let oldRaws = {};
          if (!hasStorageBridge()) {
            for (const key of Object.keys(stringified)) {
              const o = legacyRaw(key); if (o !== null) oldRaws[key] = o;
              try { localStorage.setItem(prefix + key, stringified[key]); } catch (e) {}
            }
          } else {
            try { oldRaws = (await nativeStorageCall('set', { prefix, items: stringified })) || {}; }
            catch (e) { oldRaws = {}; }
            for (const key of Object.keys(stringified)) clearLegacy(key);
          }
          const changes = {};
          for (const key of Object.keys(items)) {
            changes[key] = { newValue: items[key] };
            if (oldRaws[key] != null) changes[key].oldValue = parseRaw(oldRaws[key]);
          }
          fireStorageChange(changes, areaName);
        })();

        if (typeof callback === 'function') { work.then(callback); return undefined; }
        return work;
      },

      remove(keys, callback) {
        const keyList = typeof keys === 'string' ? [keys] : keys;

        const work = (async () => {
          let oldRaws = {};
          if (!hasStorageBridge()) {
            for (const key of keyList) { const o = legacyRaw(key); if (o !== null) oldRaws[key] = o; clearLegacy(key); }
          } else {
            try { oldRaws = (await nativeStorageCall('remove', { prefix, keys: keyList })) || {}; }
            catch (e) { oldRaws = {}; }
            for (const key of keyList) clearLegacy(key);
          }
          const changes = {};
          for (const key of keyList) { if (oldRaws[key] != null) changes[key] = { oldValue: parseRaw(oldRaws[key]) }; }
          if (Object.keys(changes).length > 0) fireStorageChange(changes, areaName);
        })();

        if (typeof callback === 'function') { work.then(callback); return undefined; }
        return work;
      }
    };
  }

  // --- Message listeners ---
  const messageListeners = [];

  window.chrome = {
    _polyfilled: true,

    storage: {
      sync: makeStorageArea(SYNC_PREFIX, 'sync'),
      local: makeStorageArea(LOCAL_PREFIX, 'local'),
      onChanged: {
        addListener(cb) { storageChangeListeners.push(cb); },
        removeListener(cb) {
          const idx = storageChangeListeners.indexOf(cb);
          if (idx !== -1) storageChangeListeners.splice(idx, 1);
        }
      }
    },

    runtime: {
      sendMessage(msg) {
        return new Promise((resolve) => {
          let responded = false;
          function sendResponse(response) {
            if (!responded) {
              responded = true;
              resolve(response);
            }
          }

          // Dispatch to all registered listeners
          let willCallAsync = false;
          for (const listener of messageListeners) {
            try {
              const result = listener(msg, { tab: { id: 1 } }, sendResponse);
              // Chrome convention: return true means "I will call sendResponse asynchronously"
              if (result === true) {
                willCallAsync = true;
              }
              // If it returns a Promise, wait for it
              else if (result && typeof result.then === 'function') {
                willCallAsync = true;
                result.then(sendResponse).catch(e => {
                  console.error('[ChromePolyfill] sendMessage listener error:', e);
                  sendResponse(undefined);
                });
              }
            } catch (e) {
              console.error('[ChromePolyfill] sendMessage listener error:', e);
            }
          }

          // If no listener will call sendResponse async, resolve after a short timeout
          // Always add a safety timeout even for async listeners, since in-app mode
          // has both content script and background listeners on the same page —
          // one may claim async but never respond for message types it doesn't handle.
          // Use a long timeout for async listeners because local model inference
          // may block on model loading (60s+) before it can process posts.
          const timeout = willCallAsync ? 120000 : 100;
          setTimeout(() => {
            if (!responded) {
              responded = true;
              resolve(undefined);
            }
          }, timeout);
        });
      },

      onMessage: {
        addListener(cb) { messageListeners.push(cb); },
        removeListener(cb) {
          const idx = messageListeners.indexOf(cb);
          if (idx !== -1) messageListeners.splice(idx, 1);
        }
      },

      getURL(path) { return 'feedfilter://local/' + path; },

      getManifest() { return { version: (typeof __ffExtensionVersion !== 'undefined' ? __ffExtensionVersion : 'unknown') }; },

      onInstalled: {
        addListener(cb) {
          // Fire immediately with install reason
          setTimeout(() => { try { cb({ reason: 'install' }); } catch(e) {} }, 0);
        }
      },

      onSuspend: {
        addListener(cb) { /* no-op */ }
      },
      setUninstallURL() {
        // no-op in iOS
        return Promise.resolve();
      }
    },

    identity: {
      getRedirectURL() {
        console.log('[ChromePolyfill] identity.getRedirectURL (stub)');
        return 'https://localhost/oauth-callback';
      },
      launchWebAuthFlow(opts) {
        console.error('[ChromePolyfill] identity.launchWebAuthFlow not available on iOS');
        return Promise.reject(new Error('launchWebAuthFlow not available on iOS'));
      }
    },

    tabs: {
      sendMessage(tabId, msg) {
        // Same-page context: dispatch to onMessage listeners
        return chrome.runtime.sendMessage(msg);
      },
      query() {
        // Single tab in WKWebView — always return tab id 1 as active
        return Promise.resolve([{ id: 1, active: true }]);
      },
      create(opts) {
        console.log('[ChromePolyfill] tabs.create (no-op):', opts?.url);
        return Promise.resolve({ id: 1 });
      },
      onActivated: {
        addListener(cb) { console.log('[ChromePolyfill] tabs.onActivated.addListener (no-op)'); }
      },
      onRemoved: {
        addListener(cb) { console.log('[ChromePolyfill] tabs.onRemoved.addListener (no-op)'); }
      },
      onUpdated: {
        addListener(cb) { console.log('[ChromePolyfill] tabs.onUpdated.addListener (no-op)'); }
      }
    },

    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: {
        addListener(cb) { console.log('[ChromePolyfill] windows.onFocusChanged.addListener (no-op)'); }
      }
    }
  };

  // Also set browser = chrome for browser-polyfill compatibility
  window.browser = window.chrome;

  // Forward console.log/warn/error to native Xcode console via feedfilterLog handler
  if (typeof webkit !== 'undefined' && webkit.messageHandlers && webkit.messageHandlers.feedfilterLog) {
    const nativeLog = webkit.messageHandlers.feedfilterLog;
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origDebug = console.debug;
    function forward(level, args) {
      const parts = Array.from(args).map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      });
      try { nativeLog.postMessage('[' + level + '] ' + parts.join(' ')); } catch(e) {}
    }
    console.log = function() { forward('LOG', arguments); origLog.apply(console, arguments); };
    console.warn = function() { forward('WARN', arguments); origWarn.apply(console, arguments); };
    console.error = function() { forward('ERROR', arguments); origError.apply(console, arguments); };
    console.debug = function() { forward('DEBUG', arguments); origDebug.apply(console, arguments); };
  }

  // --- App Check token bridge ---
  // Native side resolves promises via window.__ff_resolveAppCheckToken(callbackId, token)
  const _appCheckCallbacks = {};
  let _appCheckCallbackId = 0;

  window.__ff_resolveAppCheckToken = function(callbackId, token) {
    const resolve = _appCheckCallbacks[callbackId];
    if (resolve) {
      delete _appCheckCallbacks[callbackId];
      resolve(token || '');
    }
  };

  window.__ff_getAppCheckToken = function() {
    return new Promise(function(resolve) {
      if (typeof webkit === 'undefined' || !webkit.messageHandlers || !webkit.messageHandlers.feedfilterGetAppCheckToken) {
        resolve('');
        return;
      }
      const id = String(++_appCheckCallbackId);
      _appCheckCallbacks[id] = resolve;
      webkit.messageHandlers.feedfilterGetAppCheckToken.postMessage(id);
      // Safety timeout — don't block forever if native never responds
      setTimeout(function() {
        if (_appCheckCallbacks[id]) {
          delete _appCheckCallbacks[id];
          resolve('');
        }
      }, 5000);
    });
  };

  // --- Native WebSocket bridge ---
  // Bypasses page CSP by routing WebSocket connections through native URLSessionWebSocketTask.
  // Native side calls __ff_wsEvent / __ff_wsMessage to deliver events back to JS.

  if (typeof webkit !== 'undefined' && webkit.messageHandlers && webkit.messageHandlers.feedfilterWsOpen) {
    var _nativeSockets = {};
    var _nativeSocketId = 0;

    // Called by native for open, error, close events
    window.__ff_wsEvent = function(socketId, event, data) {
      var socket = _nativeSockets[socketId];
      if (!socket) return;

      if (event === 'open') {
        socket._readyState = 1; // OPEN
        if (socket.onopen) socket.onopen({});
      } else if (event === 'error') {
        if (socket.onerror) socket.onerror({});
      } else if (event === 'close') {
        socket._readyState = 3; // CLOSED
        if (socket.onclose) socket.onclose(data || { code: 1000, wasClean: true });
        delete _nativeSockets[socketId];
      }
    };

    // Called by native for message events (data is base64-encoded to avoid escaping issues)
    window.__ff_wsMessage = function(socketId, b64Data) {
      var socket = _nativeSockets[socketId];
      if (!socket) return;
      try {
        var decoded = decodeURIComponent(escape(atob(b64Data)));
        if (socket.onmessage) socket.onmessage({ data: decoded });
      } catch (e) {
        console.error('[NativeWS] Failed to decode message:', e);
      }
    };

    function NativeWebSocket(url) {
      this._readyState = 0; // CONNECTING
      this._socketId = 'ws_' + (++_nativeSocketId);
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      _nativeSockets[this._socketId] = this;
      console.log('[NativeWS] Opening:', this._socketId, url);
      webkit.messageHandlers.feedfilterWsOpen.postMessage(
        JSON.stringify({ socketId: this._socketId, url: url })
      );
    }

    NativeWebSocket.CONNECTING = 0;
    NativeWebSocket.OPEN = 1;
    NativeWebSocket.CLOSING = 2;
    NativeWebSocket.CLOSED = 3;

    Object.defineProperty(NativeWebSocket.prototype, 'readyState', {
      get: function() { return this._readyState; }
    });

    NativeWebSocket.prototype.send = function(data) {
      webkit.messageHandlers.feedfilterWsSend.postMessage(
        JSON.stringify({ socketId: this._socketId, data: data })
      );
    };

    NativeWebSocket.prototype.close = function() {
      this._readyState = 2; // CLOSING
      webkit.messageHandlers.feedfilterWsClose.postMessage(
        JSON.stringify({ socketId: this._socketId })
      );
    };

    // Replace WebSocket in this content world (does not affect x.com's own scripts)
    window.WebSocket = NativeWebSocket;
    console.log('[FeedFilter] Native WebSocket bridge installed');
  }

  console.log('[FeedFilter] ChromePolyfill loaded');
})();
