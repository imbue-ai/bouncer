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
    "feedfilterLocalClassify",
    "feedfilterLocalAiTextDetect"
  ];

  window.__ffExtensionVersion = "1.2.0";
  window.__ff_platform = "android";

  // On-device model catalog, consumed by the shared JS (src/shared/models.ts)
  // to populate PREDEFINED_MODELS.iosLocal. iOS injects this dynamically ahead
  // of ChromePolyfill.js; on Android content scripts are static assets, so the
  // catalog is a literal. Keep in sync with the Kotlin registry in
  // com.imbue.bouncer.inference.LocalModels. isSupported is static here — RAM
  // gating is enforced by the native settings UI and at classify time.
  window.__iosLocalModels = [
    {
      name: "gemma-4-e2b-detector-v2",
      display: "Gemma E2B",
      size: "~2.2 GB",
      isSupported: true,
      requiredRAM: "6 GB"
    }
  ];

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

  window.__ff_loadAiSettings = function () {
    if (typeof window.__ff_resolveAndPost !== 'function') return;
    if (typeof window.__ff_getAiTextFilterEnabled === 'function') {
      window.__ff_resolveAndPost(
        window.__ff_getAiTextFilterEnabled(),
        'feedfilterAiSettings',
        'aiTextFilterEnabled'
      );
    }
    if (typeof window.__ff_getAiTextDetectionThreshold === 'function') {
      window.__ff_resolveAndPost(
        window.__ff_getAiTextDetectionThreshold(),
        'feedfilterAiSettings',
        'aiTextDetectionThreshold'
      );
    }
    if (typeof window.__ff_getStorage === 'function') {
      window.__ff_resolveAndPost(
        window.__ff_getStorage(['selectedModel']).then(function (d) {
          return (d && d.selectedModel) || '';
        }),
        'feedfilterAiSettings',
        'selectedModel'
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
        // Args travel as a JSON string (argsJson): the Gecko port cannot carry
        // mixed-type arrays (GeckoBundle types them from the first element).
        var args = [];
        if (Array.isArray(p.args)) {
          args = p.args;
        } else if (typeof p.argsJson === "string") {
          try { args = JSON.parse(p.argsJson) || []; } catch (e) { args = []; }
        }
        try { fn.apply(null, args); }
        catch (err) { try { console.warn("[Bouncer/page] call " + p.fn + " threw", err); } catch (_) {} }
        return;
    }
  });

  try { console.log("[Bouncer/page] bridge surface installed v", window.__ffExtensionVersion); } catch (_) {}
})();
