// Page-world (MAIN) shim. Runs at document_start, before ChromePolyfill.js
// and background-app.js, so they observe a fully wired bridge surface.
//
// Outgoing (page → native): exposes window.AndroidBridge and a
// window.webkit.messageHandlers.* shape; both fan out to
// window.postMessage({tag: "__ff_bouncer", ...}) which bridge_iso.js (the
// ISOLATED-world content script) picks up and forwards to native over the
// extension port.
//
// Incoming (native → page): listens for window.postMessage events with
// tag "__ff_bouncer_native" that bridge_iso.js posts after relaying the
// native port. Each payload has a discriminator ("kind") and named fields;
// we dispatch to the matching __ff_* function. Crucially, no JS string
// from native is ever re-executed here — that's what page CSP would block.
(function () {
  "use strict";

  var OUTBOUND_TAG = "__ff_bouncer";
  var INBOUND_TAG = "__ff_bouncer_native";

  var HANDLER_NAMES = [
    "feedfilterLog",
    "feedfilterShowSheet",
    "feedfilterPhrasesUpdated",
    "feedfilterWsOpen",
    "feedfilterWsSend",
    "feedfilterWsClose",
    "feedfilterModalClosed",
    "feedfilterAiSettings",
    "feedfilterPushDirectResult"
  ];

  window.__ffExtensionVersion = "1.1.8";
  window.__ff_platform = "android";

  // ---- Direct push-enable (experiment): intercept x.com's own network calls ----
  // Runs at document_start, before x.com's bundle, so we see every request.
  // Two purposes: (1) capture the bearer + CSRF token x.com authenticates with,
  // so we can replay its push-registration call ourselves; (2) log the actual
  // notifications-settings requests it makes, to learn that call's exact shape.
  (function installNetworkTap() {
    function captureHeaders(headers) {
      try {
        var h = headers ? new Headers(headers) : null;
        if (h && h.get("authorization") && !window.__ff_authHeaders) {
          var ct0 = (document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1] || "";
          window.__ff_authHeaders = {
            authorization: h.get("authorization"),
            "x-csrf-token": h.get("x-csrf-token") || ct0
          };
          try { console.log("[Bouncer] captured x.com auth headers"); } catch (e) {}
        }
      } catch (e) {}
    }
    function logSettings(method, url, body) {
      if (url && /notifications\/settings|\/push/i.test(url)) {
        try {
          console.log("[Bouncer] x.com API " + (method || "GET") + " " + url +
            (body ? " body=" + (typeof body === "string" ? body : "[obj]").slice(0, 800) : ""));
        } catch (e) {}
      }
    }
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var url = (typeof input === "string") ? input : (input && input.url);
          var method = (init && init.method) || (input && input.method) || "GET";
          captureHeaders(init && init.headers);
          logSettings(method, url, init && init.body);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var origSet = XHR.prototype.setRequestHeader;
      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (/^authorization$/i.test(name) && value && !window.__ff_xhrAuth) {
            window.__ff_xhrAuth = value;
          }
        } catch (e) {}
        return origSet.apply(this, arguments);
      };
    }
  })();

  function dispatchBridge(name, arg) {
    var s = (typeof arg === "string") ? arg : JSON.stringify(arg);
    try {
      window.postMessage({ tag: OUTBOUND_TAG, name: name, arg: s }, "*");
    } catch (e) {
      try { console.error("[Bouncer/page] postMessage failed", name, e); } catch (_) {}
    }
  }

  var bridge = {};
  HANDLER_NAMES.forEach(function (n) {
    bridge[n] = function (arg) { dispatchBridge(n, arg); };
  });
  window.AndroidBridge = bridge;

  // iOS-shaped surface that the shared JS (ChromePolyfill, content.js, etc.)
  // already targets via window.webkit.messageHandlers.X.postMessage.
  window.webkit = window.webkit || { messageHandlers: {} };
  HANDLER_NAMES.forEach(function (n) {
    window.webkit.messageHandlers[n] = {
      postMessage: function (arg) { dispatchBridge(n, arg); }
    };
  });

  // evaluateJavascript can't await Promises on Android: JS resolves the
  // value locally and posts it back over a named channel.
  window.__ff_resolveAndPost = function (promise, channel, jsonKey) {
    try {
      Promise.resolve(promise).then(function (v) {
        var payload = {};
        payload[jsonKey] = v;
        try { bridge[channel](JSON.stringify(payload)); } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  };

  // Native dispatches a couple of UI-side effects that aren't named __ff_*
  // functions in the shared JS, so we provide thin shims here.
  window.__ff_setSheetClass = function (open) {
    try { document.body.classList.toggle('ff-panel-open', !!open); } catch (e) {}
  };

  // ---- Direct push-enable button (option #4) ----
  // x.com's VAPID application server key (from its web bundle). Ties the
  // subscription to x.com's sender so its server's VAPID-signed pushes are
  // accepted by our FCM endpoint.
  var X_VAPID = "BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs";

  function b64urlToU8(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    var pad = s.length % 4 ? "====".slice(s.length % 4) : "";
    var raw = atob(s + pad);
    var u = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
  }

  function result(ok, stage, detail) {
    try {
      window.webkit.messageHandlers.feedfilterPushDirectResult.postMessage(
        JSON.stringify({ ok: !!ok, stage: stage || "", detail: detail || "" })
      );
    } catch (e) {}
  }

  // Injects a real, tappable in-page button on the current (home) page. The
  // user's tap on it is a genuine user gesture, so pushManager.subscribe() —
  // which Gecko refuses without user activation — is allowed. This is the whole
  // trick that lets us skip the slow settings page.
  window.__ff_showEnablePushButton = function () {
    if (document.getElementById("ff-enable-push")) return;
    var btn = document.createElement("button");
    btn.id = "ff-enable-push";
    btn.textContent = "🔔  Turn on X notifications";
    var s = btn.style;
    s.position = "fixed";
    s.left = "50%";
    s.bottom = "120px";
    s.transform = "translateX(-50%)";
    s.zIndex = "2147483647";
    s.padding = "14px 22px";
    s.borderRadius = "9999px";
    s.border = "none";
    s.background = "#7856ff";
    s.color = "#fff";
    s.fontSize = "16px";
    s.fontWeight = "600";
    s.boxShadow = "0 6px 24px rgba(0,0,0,0.35)";
    s.cursor = "pointer";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "Turning on…";
      enablePushDirect().then(function (r) {
        result(r.ok, r.stage, r.detail);
        try { btn.remove(); } catch (e) {}
      });
    });
    document.body.appendChild(btn);
  };

  function enablePushDirect() {
    // Runs inside the button's click handler → user activation is present.
    return (async function () {
      var reg;
      try {
        reg = await navigator.serviceWorker.ready;
      } catch (e) {
        return { ok: false, stage: "sw", detail: String(e) };
      }
      var sub;
      try {
        sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64urlToU8(X_VAPID)
          });
        }
      } catch (e) {
        return { ok: false, stage: "subscribe", detail: String(e) };
      }
      var json = sub.toJSON();
      try {
        console.log("[Bouncer] direct subscribe ok; endpoint=" +
          String(sub.endpoint).slice(0, 64) + " haveAuth=" + !!window.__ff_authHeaders);
      } catch (e) {}
      // Iteration 1: navigate to the settings page so x.com's own client syncs
      // this existing subscription to its backend, and our network tap logs the
      // exact registration call. Iteration 2 will replay that call directly and
      // drop this navigation entirely.
      try {
        setTimeout(function () { location.href = "/settings/push_notifications"; }, 50);
      } catch (e) {}
      return { ok: true, stage: "subscribed", detail: String(sub.endpoint).slice(0, 64) };
    })();
  }

  // Native calls this on the x.com push-notification settings page during the
  // guided-enable flow. We can't click the toggle ourselves — Gecko requires a
  // genuine user gesture for pushManager.subscribe(), and a scripted click has
  // no user activation, so it's silently denied. Instead we just help the user
  // find the real toggle: scroll the first checkbox into view and pulse a
  // highlight ring around its row. Their own tap carries the activation.
  window.__ff_revealPushToggle = function () {
    var start = Date.now();
    // x.com renders the settings content client-side and can take ~10s, so
    // keep polling well past that before giving up on finding the toggle.
    var TIMEOUT_MS = 25000;
    function attempt() {
      var box = document.querySelector('input[type="checkbox"]');
      if (box) {
        try {
          console.log("[Bouncer] push toggle rendered after " +
            (Date.now() - start) + "ms");
        } catch (e) {}
        // The tappable row is an ancestor of the hidden input; walk up a few
        // levels for something with real height to highlight.
        var target = box;
        for (var i = 0; i < 4 && target.parentElement; i++) {
          target = target.parentElement;
          if (target.getBoundingClientRect().height >= 36) break;
        }
        try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
        try {
          var prev = target.style.boxShadow;
          var prevT = target.style.transition;
          target.style.transition = "box-shadow 0.4s ease";
          target.style.boxShadow = "0 0 0 3px rgba(120,86,255,0.9)";
          setTimeout(function () {
            target.style.boxShadow = prev || "";
            setTimeout(function () { target.style.transition = prevT || ""; }, 500);
          }, 1600);
        } catch (e) {}
        return;
      }
      if (Date.now() - start > TIMEOUT_MS) return;
      setTimeout(attempt, 200);
    }
    attempt();
  };

  window.__ff_loadAiSettings = function () {
    if (typeof window.__ff_resolveAndPost !== 'function') return;
    // AI detection is phrase-driven (no on/off switch); this reports the
    // derived state that lights the native sparkle indicator.
    if (typeof window.__ff_getAiTextFilterEnabled === 'function') {
      window.__ff_resolveAndPost(
        window.__ff_getAiTextFilterEnabled(),
        'feedfilterAiSettings',
        'aiDetectionOn'
      );
    }
    if (typeof window.__ff_getStorage === 'function') {
      window.__ff_resolveAndPost(
        window.__ff_getStorage(['filterReplies']).then(function (d) {
          // Missing means on — same default the pipeline and the iOS
          // sheet apply (`data.filterReplies !== false`).
          return !d || d.filterReplies !== false;
        }),
        'feedfilterAiSettings',
        'filterReplies'
      );
    }
  };

  // Native → MAIN dispatcher. bridge_iso.js relays each port message here
  // via window.postMessage; we route by payload.kind.
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.tag !== INBOUND_TAG) return;
    var p = d.payload;
    if (!p || typeof p !== "object") return;
    switch (p.kind) {
      case "wsEvent":
        if (typeof window.__ff_wsEvent === "function") {
          window.__ff_wsEvent(p.socketId, p.event, p.data);
        }
        return;
      case "wsMessage":
        if (typeof window.__ff_wsMessage === "function") {
          window.__ff_wsMessage(p.socketId, p.b64);
        }
        return;
      case "call":
        if (!p.fn || typeof p.fn !== "string") return;
        var fn = window[p.fn];
        if (typeof fn !== "function") return;
        try { fn.apply(null, Array.isArray(p.args) ? p.args : []); }
        catch (err) { try { console.warn("[Bouncer/page] call " + p.fn + " threw", err); } catch (_) {} }
        return;
    }
  });

  try { console.log("[Bouncer/page] bridge surface installed v", window.__ffExtensionVersion); } catch (_) {}
})();
