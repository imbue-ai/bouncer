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

  function makeStorageArea(prefix, areaName) {
    return {
      get(keys, callback) {
        const result = {};
        let keyList = [];

        if (keys === null || keys === undefined) {
          // Get all keys with this prefix
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(prefix)) {
              const realKey = k.slice(prefix.length);
              try { result[realKey] = JSON.parse(localStorage.getItem(k)); }
              catch { result[realKey] = localStorage.getItem(k); }
            }
          }
        } else if (typeof keys === 'string') {
          keyList = [keys];
        } else if (Array.isArray(keys)) {
          keyList = keys;
        } else if (typeof keys === 'object') {
          // keys is a defaults object
          for (const [k, v] of Object.entries(keys)) {
            result[k] = v; // set defaults first
          }
          keyList = Object.keys(keys);
        }

        for (const key of keyList) {
          const raw = localStorage.getItem(prefix + key);
          if (raw !== null) {
            try { result[key] = JSON.parse(raw); }
            catch { result[key] = raw; }
          }
        }

        if (typeof callback === 'function') {
          callback(result);
          return undefined;
        }
        return Promise.resolve(result);
      },

      set(items, callback) {
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          const oldRaw = localStorage.getItem(prefix + key);
          const oldValue = oldRaw !== null ? JSON.parse(oldRaw) : undefined;
          localStorage.setItem(prefix + key, JSON.stringify(value));
          changes[key] = { newValue: value };
          if (oldValue !== undefined) changes[key].oldValue = oldValue;
        }
        fireStorageChange(changes, areaName);
        if (typeof callback === 'function') {
          callback();
          return undefined;
        }
        return Promise.resolve();
      },

      remove(keys, callback) {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        const changes = {};
        for (const key of keyList) {
          const oldRaw = localStorage.getItem(prefix + key);
          if (oldRaw !== null) {
            changes[key] = { oldValue: JSON.parse(oldRaw) };
            localStorage.removeItem(prefix + key);
          }
        }
        if (Object.keys(changes).length > 0) {
          fireStorageChange(changes, areaName);
        }
        if (typeof callback === 'function') {
          callback();
          return undefined;
        }
        return Promise.resolve();
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
        console.log('[ChromePolyfill] tabs.sendMessage (routed to runtime):', msg?.type);
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
