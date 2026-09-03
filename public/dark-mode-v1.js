// ════════════════════════════════════════════════════════════════════
//  DARK MODE TOGGLE
//  Persists in localStorage (survives across tabs/sessions, unlike the
//  welcome-splash sessionStorage flag). Falls back to OS preference for a
//  first-time visitor who hasn't chosen explicitly.
// ════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var KEY = 'ef_theme';

  function getPreferred() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (_) {}
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = theme === 'dark' ? '\u2600\uFE0F' : '\u{1F319}'; // sun to switch to light, moon to switch to dark
    if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function toggle() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (_) {}
    apply(next);
  }

  // apply immediately (before paint) to avoid a flash of the wrong theme
  apply(getPreferred());

  function injectButton() {
    if (document.getElementById('theme-toggle-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'theme-toggle-btn';
    btn.type = 'button';
    btn.setAttribute('data-no-invert', '');
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    apply(document.documentElement.getAttribute('data-theme') || 'light');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }
})();
