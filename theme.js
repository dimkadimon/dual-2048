/* ============================================================================
   DUAL 2048 — theme (light / dark)

   The tile colours never change: both themes use the same gold square line and
   sky-blue hex line (see COLORS in game.js). A theme only swaps the board, the
   page and the chrome around the tiles — light mode is the classic 2048 palette
   from dimkadimon/2048Multi.

   Applied as data-theme on <html> BEFORE first paint (the inline snippet in the
   <head> calls Theme.apply()), so a light-mode player never sees a dark flash.
   ========================================================================== */

(function (root) {
  'use strict';

  var KEY = 'dual2048-theme';
  var THEMES = ['dark', 'light'];
  var THEME_COLOR = { dark: '#070a16', light: '#faf8ef' };

  function stored() {
    try {
      var v = root.localStorage && root.localStorage.getItem(KEY);
      return THEMES.indexOf(v) >= 0 ? v : null;
    } catch (e) { return null; }
  }

  function prefersLight() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches);
    } catch (e) { return false; }
  }

  /* saved choice first, then the system preference, then dark */
  function current() {
    return stored() || (prefersLight() ? 'light' : 'dark');
  }

  function document_() {
    return typeof document === 'undefined' ? null : document;
  }

  function apply(theme) {
    var doc = document_();
    var t = THEMES.indexOf(theme) >= 0 ? theme : current();
    if (doc) {
      doc.documentElement.setAttribute('data-theme', t);
      doc.documentElement.style.colorScheme = t;
      var meta = doc.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', THEME_COLOR[t]);
      // the padlock/haptic affordances of buttons do not change; only hues do
      var btns = doc.querySelectorAll('[data-theme-toggle]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].textContent = t === 'dark' ? '☀' : '☾';
        btns[i].setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
        btns[i].setAttribute('title', t === 'dark' ? 'Light mode' : 'Dark mode');
        btns[i].setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
      }
    }
    return t;
  }

  function set(theme) {
    var t = THEMES.indexOf(theme) >= 0 ? theme : 'dark';
    try { root.localStorage && root.localStorage.setItem(KEY, t); } catch (e) { /* private mode */ }
    apply(t);
    // tell the game to redraw its canvas in the new theme
    try {
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('dual2048:theme', { detail: { theme: t } }));
      }
    } catch (e) { /* older browsers */ }
    return t;
  }

  function toggle() { return set(current() === 'dark' ? 'light' : 'dark'); }

  /* wire every [data-theme-toggle] button on the page */
  function wire() {
    var doc = document_();
    if (!doc) return;
    var btns = doc.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.preventDefault();
        toggle();
      });
    }
    // follow the system while the player has not made an explicit choice
    try {
      if (root.matchMedia) {
        var mq = root.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () { if (!stored()) apply(current()); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      }
    } catch (e) { /* no matchMedia */ }
    apply(current());
  }

  var API = {
    KEY: KEY,
    THEMES: THEMES,
    THEME_COLOR: THEME_COLOR,
    current: current,
    stored: stored,
    apply: apply,
    set: set,
    toggle: toggle,
    wire: wire
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.Theme = API;

  if (document_() && document_.readyState !== 'loading') wire();
  else if (document_()) document_.addEventListener('DOMContentLoaded', wire);
})(typeof window !== 'undefined' ? window : null);
