// Owns the native messaging port. Content scripts can't call
// browser.runtime.connectNative directly in Firefox/GeckoView — it's
// gated to background contexts — so this script holds the single
// native port and bidirectionally relays messages to/from any content
// script that connects with the well-known port name.
(function () {
  "use strict";

  var NATIVE_APP = "bouncer";
  var CONTENT_PORT_NAME = "bouncer-content";

  var nativePort = null;
  var contentPorts = new Set();
  var pendingFromContent = [];

  function connectNativePort() {
    try {
      nativePort = browser.runtime.connectNative(NATIVE_APP);
    } catch (e) {
      console.error("[Bouncer/bg] connectNative failed", e);
      nativePort = null;
      return;
    }
    nativePort.onMessage.addListener(function (msg) {
      contentPorts.forEach(function (p) {
        try { p.postMessage(msg); } catch (_) {}
      });
    });
    nativePort.onDisconnect.addListener(function (p) {
      console.warn("[Bouncer/bg] native port disconnected", p && p.error);
      nativePort = null;
    });

    // Flush anything that came in before the port was alive.
    while (pendingFromContent.length) {
      var msg = pendingFromContent.shift();
      try { nativePort.postMessage(msg); } catch (_) {}
    }
  }

  connectNativePort();

  browser.runtime.onConnect.addListener(function (port) {
    if (port.name !== CONTENT_PORT_NAME) return;
    contentPorts.add(port);
    port.onMessage.addListener(function (msg) {
      if (!nativePort) {
        pendingFromContent.push(msg);
        return;
      }
      try { nativePort.postMessage(msg); } catch (_) {}
    });
    port.onDisconnect.addListener(function () {
      contentPorts.delete(port);
    });
  });
})();
