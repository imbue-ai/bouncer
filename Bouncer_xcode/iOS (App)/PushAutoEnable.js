// PushAutoEnable.js — page-world script for the HIDDEN settings web view that
// PushAutoEnabler.swift spawns at a push site's settings page
// (https://x.com/settings/push_notifications, or
// https://www.facebook.com/settings/?tab=notifications).
// A port of the Android bridge_page.js preload + __ff_autoEnablePush pair.
//
// The site's own change handler on its push toggle does both halves that
// matter: pushManager.subscribe() (answered by WebPushPolyfill.js → native)
// AND the POST that registers the subscription with the site's backend. A
// scripted click drives that same handler, so no UI is needed. This script:
//   1. polls for the toggle to render and reports {ready, checked}
//      (or {loggedOut} if the page bounced to the site's login);
//   2. on native's instruction (__bouncerAutoEnableClick) clicks it if off;
//   3. reports what happened.
// Self-guarded to the settings pages, so it's inert if ever injected elsewhere.
(function () {
  'use strict';
  var native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bouncerPushAutoEnable;
  if (!native) return;
  function report(obj) { try { native.postMessage(obj); } catch (e) {} }

  var host = String(location.hostname || '').toLowerCase();
  var site = null;
  if (/(^|\.)(x|twitter)\.com$/.test(host) && location.pathname.indexOf('push_notifications') !== -1) {
    site = 'x';
  } else if (host === 'www.facebook.com' && location.pathname === '/settings/' &&
             /[?&]tab=notifications/.test(location.search)) {
    site = 'facebook';
  } else if (host === 'www.facebook.com' && location.pathname.indexOf('/login') === 0) {
    report({ event: 'logged-out' });
    return;
  }
  if (!site) return;

  // x.com: the page's only checkbox. Facebook: the "<browser> push
  // notifications" switch under "Where you receive notifications" → Browser,
  // which only renders once that row is expanded (expandSection).
  function findToggle() {
    try {
      if (site === 'x') return document.querySelector('input[type="checkbox"]');
      var switches = document.querySelectorAll('input[type="checkbox"][role="switch"]');
      for (var i = 0; i < switches.length; i++) {
        // The nearest short ancestor text is the row label.
        var p = switches[i];
        for (var depth = 0; depth < 8 && p; depth++) {
          p = p.parentElement;
          var text = (p && p.innerText) || '';
          if (text.length > 120) break;
          if (/push notifications/i.test(text)) return switches[i];
        }
      }
    } catch (e) {}
    return null;
  }

  // A click that lands before the page hydrates does nothing, so re-click
  // every 3s while the switch is still missing (a click that did expand is
  // followed by the switch within that time, so it is never collapsed again).
  var expandAt = 0, expandTries = 0;
  function expandSection() {
    if (site !== 'facebook' || expandTries >= 5 || Date.now() - expandAt < 3000) return;
    try {
      var row = document.querySelector('[role="button"][aria-label="Browser notification settings"]');
      if (!row) {
        var buttons = document.querySelectorAll('[role="button"]');
        for (var i = 0; i < buttons.length && !row; i++) {
          if (String(buttons[i].innerText || '').trim().split('\n')[0] === 'Browser') row = buttons[i];
        }
      }
      if (row) { expandAt = Date.now(); expandTries++; row.click(); }
    } catch (e) {}
  }

  var TIMEOUT_MS = 90000;
  var start = Date.now();
  var lastDiag = -1;
  (function poll() {
    var box = findToggle();
    if (!box) expandSection();
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
