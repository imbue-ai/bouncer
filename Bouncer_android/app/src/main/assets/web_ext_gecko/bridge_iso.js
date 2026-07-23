// Isolated-world content script. Owns the runtime port to background.js.
// Page → isolated → background: forwards bridge calls from MAIN world
// (delivered as window.postMessage with tag "__ff_bouncer") onto the port.
// Background → isolated → page: forwards structured payloads from native
// (delivered via the port) back into MAIN world as window.postMessage with
// tag "__ff_bouncer_native". We do NOT inject <script> elements — page CSP
// blocks that on x.com — and there is no eval; bridge_page.js dispatches
// the typed payloads directly to the matching __ff_* functions.
(function () {
  "use strict";

  var PORT_NAME = "bouncer-content";
  var INBOUND_TAG = "__ff_bouncer";
  var OUTBOUND_TAG = "__ff_bouncer_native";
  var port;

  try {
    port = browser.runtime.connect({ name: PORT_NAME });
  } catch (e) {
    console.error("[Bouncer/iso] connect to background failed", e);
    return;
  }

  // MAIN → ISOLATED → background.
  window.addEventListener("message", function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.tag !== INBOUND_TAG) return;
    if (!port) return;
    try {
      port.postMessage({ kind: "bridge", name: d.name, arg: d.arg });
    } catch (err) {
      console.error("[Bouncer/iso] port post failed", d.name, err);
    }
  });

  // background → ISOLATED → MAIN.
  port.onMessage.addListener(function (msg) {
    if (!msg || typeof msg !== "object") return;
    try {
      window.postMessage({ tag: OUTBOUND_TAG, payload: msg }, "*");
    } catch (err) {
      console.error("[Bouncer/iso] window.postMessage failed", err);
    }
  });

  port.onDisconnect.addListener(function () {
    port = null;
  });
})();
