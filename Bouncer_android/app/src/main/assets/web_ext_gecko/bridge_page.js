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
    "feedfilterPushDirectResult",
    "feedfilterPushToggleReady"
  ];

  window.__ffExtensionVersion = "1.1.30";
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
      var b = "";
      try { b = (typeof body === "string") ? body : ""; } catch (e) {}
      // Catch x.com's push-registration call two ways: by URL (settings/push/
      // notification endpoints, incl. GraphQL) OR by a body carrying the push
      // subscription payload (the FCM endpoint / P-256 keys). The latter is the
      // reliable signal that x.com is telling ITS backend about our subscription.
      var byUrl = url && /notifications\/settings|\/push|register|checkin|graphql\/.*[Nn]otification/i.test(url);
      var byBody = b && /fcm\.googleapis|p256dh|"endpoint"|"?auth"?\s*[:=]|encrypted[_-]?push/i.test(b);
      if (byUrl || byBody) {
        try {
          console.log("[Bouncer] x.com " + (method || "GET") + " " + url +
            (b ? " body=" + b.slice(0, 700) : ""));
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

  // ---- Enable-notifications prompt (path a) ----
  function result(ok, stage, detail) {
    try {
      window.webkit.messageHandlers.feedfilterPushDirectResult.postMessage(
        JSON.stringify({ ok: !!ok, stage: stage || "", detail: detail || "" })
      );
    } catch (e) {}
  }

  // Native preloads x.com's push-settings page in a HIDDEN tab (see
  // BouncerGeckoView.preloadPushSettings) so tapping "Turn on" can swap to an
  // already-rendered page instead of paying x.com's ~5s settings cold-boot
  // (reproducible even in stock Firefox). But a swap is only instant once that
  // hidden page has actually rendered its toggle — which x.com does client-side
  // seconds after the document loads. So the ViewModel holds the prompt until we
  // report readiness here: poll for the toggle and signal once it exists. Gated
  // on the settings path so the home tab (which runs this same script) is silent.
  (function reportPushToggleWhenReady() {
    try {
      if (location.pathname.indexOf("push_notifications") === -1) return;
    } catch (e) { return; }
    var start = Date.now();
    // Off-screen/background renders are throttled by Gecko, so a cold load can
    // take much longer than a warm ~1.5s. Poll generously — it's invisible.
    var TIMEOUT_MS = 95000;
    var lastDiag = -1;
    (function poll() {
      var box = null;
      try { box = document.querySelector('input[type="checkbox"]'); } catch (e) {}
      if (box) {
        try {
          console.log("[Bouncer] preload: push toggle ready after " +
            (Date.now() - start) + "ms (checked=" + box.checked + ")");
        } catch (e) {}
        // Report readiness AND the current on/off state, so native can decide
        // whether a click is even needed (don't toggle an already-on switch off).
        try {
          bridge.feedfilterPushToggleReady(
            JSON.stringify({ ready: true, checked: !!box.checked })
          );
        } catch (e) {}
        return;
      }
      var elapsed = Date.now() - start;
      // Progress log every ~5s so we can tell "rendering slowly" from "stuck".
      var sec = Math.floor(elapsed / 5000);
      if (sec !== lastDiag) {
        lastDiag = sec;
        try {
          console.log("[Bouncer] preload wait " + Math.round(elapsed / 1000) +
            "s: path=" + location.pathname +
            " inputs=" + document.querySelectorAll("input").length +
            " title=" + String(document.title || "").slice(0, 30));
        } catch (e) {}
      }
      if (elapsed > TIMEOUT_MS) return;
      setTimeout(poll, 150);
    })();
  })();

  // Auto-enable: flip x.com's own push toggle in the hidden preload tab, with no
  // UI. x.com's change handler does both halves that actually matter —
  // pushManager.subscribe() AND the POST that registers the subscription with
  // x.com's backend (a bare in-page subscribe only does the former, which is why
  // it never delivered). A scripted .click() drives that same handler. Native
  // only calls this on the hidden settings tab it spawned, so it never fires on a
  // page the user navigated to themselves; still self-guarded to the settings
  // path since this script also runs on the home tab.
  window.__ff_autoEnablePush = function () {
    try {
      if (location.pathname.indexOf("push_notifications") === -1) return;
    } catch (e) { return; }
    var box = null;
    try { box = document.querySelector('input[type="checkbox"]'); } catch (e) {}
    if (!box) { try { console.log("[Bouncer] auto-enable: no toggle found"); } catch (e) {} return; }
    try {
      var perm = (window.Notification && Notification.permission);
      var ua = (navigator.userActivation && navigator.userActivation.isActive);
      console.log("[Bouncer] auto-enable pre: checked=" + box.checked +
        " vis=" + document.visibilityState + " hidden=" + document.hidden +
        " perm=" + perm + " ua=" + ua);
      if (box.checked) {
        console.log("[Bouncer] auto-enable: toggle already on, nothing to do");
        return;
      }
      console.log("[Bouncer] auto-enable: clicking push toggle");
      box.click();
      setTimeout(function () {
        try {
          console.log("[Bouncer] auto-enable post: checked=" + box.checked +
            " perm=" + (window.Notification && Notification.permission));
        } catch (e) {}
      }, 2000);
    } catch (e) {
      try { console.log("[Bouncer] auto-enable error: " + e); } catch (_) {}
    }
  };

  // Renders the one-time, in-page "Turn on notifications" prompt: a
  // bottom-anchored card over a translucent scrim, built entirely with
  // createElement + element.style (no innerHTML / no inline <style> — page CSP
  // blocks those). The whole point of drawing it in the DOM is that the user's
  // tap on "Turn on" is a genuine in-page user gesture, so the
  // pushManager.subscribe() it fires — which Gecko refuses without user
  // activation — is allowed. A native Compose dialog tap would not count.
  window.__ff_showEnableNotificationsPrompt = function () {
    // Self-guard: only ever render on x.com / twitter.com. callJs routes to the
    // active tab, which should already be x.com/home, but this is the safety net.
    try {
      var host = String(location.hostname || "").toLowerCase();
      var onX = host === "x.com" || host.endsWith(".x.com") ||
        host === "twitter.com" || host.endsWith(".twitter.com");
      if (!onX) return;
    } catch (e) { return; }
    // Idempotent: never double-inject.
    if (document.getElementById("ff-enable-notif-root")) return;

    var root = document.createElement("div");
    root.id = "ff-enable-notif-root";
    var rs = root.style;
    rs.position = "fixed";
    rs.left = "0";
    rs.right = "0";
    rs.top = "0";
    rs.bottom = "0";
    rs.zIndex = "2147483647";
    rs.display = "flex";
    rs.alignItems = "flex-end";
    rs.justifyContent = "center";
    rs.background = "rgba(0,0,0,0.5)";

    var card = document.createElement("div");
    var cs = card.style;
    cs.boxSizing = "border-box";
    cs.width = "100%";
    cs.maxWidth = "460px";
    cs.margin = "0 12px calc(24px + env(safe-area-inset-bottom, 0px))";
    cs.padding = "24px 22px 18px";
    cs.borderRadius = "22px";
    cs.background = "#16181c";
    cs.color = "#e7e9ea";
    cs.boxShadow = "0 12px 44px rgba(0,0,0,0.55)";
    cs.fontFamily = "-apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    var title = document.createElement("div");
    title.textContent = "Turn on notifications";
    var tstyle = title.style;
    tstyle.fontSize = "21px";
    tstyle.fontWeight = "800";
    tstyle.lineHeight = "26px";
    tstyle.marginBottom = "8px";

    var body = document.createElement("div");
    body.textContent = "Get notified about mentions, replies, and messages from X.";
    var bstyle = body.style;
    bstyle.fontSize = "15px";
    bstyle.lineHeight = "20px";
    bstyle.color = "#8b98a5";
    bstyle.marginBottom = "22px";

    var primary = document.createElement("button");
    primary.textContent = "Turn on";
    var pstyle = primary.style;
    pstyle.display = "block";
    pstyle.width = "100%";
    pstyle.boxSizing = "border-box";
    pstyle.padding = "14px";
    pstyle.borderRadius = "9999px";
    pstyle.border = "none";
    pstyle.background = "#1d9bf0";
    pstyle.color = "#ffffff";
    pstyle.fontSize = "16px";
    pstyle.fontWeight = "700";
    pstyle.cursor = "pointer";
    pstyle.marginBottom = "10px";

    var secondary = document.createElement("button");
    secondary.textContent = "Not now";
    var sstyle = secondary.style;
    sstyle.display = "block";
    sstyle.width = "100%";
    sstyle.boxSizing = "border-box";
    sstyle.padding = "13px";
    sstyle.borderRadius = "9999px";
    sstyle.border = "1px solid #536471";
    sstyle.background = "transparent";
    sstyle.color = "#e7e9ea";
    sstyle.fontSize = "16px";
    sstyle.fontWeight = "600";
    sstyle.cursor = "pointer";

    function removeCard() { try { root.remove(); } catch (e) {} }

    // Path (a): a bare in-page subscribe() creates our endpoint but never tells
    // x.com's backend, so no pushes arrive. The only proven way is for the user
    // to flip x.com's OWN toggle. So "Turn on" hands off to native, which
    // navigates to the push-settings page and highlights the real toggle.
    primary.addEventListener("click", function () {
      result(true, "goToSettings", "");
      removeCard();
    });

    secondary.addEventListener("click", function () {
      result(false, "declined", "user tapped Not now");
      removeCard();
    });

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(primary);
    card.appendChild(secondary);
    root.appendChild(card);
    (document.body || document.documentElement).appendChild(root);
  };

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

  // Navigate the already-booted x.com SPA to the push-settings route WITHOUT a
  // full page load. A native loadUri() re-boots the whole app (the black "X"
  // splash), which is slow — up to ~5s on some devices. Client-side routing
  // renders the settings view in-place instead. We fall back to a hard nav if
  // the SPA router doesn't pick up the history change.
  window.__ff_goToPushSettings = function () {
    var path = "/settings/push_notifications";
    // The settings view has actually rendered iff its toggle (a checkbox) is in
    // the DOM. We can't trust location.pathname: history.pushState() changes it
    // synchronously even when x.com's router ignores our synthetic popstate
    // (seen right after a fresh login, when the router listener isn't attached
    // yet). Polling for real content is the only reliable "did we route?" signal.
    function rendered() {
      return (
        location.pathname.indexOf("push_notifications") !== -1 &&
        !!document.querySelector('input[type="checkbox"]')
      );
    }
    if (rendered()) return;
    var start = 0; // ms elapsed; Date.now() is avoided — we count our own ticks
    var HARD_NAV_AFTER = 1600;
    var TICK = 200;
    (function attempt() {
      // Re-nudge the SPA router each tick: pushState (idempotent once the URL is
      // set) + a synthetic popstate, which History-API routers treat as a POP and
      // re-render for. Retrying catches the case where the router mounts late.
      try {
        if (location.pathname.indexOf("push_notifications") === -1) {
          history.pushState({}, "", path);
        }
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: history.state })
        );
      } catch (e) {}
      if (rendered()) return; // client-side route succeeded — no reboot
      if (start >= HARD_NAV_AFTER) {
        // Router genuinely didn't take it — full navigation (slow reboot, but
        // never stuck). onPageStop → __ff_revealPushToggle handles the reveal.
        try { location.href = path; } catch (e) {}
        return;
      }
      start += TICK;
      setTimeout(attempt, TICK);
    })();
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
