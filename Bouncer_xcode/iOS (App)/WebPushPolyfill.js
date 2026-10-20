// WebPushPolyfill.js — injected into the PAGE world at document start on
// x.com and www.facebook.com (the push sites, PushSite in PushPayload.swift).
// WKWebView has no Push API and no Notification API, so x.com's
// "turn on push notifications" flow would bail before it ever subscribes.
// This gives the page the two objects it feature-detects and routes the one
// call that matters — pushManager.subscribe() — to the native side
// (WebPushBridge.swift), which answers with keys the app holds and an
// endpoint on the Bouncer push relay. The page then posts that subscription
// to x.com's backend exactly as it would in Chrome, and every later push is
// delivered by APNs and decrypted natively; the service worker's own push
// handler is never involved.
var BOUNCER_PUSH_POLYFILL_VERSION = 6; // bump on every change; logged natively and in-page
(function () {
  'use strict';
  if (window.__bouncerPushPolyfilled) return;
  window.__bouncerPushPolyfilled = true;
  window.__bouncerPushPolyfillVersion = BOUNCER_PUSH_POLYFILL_VERSION;

  var host = location.hostname;
  // Facebook only on www: its push setting lives on the desktop site (the
  // hidden enable view loads it as desktop Chrome); m.facebook.com has none.
  if (!/(^|\.)x\.com$|(^|\.)twitter\.com$|^www\.facebook\.com$/.test(host)) return;
  var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bouncerPush;
  if (!native) return;

  // --- encoding helpers -----------------------------------------------------
  function toBytes(v) {
    if (v == null) return null;
    if (typeof v === 'string') return fromB64url(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return null;
  }
  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function call(req) {
    return Promise.resolve(native.postMessage(req));
  }

  // --- PushSubscription / PushManager ---------------------------------------
  // x.com's support check (its push-notification-manager module) requires
  // `PushSubscriptionOptions.prototype.hasOwnProperty('applicationServerKey')`,
  // which is how Chrome exposes it; define the class the same way.
  function PushSubscriptionOptions(keyB64url) { this._key = keyB64url || null; }
  Object.defineProperties(PushSubscriptionOptions.prototype, {
    userVisibleOnly: { get: function () { return true; }, enumerable: true, configurable: true },
    applicationServerKey: {
      get: function () { return this._key ? fromB64url(this._key).buffer : null; },
      enumerable: true, configurable: true
    }
  });
  window.PushSubscriptionOptions = PushSubscriptionOptions;

  function PushSubscription(scope, json) {
    this._scope = scope;
    this._json = json;
  }
  Object.defineProperties(PushSubscription.prototype, {
    endpoint: { get: function () { return this._json.endpoint; } },
    expirationTime: { get: function () { return null; } },
    options: { get: function () { return new PushSubscriptionOptions(this._json.applicationServerKey); } }
  });
  PushSubscription.prototype.getKey = function (name) {
    var keys = this._json.keys || {};
    var v = name === 'p256dh' ? keys.p256dh : name === 'auth' ? keys.auth : null;
    return v ? fromB64url(v).buffer : null;
  };
  PushSubscription.prototype.toJSON = function () {
    return {
      endpoint: this._json.endpoint,
      expirationTime: null,
      keys: { p256dh: this._json.keys.p256dh, auth: this._json.keys.auth }
    };
  };
  PushSubscription.prototype.unsubscribe = function () {
    return call({ op: 'unsubscribe', scope: this._scope }).then(function (r) { return !!r; });
  };

  function PushManager(scope) { this._scope = scope; }
  PushManager.supportedContentEncodings = Object.freeze(['aes128gcm', 'aesgcm']);
  PushManager.prototype.subscribe = function (options) {
    var key = options && options.applicationServerKey;
    var bytes = toBytes(key);
    var scope = this._scope;
    return call({ op: 'subscribe', scope: scope, applicationServerKey: bytes ? b64url(bytes) : null })
      .then(function (r) {
        if (!r) throw new DOMException('Push subscription failed', 'NotAllowedError');
        return new PushSubscription(scope, r);
      }, function (e) {
        throw new DOMException(String(e && e.message || e), 'NotAllowedError');
      });
  };
  PushManager.prototype.getSubscription = function () {
    var scope = this._scope;
    return call({ op: 'getSubscription', scope: scope }).then(function (r) {
      return r ? new PushSubscription(scope, r) : null;
    });
  };
  PushManager.prototype.permissionState = function () {
    return call({ op: 'permissionState' });
  };
  window.PushManager = PushManager;
  window.PushSubscription = PushSubscription;

  // --- Notification ---------------------------------------------------------
  // x.com checks Notification.permission === 'granted' before it will even
  // call subscribe(); the real prompt is iOS's, shown by the native side.
  if (typeof window.Notification === 'undefined') {
    function Notification(title, options) {
      this.title = title;
      var o = options || {};
      this.body = o.body || '';
      this.tag = o.tag || '';
      this.icon = o.icon || '';
      this.data = o.data;
      this.onclick = null; this.onclose = null; this.onerror = null; this.onshow = null;
    }
    Notification.prototype.close = function () {};
    Notification.prototype.addEventListener = function () {};
    Notification.prototype.removeEventListener = function () {};
    Object.defineProperty(Notification, 'permission', { get: function () { return 'granted'; } });
    Object.defineProperty(Notification, 'maxActions', { get: function () { return 0; } });
    Notification.requestPermission = function (cb) {
      var p = Promise.resolve('granted');
      if (typeof cb === 'function') p.then(cb);
      return p;
    };
    window.Notification = Notification;
  }

  // --- Permissions API ------------------------------------------------------
  // WKWebView answers permissions.query() for push / notifications with
  // "denied" even though the Notification stub above says granted; a site
  // that consults the Permissions API (x.com does) then treats push as
  // blocked. Answer those two as granted and pass every other query through.
  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    var realQuery = navigator.permissions.query.bind(navigator.permissions);
    var grantedStatus = function (name) {
      return {
        name: name, state: 'granted', onchange: null,
        addEventListener: function () {}, removeEventListener: function () {},
        dispatchEvent: function () { return false; }
      };
    };
    Object.defineProperty(navigator.permissions, 'query', {
      configurable: true, writable: true,
      value: function (desc) {
        var name = desc && desc.name;
        if (name === 'push' || name === 'notifications') return Promise.resolve(grantedStatus(name));
        return realQuery(desc);
      }
    });
  }

  // --- Service worker registration ------------------------------------------
  // With App-Bound Domains the real registration exists and only needs a
  // pushManager; without them WKWebView has no navigator.serviceWorker at
  // all, so provide the minimal shape x.com's enable flow walks through.
  var origin = location.origin + '/';
  function ensureRegistrationNotificationAPI(proto) {
    if (!('showNotification' in proto)) {
      proto.showNotification = function () { return Promise.resolve(); };
    }
    if (!('getNotifications' in proto)) {
      proto.getNotifications = function () { return Promise.resolve([]); };
    }
  }
  if (navigator.serviceWorker && window.ServiceWorkerRegistration) {
    ensureRegistrationNotificationAPI(ServiceWorkerRegistration.prototype);
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
      configurable: true,
      get: function () {
        if (!this.__bouncerPM) this.__bouncerPM = new PushManager(this.scope || origin);
        return this.__bouncerPM;
      }
    });
  } else {
    var worker = {
      scriptURL: origin + 'sw.js', state: 'activated',
      postMessage: function () {}, addEventListener: function () {}, removeEventListener: function () {},
      onstatechange: null, onerror: null
    };
    function ServiceWorkerRegistration() {}
    ServiceWorkerRegistration.prototype.update = function () { return Promise.resolve(this); };
    ServiceWorkerRegistration.prototype.unregister = function () { return Promise.resolve(true); };
    ServiceWorkerRegistration.prototype.addEventListener = function () {};
    ServiceWorkerRegistration.prototype.removeEventListener = function () {};
    ensureRegistrationNotificationAPI(ServiceWorkerRegistration.prototype);
    window.ServiceWorkerRegistration = ServiceWorkerRegistration;

    var registration = new ServiceWorkerRegistration();
    registration.scope = origin;
    registration.active = worker;
    registration.installing = null;
    registration.waiting = null;
    registration.pushManager = new PushManager(origin);
    registration.navigationPreload = {
      enable: function () { return Promise.resolve(); },
      disable: function () { return Promise.resolve(); },
      getState: function () { return Promise.resolve({ enabled: false }); }
    };
    registration.onupdatefound = null;
    var container = {
      controller: worker,
      ready: Promise.resolve(registration),
      register: function () { return Promise.resolve(registration); },
      getRegistration: function () { return Promise.resolve(registration); },
      getRegistrations: function () { return Promise.resolve([registration]); },
      startMessages: function () {},
      addEventListener: function () {}, removeEventListener: function () {},
      oncontrollerchange: null, onmessage: null, onmessageerror: null
    };
    try {
      Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
    } catch (e) { /* non-configurable in this engine; leave it */ }
  }

  // --- Diagnostics ----------------------------------------------------------
  try {
    var state = {
      version: BOUNCER_PUSH_POLYFILL_VERSION,
      standalone: navigator.standalone,
      pushManager: 'PushManager' in window,
      notificationPermission: window.Notification ? window.Notification.permission : null,
      serviceWorker: 'serviceWorker' in navigator,
      controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      // The three conditions of x.com's own "push supported" check:
      xcomCheck: {
        registrationShowNotification: !!(window.ServiceWorkerRegistration && 'showNotification' in window.ServiceWorkerRegistration.prototype),
        pushManager: !!window.PushManager,
        subscriptionOptionsKey: ('PushSubscriptionOptions' in window) && window.PushSubscriptionOptions.prototype.hasOwnProperty('applicationServerKey')
      }
    };
    console.log('[BouncerPush] polyfill v' + BOUNCER_PUSH_POLYFILL_VERSION + ' active', JSON.stringify(state));
    if (navigator.permissions) {
      Promise.all([
        navigator.permissions.query({ name: 'notifications' }).then(function (p) { return p.state; }, function (e) { return 'err:' + e.message; }),
        navigator.permissions.query({ name: 'push', userVisibleOnly: true }).then(function (p) { return p.state; }, function (e) { return 'err:' + e.message; })
      ]).then(function (r) { console.log('[BouncerPush] permissions notifications=' + r[0] + ' push=' + r[1]); });
    }
  } catch (e) { console.log('[BouncerPush] diagnostics failed: ' + e); }
})();
