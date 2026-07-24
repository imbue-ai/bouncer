// Fix for "Continue with Google" doing nothing on x.com login pages in Gecko.
//
// X renders its own styled Google pill and overlays Google's real GSI widget
// on top of it inside an invisible click-catcher (opacity: 0,
// position: absolute, z-index: 10, overflow: hidden — class "jf-gsi-hit").
// In Gecko the GSI widget lays out ~40px below that overlay, so it is
// clipped out of the overlay entirely: taps on the visible pill land on
// inert parent-document divs and the OAuth popup never opens. (Reproduces
// without any Bouncer scripts on the page — it is an x.com-in-Gecko layout
// bug, so the app shims it here.)
//
// The GSI widget in the parent document is a container ("S9gUrf-YoZ4jf")
// holding a wrapper with the accounts.google.com button iframe (purely the
// visual face) and Google's invisible click-catcher div ("L5Fo6c-bF1uUb").
// Only the catcher opens the OAuth popup — clicks that reach the iframe
// itself do nothing in this integration. Gecko lays the container out
// flush with X's overlay; it is the container's CHILDREN that land ~40px
// low. So the shim realigns the container and each of its children to the
// overlay. Translating only the iframe (this shim's first version) LOOKS
// fixed but leaves the click-catcher 40px below the pill: the button
// renders correctly and every tap on it is dead.
//
// This script must run on ALL x.com/twitter.com pages (no login excludes):
// X reaches the login route via history.pushState from other documents, so
// a matcher scoped to the login URLs would never inject.
//
// Because it runs everywhere, it has to be near-free when no GSI iframe is
// on the page, and it must CONVERGE once the widget is aligned:
//  - Idle mode observes childList only (feeds mutate style/class attributes
//    every animation frame; observing those would run us continuously) and
//    does a single querySelector per batch to see if a GSI iframe appeared.
//  - Active mode (iframe present) additionally observes style/class so it
//    can track X relayouts, but skips offsets within TOLERANCE. Rects are
//    fractional, so chasing subpixel deltas would rewrite the transform
//    every frame; each write re-fires the observer, and that feedback loop
//    saturates the main thread. That not only janks the page — it delays
//    Google's window.open past Gecko's transient-user-activation window, so
//    the OAuth popup gets popup-blocked and taps appear to do nothing.
//  - MAX_WRITES per element is a backstop against any residual feedback
//    loop; the legitimate fix needs one write (reset on resize/rotation).
(function () {
  'use strict';

  var SEL = 'iframe[src*="accounts.google.com/gsi/button"]';
  var TOLERANCE = 2; // px
  var MAX_WRITES = 20;

  var writeCounts = new WeakMap();

  // Shows up in logcat ("Isolated Web Content"/"FF/JS" tags; consoleOutput
  // is enabled in BouncerGeckoView) and in Firefox remote debugging.
  function trace(msg) {
    console.log('[gsi-fix] ' + msg);
  }

  function overlayAncestor(el) {
    var hit = el.closest('[class*="jf-gsi-hit"]');
    if (hit) return hit;
    for (var e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      var cs = getComputedStyle(e);
      if (cs.position === 'absolute' && parseFloat(cs.opacity) === 0) return e;
    }
    return null;
  }

  // The whole GSI widget (visual iframe + Google's click-catcher div,
  // siblings inside GIS's "S9gUrf-YoZ4jf" container). X's wrapper divs
  // above it sit flush with the overlay, so if the class ever changes,
  // fall back to the highest ancestor still offset from the overlay.
  function widgetRoot(iframe, overlay, overlayRect) {
    var el = iframe.closest('.S9gUrf-YoZ4jf');
    if (el && overlay.contains(el) && el !== overlay) return el;
    var best = iframe;
    for (el = iframe.parentElement; el && el !== overlay && el !== document.body; el = el.parentElement) {
      var r = el.getBoundingClientRect();
      if (Math.abs(r.left - overlayRect.left) > TOLERANCE || Math.abs(r.top - overlayRect.top) > TOLERANCE) {
        best = el;
      } else {
        break;
      }
    }
    return best;
  }

  var skipTraces = 0;
  function traceSkip(msg) {
    if (skipTraces < 20) { skipTraces++; trace('skip: ' + msg); }
  }

  // Translates el so its top-left matches the overlay's top-left.
  function realign(el, overlayRect) {
    var writes = writeCounts.get(el) || 0;
    if (writes >= MAX_WRITES) return;
    var r = el.getBoundingClientRect();
    if (!r.width) return;
    var dx = r.left - overlayRect.left;
    var dy = r.top - overlayRect.top;
    if (Math.abs(dx) <= TOLERANCE && Math.abs(dy) <= TOLERANCE) return;
    var m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
    var curX = m ? parseFloat(m[1]) : 0;
    var curY = m ? parseFloat(m[2]) : 0;
    el.style.transform = 'translate(' + (curX - dx) + 'px, ' + (curY - dy) + 'px)';
    writeCounts.set(el, writes + 1);
    trace('realigned <' + el.tagName + ' ' + el.className + '> by (' + -dx + ', ' + -dy + ') px, write #' + (writes + 1));
  }

  // Realigns every GSI widget; returns whether any exist (stay active).
  function fix() {
    var frames = document.querySelectorAll(SEL);
    for (var i = 0; i < frames.length; i++) {
      try {
        var overlay = overlayAncestor(frames[i]);
        if (!overlay) { traceSkip('no overlay ancestor'); continue; }
        var or = overlay.getBoundingClientRect();
        if (!or.width) { traceSkip('overlay zero width'); continue; }
        var w = widgetRoot(frames[i], overlay, or);
        if (!w) { traceSkip('no widget root'); continue; }
        // The container itself usually sits flush with the overlay; it is
        // the CHILDREN (visual iframe + click-catcher) that Gecko lays out
        // ~40px below it. Realign the container first, then every child,
        // each to the overlay's top-left.
        realign(w, or);
        for (var c = 0; c < w.children.length; c++) realign(w.children[c], or);
      } catch (e) {
        trace('fix error: ' + (e && e.message) + ' ' + (e && e.stack ? String(e.stack).split('\n')[0] : ''));
      }
    }
    return frames.length > 0;
  }

  var active = false;
  var observer = new MutationObserver(schedule);

  // observe() on the same node replaces the previous options.
  function setActive(on) {
    active = on;
    observer.observe(
      document.documentElement,
      on
        ? { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] }
        : { childList: true, subtree: true }
    );
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      if (active) {
        if (!fix()) {
          setActive(false);
          trace('GSI iframe gone, back to idle');
        }
      } else if (document.querySelector(SEL)) {
        setActive(true);
        trace('GSI iframe detected, watching alignment');
        fix();
      }
    });
  }

  window.addEventListener(
    'resize',
    function () {
      writeCounts = new WeakMap();
      schedule();
    },
    true
  );

  setActive(false);
  schedule();
})();
