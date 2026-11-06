/* ============================================================================
   Tests for the light/dark theme.

   What must stay true:
     * both themes define the same CSS tokens, so nothing falls back to a dark
       value in light mode (that is how half-themed pages happen);
     * the tile colours are the reference colours (dimkadimon/2048Multi) and are
       shared by both themes — a theme never changes a tile;
     * a saved choice beats the system preference, which beats the default;
     * applying a theme sets data-theme, the theme-color meta and the button.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let pass = 0;
let fail = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    results.push('  ✓ ' + name);
  } catch (e) {
    fail++;
    results.push('  ✗ ' + name + '\n      ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ---------- the reference palette ---------- */

const GOLD = '#f2b179';   // square line (dimkadimon/2048Multi .tile-2)
const SKY = '#99d6ff';    // hex line (.tile-3)
const APEX = '#edc22e';   // a finished line (classic 2048 gold)

/* ---------- 1. the stylesheet ---------- */

function tokens(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error('selector not found: ' + selector);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out = {};
  body.replace(/(--[\w-]+)\s*:\s*([^;]+);/g, (m, k, v) => { out[k] = v.trim(); });
  return out;
}

test('the two lines and the apex use the reference colours', () => {
  const css = read('style.css');
  const dark = tokens(css, ':root {');
  assert(dark['--two'].toLowerCase() === GOLD, '--two should be the reference gold, got ' + dark['--two']);
  assert(dark['--three'].toLowerCase() === SKY, '--three should be the reference sky, got ' + dark['--three']);
  assert(dark['--apex'].toLowerCase() === APEX, '--apex should be the classic yellow, got ' + dark['--apex']);
});

test('light mode overrides every token that a theme is expected to change', () => {
  const css = read('style.css');
  const root = tokens(css, ':root {');
  const light = tokens(css, ':root[data-theme="light"]');
  assert(Object.keys(light).length > 20, 'light block looks empty: ' + Object.keys(light).length);
  // the line colours are shared on purpose: the tiles are identical in both
  // themes, so --two/--three/--apex are declared once, in :root
  const shared = ['--two', '--three', '--apex', '--good'];
  const missing = Object.keys(root).filter((k) => !(k in light) && !shared.includes(k));
  assert(missing.length === 0, 'light mode is missing: ' + missing.join(', '));
});

test('light mode is the classic 2048 page, not a dark value in disguise', () => {
  const css = read('style.css');
  const dark = tokens(css, ':root {');
  const light = tokens(css, ':root[data-theme="light"]');
  assert(light['--bg0'].toLowerCase() === '#faf8ef', 'light page should be #faf8ef, got ' + light['--bg0']);
  // the chrome tokens must actually differ, or "light mode" would be a no-op
  const same = ['--bg0', '--panel', '--txt', '--dim', '--line', '--field']
    .filter((k) => (dark[k] || '').toLowerCase() === (light[k] || '').toLowerCase());
  assert(same.length === 0, 'these tokens are identical in both themes: ' + same.join(', '));
});

test('no dark-literal colours are left outside the token blocks', () => {
  const css = read('style.css');
  const stripped = css
    .replace(/:root\s*\{[^}]*\}/g, '')
    .replace(/:root\[data-theme="light"\]\s*\{[^}]*\}/g, '');
  const offenders = ['#05070f', '#0b0f22', '#e8ecff', '#929ac4', '#7c8cff', 'rgba(124, 140, 255']
    .filter((c) => stripped.toLowerCase().includes(c.toLowerCase()));
  assert(offenders.length === 0, 'dark values leak into the rules: ' + offenders.join(', '));
});

/* ---------- 2. the canvas palette ---------- */

test('every tile is one of the three reference colours, in both themes', () => {
  const js = read('game.js');
  const block = js.slice(js.indexOf('const COLORS = {'), js.indexOf('function colorFor'));
  assert(block.includes('two:') && block.includes('three:'), 'COLORS block not found');
  const hexes = (block.match(/#[0-9a-fA-F]{6}/g) || []).map((h) => h.toLowerCase());
  assert(hexes.length === 0, 'COLORS should reference GOLD/SKY/APEX, found literals: ' + hexes.join(', '));

  const consts = {};
  ['GOLD', 'SKY', 'APEX'].forEach((n) => {
    const m = js.match(new RegExp('const ' + n + "\\s*=\\s*'(#[0-9a-fA-F]{6})'"));
    assert(m, 'missing colour constant ' + n);
    consts[n] = m[1].toLowerCase();
  });
  assert(consts.GOLD === GOLD && consts.SKY === SKY && consts.APEX === APEX,
    'constants are ' + JSON.stringify(consts));

  // and the fallbacks (values past the end of the map) are the line colour too
  assert(/line === 'two' \? GOLD : SKY/.test(js), 'the fallback colour should follow the line');
});

test('the old per-value rainbow palette is gone', () => {
  const js = read('game.js');
  const retired = ['#fbbf24', '#f59e0b', '#fb923c', '#38bdf8', '#a3e635', '#d946ef', '#8b5cf6'];
  const found = retired.filter((c) => js.includes(c));
  assert(found.length === 0, 'the old tile colours are still in game.js: ' + found.join(', '));
});

test('the board itself is themed, and both themes provide every board colour', () => {
  const js = read('game.js');
  const block = js.slice(js.indexOf('const THEMES = {'), js.indexOf('let THEME ='));
  const darkStart = block.indexOf('dark: {');
  const lightStart = block.indexOf('light: {');
  assert(darkStart >= 0 && lightStart > darkStart, 'THEMES needs a dark and a light block');
  const keyOf = (txt) => [...txt.matchAll(/(\w+):/g)].map((m) => m[1]);
  const darkKeys = keyOf(block.slice(darkStart, lightStart)).filter((k) => k !== 'dark');
  const lightKeys = keyOf(block.slice(lightStart)).filter((k) => k !== 'light');
  const missing = [...new Set(darkKeys)].filter((k) => !lightKeys.includes(k));
  assert(missing.length === 0, 'light board is missing: ' + missing.join(', '));
  // the classic board colour from the reference game
  assert(block.slice(lightStart).includes('#bbada0'), 'light board should be #bbada0');
});

test('game.js has no hardcoded board colours left', () => {
  const js = read('game.js');
  // the theme blocks and the palette constants are the only place colours live
  const body = js
    .replace(/const THEMES = \{[\s\S]*?\n  \};/, '')
    .replace(/const COLORS = \{[\s\S]*?\n  \};/, '');
  const offenders = ['#141a3a', '#0d1230', '#2b3360', '#1a2044', '#e8ecff', '#929ac4', '#f8fafc']
    .filter((c) => body.includes(c));
  assert(offenders.length === 0, 'hardcoded board colours outside the theme: ' + offenders.join(', '));
});

/* ---------- 3. the theme module ---------- */

function sandbox(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const attrs = {};
  const meta = { content: '#070a16', setAttribute: (k, v) => { if (k === 'content') meta.content = v; } };
  const button = {
    textContent: '', _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, f) { (this._h = this._h || {})[t] = f; },
    click() { this._h && this._h.click && this._h.click({ preventDefault() {} }); }
  };
  const document = {
    readyState: 'complete',
    documentElement: {
      _attrs: Object.assign({}, attrs),
      setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] || null; },
      style: {}
    },
    querySelector: (sel) => (sel.indexOf('theme-color') >= 0 ? meta : null),
    querySelectorAll: () => [button],
    addEventListener() {}
  };
  const listeners = {};
  const window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    matchMedia: (q) => ({ matches: q.indexOf('light') >= 0 ? !!opts.prefersLight : false, addEventListener() {}, addListener() {} }),
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent(e) { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
  };
  const ctx = { window, document, console, module: { exports: {} }, exports: {} };
  ctx.window.window = window;
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(read('theme.js'), ctx);
  return { api: ctx.window.Theme, document, button, meta, store, window };
}

test('with no saved choice the system preference decides', () => {
  assert(sandbox({ prefersLight: true }).api.current() === 'light', 'a light system should give light');
  assert(sandbox({ prefersLight: false }).api.current() === 'dark', 'a dark system should give dark');
});

test('a saved choice beats the system preference, in both directions', () => {
  assert(sandbox({ prefersLight: true, store: { 'dual2048-theme': 'dark' } }).api.current() === 'dark',
    'saved dark should beat a light system');
  assert(sandbox({ prefersLight: false, store: { 'dual2048-theme': 'light' } }).api.current() === 'light',
    'saved light should beat a dark system');
});

test('a nonsense saved value is ignored rather than applied', () => {
  const { api } = sandbox({ prefersLight: true, store: { 'dual2048-theme': 'neon' } });
  assert(api.current() === 'light', 'stored value should be rejected, got ' + api.current());
});

test('applying a theme sets the attribute, the meta colour and the button', () => {
  const { api, document, button, meta } = sandbox({ prefersLight: false });
  api.apply('light');
  assert(document.documentElement.getAttribute('data-theme') === 'light', 'data-theme not set');
  assert(document.documentElement.style.colorScheme === 'light', 'color-scheme not set');
  assert(meta.content === '#faf8ef', 'theme-color should follow the theme, got ' + meta.content);
  assert(button.textContent === '☾', 'button should offer dark mode, got ' + button.textContent);
  assert(button.getAttribute('title') === 'Dark mode', 'button title not updated');
  assert(button.getAttribute('aria-pressed') === 'true', 'aria-pressed should reflect light mode');
  api.apply('dark');
  assert(document.documentElement.getAttribute('data-theme') === 'dark', 'data-theme not switched back');
  assert(meta.content === '#070a16', 'theme-color not switched back');
  assert(button.textContent === '☀', 'button should offer light mode');
});

test('toggling saves the choice and announces the change to the game', () => {
  const { api, store, window } = sandbox({ prefersLight: false });
  let seen = null;
  window.addEventListener('dual2048:theme', (e) => { seen = e.detail.theme; });
  api.toggle();
  assert(store['dual2048-theme'] === 'light', 'the choice was not saved');
  assert(seen === 'light', 'the game was not told about the new theme');
  api.toggle();
  assert(store['dual2048-theme'] === 'dark', 'toggling back was not saved');
  assert(seen === 'dark', 'the second switch was not announced');
});

test('both pages load theme.js before the game, and offer a toggle', () => {
  ['index.html', 'board.html'].forEach((f) => {
    const html = read(f);
    assert(html.includes('theme.js?v='), f + ' does not load theme.js');
    assert(html.includes('data-theme-toggle'), f + ' has no toggle button');
    assert(html.includes("localStorage.getItem('dual2048-theme')"), f + ' does not set the theme before first paint');
    // the head script must set the attribute, not the body: no flash of dark
    const head = html.slice(0, html.indexOf('</head>'));
    assert(head.includes('setAttribute(\'data-theme\''), f + ' sets the theme too late');
    const css = html.indexOf('style.css');
    const js = html.indexOf('theme.js');
    if (css >= 0) assert(js > css, f + ' should set the theme as early as the stylesheet');
  });
});

/* ---------- report ---------- */

console.log(results.join('\n'));
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
