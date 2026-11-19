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

  // Each platform is a live tab (see BouncerGeckoView). Since one background
  // page fans the single native port out to every tab, this is where per-tab
  // routing happens: tag inbound messages with the sender tab's platform, and
  // deliver outbound UI calls (which carry __ffTarget) only to the matching tab.
  // Untagged outbound (ws / appcheck responses) still broadcasts — the tab that
  // owns the socket/callback id picks it up.
  function platformOf(url) {
    if (!url) return null;
    try {
      var h = new URL(url).hostname.toLowerCase();
      if (h === "x.com" || h.endsWith(".x.com") ||
          h === "twitter.com" || h.endsWith(".twitter.com")) return "twitter";
      if (h === "linkedin.com" || h.endsWith(".linkedin.com")) return "linkedin";
      if (h === "facebook.com" || h.endsWith(".facebook.com")) return "facebook";
    } catch (e) {}
    return null;
  }

  function connectNativePort() {
    try {
      nativePort = browser.runtime.connectNative(NATIVE_APP);
    } catch (e) {
      console.error("[Bouncer/bg] connectNative failed", e);
      nativePort = null;
      return;
    }
    nativePort.onMessage.addListener(function (msg) {
      var target = msg && msg.__ffTarget;
      contentPorts.forEach(function (p) {
        if (target && p._ffPlatform && p._ffPlatform !== target) return;
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
    port._ffPlatform = platformOf(port.sender && port.sender.url);
    contentPorts.add(port);
    port.onMessage.addListener(function (msg) {
      // Stamp the originating tab's platform so native can attribute the
      // message to the right feed.
      if (msg && typeof msg === "object" && port._ffPlatform) {
        msg.__ffPlatform = port._ffPlatform;
      }
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

  // Facebook push: the hidden enable tab loads www.facebook.com as desktop
  // Chrome (a per-session UA override), but Gecko fetches the service-worker
  // script outside that session, with the runtime's mobile UA — and Facebook
  // answers a mobile UA on www with a 302 to m.facebook.com, which fails
  // registration (a worker script may not redirect cross-origin) with a
  // SecurityError. Give the worker-script requests the same desktop UA the
  // page has. Scoped to www's /sw path, which only that hidden page uses.
  var DESKTOP_CHROME_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  try {
    browser.webRequest.onBeforeSendHeaders.addListener(
      function (details) {
        var headers = details.requestHeaders || [];
        for (var i = 0; i < headers.length; i++) {
          if (headers[i].name.toLowerCase() === "user-agent") headers[i].value = DESKTOP_CHROME_UA;
        }
        console.log("[Bouncer/bg] desktop UA for " + details.url.split("?")[0] + " (" + details.type + ")");
        return { requestHeaders: headers };
      },
      { urls: ["https://www.facebook.com/sw*"] },
      ["blocking", "requestHeaders"]
    );
  } catch (e) {
    console.error("[Bouncer/bg] webRequest UA rewrite unavailable", e);
  }

  // "See more" (content/bluesky-see-more.ts) mixes Bluesky posts into the X
  // timeline. Here the extension runs in x.com's page world, so x.com's CSP
  // blocks its <img>/<video> loads from Bluesky's media hosts (and rewriting
  // the CSP header doesn't reach the policy the page enforces). So the page
  // asks for the bytes instead (bridge_page.js __ff_fetchRemoteMedia, via
  // bridge_iso.js): fetched here, under the extension's host permissions,
  // and shown from a blob: URL, which x.com allows. Only these hosts, so a
  // page can't use this to fetch anything else.
  var REMOTE_MEDIA_HOSTS = ["cdn.bsky.app", "video.bsky.app"];
  browser.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.kind !== "fetchRemoteMedia") return;
    var url;
    try { url = new URL(msg.url); } catch (e) { return Promise.reject(new Error("bad url")); }
    if (url.protocol !== "https:" || REMOTE_MEDIA_HOSTS.indexOf(url.hostname) < 0) {
      return Promise.reject(new Error("host not allowed: " + url.hostname));
    }
    return fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.arrayBuffer().then(function (buffer) {
        return { type: res.headers.get("content-type") || "", buffer: buffer };
      });
    });
  });
})();
