// ════════════════════════════════════════════════════════════════════
//  ENGAGEMENT BEACON
//  Minimal, best-effort client-reach tracking used by Administration >
//  Client Reach & Engagement. No third-party tracking — everything goes to
//  our own /api/analytics/event endpoint and is tied to the signed-in user.
// ════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var ENDPOINT = '/api/analytics/event';
  var path = location.pathname;
  var startedAt = Date.now();
  var thresholdsSent = {};

  function send(type, value) {
    var body = JSON.stringify({ type: type, path: path, value: value });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch (_) {}
    try {
      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    } catch (_) {}
  }

  function scrollDepthPct() {
    var doc = document.documentElement;
    var scrollable = Math.max(1, (doc.scrollHeight || 0) - (window.innerHeight || 0));
    var pct = ((window.scrollY || doc.scrollTop || 0) / scrollable) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  function checkScroll() {
    var pct = scrollDepthPct();
    [25, 50, 75, 100].forEach(function (t) {
      if (pct >= t && !thresholdsSent[t]) { thresholdsSent[t] = true; send('SCROLL_DEPTH', t); }
    });
  }

  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () { scrollTimer = null; checkScroll(); }, 400);
  }, { passive: true });

  function endSession() {
    send('SESSION_END', Math.round((Date.now() - startedAt) / 1000));
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') endSession();
  });
  window.addEventListener('pagehide', endSession);

  // initial pageview beacon
  send('PAGEVIEW', null);
})();
