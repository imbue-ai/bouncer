// PushAutoEnable.js — page-world script for the HIDDEN settings web view that
// PushAutoEnabler.swift spawns at https://x.com/settings/push_notifications.
// A port of the Android bridge_page.js preload + __ff_autoEnablePush pair.
//
// x.com's own change handler on its push toggle does both halves that
// matter: pushManager.subscribe() (answered by WebPushPolyfill.js → native)
// AND the POST that registers the subscription with x.com's backend. A
// scripted click drives that same handler, so no UI is needed. This script:
//   1. polls for the toggle to render and reports {ready, checked};
//   2. on native's instruction (__bouncerAutoEnableClick) clicks it if off;
//   3. reports what happened.
// Self-guarded to the settings path, so it's inert if ever injected elsewhere.
(function () {
  'use strict';
  if (location.pathname.indexOf('push_notifications') === -1) return;
  var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bouncerPushAutoEnable;
  if (!native) return;
  function report(obj) { try { native.postMessage(obj); } catch (e) {} }
  function findToggle() {
    try { return document.querySelector('input[type="checkbox"]'); } catch (e) { return null; }
  }

  var TIMEOUT_MS = 90000;
  var start = Date.now();
  var lastDiag = -1;
  (function poll() {
    var box = findToggle();
    if (box) {
      report({ event: 'ready', checked: !!box.checked, elapsedMs: Date.now() - start });
      return;
    }
    var elapsed = Date.now() - start;
    var sec = Math.floor(elapsed / 5000);
    if (sec !== lastDiag) {
      lastDiag = sec;
      report({ event: 'waiting', elapsedMs: elapsed, inputs: document.querySelectorAll('input').length,
               title: String(document.title || '').slice(0, 30) });
    }
    if (elapsed > TIMEOUT_MS) { report({ event: 'timeout', elapsedMs: elapsed }); return; }
    setTimeout(poll, 150);
  })();

  window.__bouncerAutoEnableClick = function () {
    var box = findToggle();
    if (!box) { report({ event: 'click', ok: false, reason: 'no toggle' }); return; }
    if (box.checked) { report({ event: 'click', ok: true, alreadyOn: true }); return; }
    try {
      box.click();
      report({ event: 'click', ok: true, alreadyOn: false });
      setTimeout(function () { report({ event: 'after-click', checked: !!box.checked }); }, 2000);
    } catch (e) {
      report({ event: 'click', ok: false, reason: String(e) });
    }
  };
})();
