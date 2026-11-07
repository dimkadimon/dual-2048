/* ============================================================
   DUAL 2048 — two lineages (2·4·8… and 3·6·12…), walls, juice.
   Zero dependencies. Canvas board + HTML HUD/overlays.
   ============================================================ */
'use strict';
(function () {

  /* ================= PURE LOGIC (headless-testable) ================= */

  const N = 4;
  const DIRS = [
    { r: -1, c: 0 }, // 0 up
    { r: 0, c: 1 },  // 1 right
    { r: 1, c: 0 },  // 2 down
    { r: 0, c: -1 }  // 3 left
  ];
  const idx = (r, c) => r * N + c;
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function traversal(vec) {
    const rows = [0, 1, 2, 3], cols = [0, 1, 2, 3];
    if (vec.r === 1) rows.reverse();
    if (vec.c === 1) cols.reverse();
    return { rows, cols };
  }

  const Logic = {
    N, DIRS, idx, inB,

    createState() {
      return { grid: new Array(N * N).fill(null), score: 0, maxTile: 0, won: false, over: false, moves: 0 };
    },

    /* The number of walls is the game's MODE: 0 = easy, 1 = medium, 2 = hard.
       Hard is the original game and the default, so nothing changes for the
       existing board and tests. */
    newGame(st, rng = Math.random, walls = 2) {
      st.grid = new Array(N * N).fill(null);
      st.score = 0; st.maxTile = 0; st.won = false; st.over = false; st.moves = 0;
      this.placeWalls(st, rng, walls);
      this.spawn(st, rng);
      this.spawn(st, rng);
      return st;
    },

    /* Where medium's single wall may sit: the middle of each rim, never a
       corner. A wall in a corner barely changes the board, so medium looked
       like easy; an edge wall actually splits a row or column. */
    MEDIUM_WALL_CELLS: [[0, 1], [0, 2], [1, 0], [1, 3], [2, 0], [2, 3], [3, 1], [3, 2]],

    /* Walls sit in distinct rows and distinct columns, so every row and column
       keeps at least one free cell. 0 walls (easy) places none. */
    placeWalls(st, rng = Math.random, walls = 2) {
      const n = Math.max(0, Math.min(4, Math.floor(Number(walls) || 0)));
      if (!n) return;
      if (n === 1) {
        // medium: one wall, edge-only (see MEDIUM_WALL_CELLS)
        const spots = this.MEDIUM_WALL_CELLS;
        let pick = Math.floor(rng() * spots.length);
        if (!(pick >= 0 && pick < spots.length)) pick = 0;
        st.grid[idx(spots[pick][0], spots[pick][1])] = { wall: true };
        return;
      }
      const rows = shuffle([0, 1, 2, 3], rng).slice(0, n);
      const cols = shuffle([0, 1, 2, 3], rng).slice(0, n);
      for (let i = 0; i < n; i++) st.grid[idx(rows[i], cols[i])] = { wall: true };
    },

    emptyCells(st) {
      const out = [];
      for (let i = 0; i < N * N; i++) if (!st.grid[i]) out.push(i);
      return out;
    },

    spawn(st, rng = Math.random) {
      const e = this.emptyCells(st);
      if (!e.length) return null;
      const i = e[Math.floor(rng() * e.length)];
      const line = rng() < 0.5 ? 'two' : 'three';
      const v = rng() < 0.72 ? (line === 'two' ? 2 : 3) : (line === 'two' ? 4 : 6);
      const t = { v, line, r: Math.floor(i / N), c: i % N, merged: false };
      st.grid[i] = { t };
      return t;
    },

    /* Returns { moved, gained, events:[{type:'merge', r,c, fromR,fromC, v, line, newV, absorbed}] } */
    move(st, dir) {
      const v = DIRS[dir];
      const tr = traversal(v);
      const events = [];
      let moved = false, gained = 0;

      for (let i = 0; i < st.grid.length; i++) {
        const cell = st.grid[i];
        if (cell && cell.t) cell.t.merged = false;
      }

      for (const r of tr.rows) {
        for (const c of tr.cols) {
          const cell = st.grid[idx(r, c)];
          if (!cell || !cell.t) continue;
          const tile = cell.t;

          // slide as far as possible (walls & tiles block)
          let fr = r, fc = c;
          for (;;) {
            const nr = fr + v.r, nc = fc + v.c;
            if (!inB(nr, nc) || st.grid[idx(nr, nc)]) break;
            fr = nr; fc = nc;
          }

          const nr = fr + v.r, nc = fc + v.c;
          let didMerge = false;
          if (inB(nr, nc)) {
            const next = st.grid[idx(nr, nc)];
            if (next && next.t && !next.t.merged &&
                next.t.line === tile.line && next.t.v === tile.v) {
              const newV = tile.v * 2;
              next.t.v = newV;
              next.t.merged = true;
              st.grid[idx(r, c)] = null;
              gained += newV;
              if (newV > st.maxTile) st.maxTile = newV;
              if ((tile.line === 'two' && newV >= 2048) || (tile.line === 'three' && newV >= 3072)) st.won = true;
              events.push({ type: 'merge', r: nr, c: nc, fromR: r, fromC: c, v: tile.v, line: tile.line, newV, absorbed: tile });
              didMerge = true; moved = true;
            }
          }
          if (!didMerge && (fr !== r || fc !== c)) {
            st.grid[idx(r, c)] = null;
            tile.r = fr; tile.c = fc;
            st.grid[idx(fr, fc)] = { t: tile };
            moved = true;
          }
        }
      }
      st.score += gained;
      return { moved, gained, events };
    },

    hasMoves(st) {
      for (let i = 0; i < N * N; i++) if (!st.grid[i]) return true;
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const cell = st.grid[idx(r, c)];
          if (!cell || !cell.t) continue;
          const t = cell.t;
          if (c + 1 < N) {
            const n = st.grid[idx(r, c + 1)];
            if (n && n.t && n.t.line === t.line && n.t.v === t.v) return true;
          }
          if (r + 1 < N) {
            const n = st.grid[idx(r + 1, c)];
            if (n && n.t && n.t.line === t.line && n.t.v === t.v) return true;
          }
        }
      }
      return false;
    }
  };

  /* Headless helpers for the per-mode local table (see test-modes.js). */
  /* Only easy and medium get their own key; anything else (hard, a missing
     mode, a stale value in localStorage) is hard, exactly like normMode(). */
  function perModeKey(base, m) { return (m === 'easy' || m === 'medium') ? base + '.' + m : base; }
  Logic.localKeyFor = function (m, legacyKey) { return perModeKey(legacyKey || 'dual2048.local.v2', m); };
  Logic.bestKeyFor = function (m, legacyKey) { return perModeKey(legacyKey || 'dual2048.best.v2', m); };
  /* Rows of one mode's table, best first, as the leaderboard shows them. */
  Logic.localRows = function (rawByKey, m) {
    var rows = rawByKey && rawByKey[Logic.localKeyFor(m)];
    if (!Array.isArray(rows)) return [];
    return rows.slice().sort(function (a, b) { return (b.s || 0) - (a.s || 0); }).slice(0, 10)
      .map(function (e) { return { name: e.n, score: e.s, maxTile: e.t }; });
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof globalThis !== 'undefined') globalThis.DuoLogic = Logic;
  if (typeof document === 'undefined') return; // headless: logic only

  /* ================= CONFIG / THEME ================= */

  const ANIM = 105;        // slide ms
  const SPAWN = 170;       // spawn pop ms
  const POP = 210;         // merge pop ms
  const GHOST_LIFE = ANIM + 30;

  /* Tile colours come from the reference game (dimkadimon/2048Multi): one solid
     gold for every square-line tile, one solid sky blue for every hex-line tile,
     and the classic yellow for a finished line. They are the same in light and
     dark mode — a theme changes the board and the page, never the tiles. */
  const GOLD = '#f2b179';
  const SKY  = '#99d6ff';
  const APEX = '#edc22e';
  const COLORS = {
    two:   { 2:GOLD, 4:GOLD, 8:GOLD, 16:GOLD, 32:GOLD, 64:GOLD,
             128:GOLD, 256:GOLD, 512:GOLD, 1024:GOLD, 2048:APEX,
             4096:APEX, 8192:APEX, 16384:APEX },
    three: { 3:SKY, 6:SKY, 12:SKY, 24:SKY, 48:SKY, 96:SKY,
             192:SKY, 384:SKY, 768:SKY, 1536:SKY, 3072:APEX,
             6144:APEX, 12288:APEX, 24576:APEX }
  };

  function colorFor(v, line) {
    const map = COLORS[line];
    return map[v] || (line === 'two' ? GOLD : SKY);
  }

  /* Everything around the tiles: the board, the empty cells, the walls, the
     floating text. Light mode is the classic 2048 board (#bbada0) from the same
     reference game, so the shared tile colours sit on the same backdrop there. */
  const THEMES = {
    dark: {
      board0: '#141a3a', board1: '#0d1230', boardEdge: 'rgba(124,140,255,0.18)',
      cell: 'rgba(10,14,36,0.55)', cellEdge: 'rgba(0,0,0,0)',
      wall0: '#2b3360', wall1: '#1a2044', wallStripe: 'rgba(129,144,255,0.14)',
      wallEdge: 'rgba(140,155,255,0.35)',
      tileEdge: 'rgba(255,255,255,0.22)', tileTop: 0.22, tileBottom: 0.16,
      tileText: '#f9f6f2', apexText: '#5c4a13',
      floaterEdge: 'rgba(5,8,20,0.8)', floater: '#f8fafc', nudge: '#f87171',
      share: ['#141a3a', '#070a16'], shareTitle: '', shareInk: '#e8ecff',
      shareDim: '#929ac4', particle: '#ffffff',
      spark: ['#f2b179', '#99d6ff']
    },
    light: {
      board0: '#bbada0', board1: '#bbada0', boardEdge: 'rgba(143,122,102,0.35)',
      cell: 'rgba(238,228,218,0.35)', cellEdge: 'rgba(0,0,0,0)',
      wall0: '#a89484', wall1: '#8f7a66', wallStripe: 'rgba(255,255,255,0.16)',
      wallEdge: 'rgba(120,103,89,0.55)',
      tileEdge: 'rgba(255,255,255,0.55)', tileTop: 0.18, tileBottom: 0.1,
      tileText: '#f9f6f2', apexText: '#5c4a13',
      floaterEdge: 'rgba(250,248,239,0.9)', floater: '#55493f', nudge: '#e05a5a',
      share: ['#faf8ef', '#f2e9df'], shareTitle: '', shareInk: '#55493f',
      shareDim: '#8b8079', particle: '#ffffff',
      spark: ['#f2b179', '#99d6ff']
    }
  };

  let THEME = 'dark';
  function theme() { return THEMES[THEME] || THEMES.dark; }

  /* Start from whatever theme.js already put on <html> (it runs in the <head>,
     before first paint), then follow every later switch. */
  try {
    const html = document.documentElement;
    if (html && html.getAttribute('data-theme') === 'light') THEME = 'light';
  } catch (e) { /* no document */ }
  try {
    window.addEventListener('dual2048:theme', (e) => {
      setTheme(e && e.detail && e.detail.theme);
      // repaint straight away: the canvas is not redrawn while the menu is up
      if (typeof draw === 'function') draw(typeof performance !== 'undefined' ? performance.now() : Date.now());
    });
  } catch (e) { /* no window */ }

  function setTheme(name) {
    THEME = name === 'light' ? 'light' : 'dark';
    return THEME;
  }

  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixRgb(rgb, target, amt) {
    return rgb.map((c, i) => Math.round(c + (target - c) * amt));
  }
  function rgbCss(rgb, a = 1) {
    return a >= 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  }
  function lighten(hex, amt) { return rgbCss(mixRgb(hexToRgb(hex), 255, amt)); }
  function darken(hex, amt) { return rgbCss(mixRgb(hexToRgb(hex), 0, amt)); }
  function textOn(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#10142b' : '#f4f6ff';
  }

  /* ================= DOM ================= */

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const elScore = $('score');
  const elBest = $('best');
  const elNameChip = $('nameChip');
  const startScreen = $('startScreen');
  const pauseScreen = $('pauseScreen');
  const overScreen = $('overScreen');
  const winToast = $('winToast');
  const nameInput = $('nameInput');

  /* ================= STORAGE ================= */

  function lsGet(k, dflt) { try { const v = localStorage.getItem(k); return v === null ? dflt : v; } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsJSON(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch (e) { return dflt; } }

  /* ---------- MODE ----------
     0 walls = easy, 1 = medium, 2 = hard. Hard is the default and the original
     game, and it is where every score that existed before modes lives. Each
     mode has its own best score, its own global board and its own pending
     queue, so switching modes can never mix two boards. */
  const MODES = (typeof Leaderboard !== 'undefined' && Leaderboard.MODES) || {
    easy: { id: 'easy', walls: 0, label: 'Easy' },
    medium: { id: 'medium', walls: 1, label: 'Medium' },
    hard: { id: 'hard', walls: 2, label: 'Hard' }
  };
  const MODE_ORDER = (typeof Leaderboard !== 'undefined' && Leaderboard.MODE_ORDER) || ['easy', 'medium', 'hard'];
  const LS_MODE = 'dual2048.mode.v1';
  function normMode(m) { return MODES[m] ? m : 'hard'; }

  /* Switching mode swaps the whole board context: the best score, the cached
     global list and the pending queue are all per mode, so nothing leaks
     across. The demo board behind the menu is rebuilt with the new wall count. */
  function setMode(next, opts) {
    const m = normMode(next);
    if (m === mode && !(opts && opts.force)) return mode;
    mode = m;
    lsSet(LS_MODE, mode);
    best = parseInt(lsGet(bestKey(mode), '0'), 10) || 0;
    globalCache = [];
    hydrateGlobal();
    updateHud();
    renderLocal();
    renderGlobal();
    // every in-game leaderboard says which mode it is showing
    document.querySelectorAll('[data-mode-label]').forEach((el) => { el.textContent = MODES[mode].label; });
    ['lbModeStart', 'lbModeOver'].forEach((id) => {
      const el = $(id);
      if (el) { el.textContent = MODES[mode].label; el.className = 'lb-mode mode-' + mode; }
    });
    const chip = $('modeChip');
    if (chip) {
      chip.textContent = MODES[mode].label + ' · ' + wallsLabel(mode);
      chip.className = 'chip mode-chip mode-' + mode;
      chip.setAttribute('title', 'Game mode — ' + MODES[mode].label + ' (' + wallsLabel(mode) + ')');
    }
    document.querySelectorAll('[data-mode]').forEach((b) => {
      const on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // a fresh demo board, so the menu shows the mode you are about to play
    if (gstate === 'start') {
      Logic.newGame(st, () => 0.42, MODES[mode].walls);
      ghosts = []; particles = []; floaters = [];
      const t0 = performance.now();
      let i = 0;
      forEachTile((t) => {
        t.fx = t.tx = cellX(t.c);
        t.fy = t.ty = cellY(t.r);
        t.animStart = t0;
        t.spawnT = t0 + 60 + i * 110;
        i++;
      });
    }
    fetchGlobal();
    return mode;
  }
  function wallsLabel(m) {
    const w = MODES[m].walls;
    return w === 0 ? 'no walls' : w === 1 ? '1 wall' : w + ' walls';
  }

  const LS_NAME = 'dual2048.name.v1';
  // v2 keys: old-rules (×3 hexes) scores are intentionally left behind so
  // YOUR BEST starts clean and matches the cleared global board.
  const LS_BEST = 'dual2048.best.v2';        // per mode: see bestKey()
  const LS_LOCAL = 'dual2048.local.v2';       // per mode: see localKey()
  const LS_MUTE = 'dual2048.muted.v1';

  /* ================= AUDIO (tiny synth, no assets) ================= */

  const Audio = {
    ctx: null,
    muted: lsGet(LS_MUTE, '0') === '1',
    ensure() {
      if (this.muted) return;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {}
    },
    tone(f, f2, dur, type, vol, delay = 0) {
      if (this.muted) return;
      this.ensure();
      if (!this.ctx) return;
      const c = this.ctx, t0 = c.currentTime + delay;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.03);
    },
    noise(dur, vol, delay = 0) {
      if (this.muted) return;
      this.ensure();
      if (!this.ctx) return;
      const c = this.ctx, t0 = c.currentTime + delay;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = c.createBufferSource(); s.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 700;
      const g = c.createGain(); g.gain.value = vol;
      s.connect(f).connect(g).connect(c.destination);
      s.start(t0);
    },
    slide() { this.noise(0.07, 0.05); },
    denied() { this.tone(140, 90, 0.09, 'square', 0.05); },
    spawn() { this.tone(880, 1200, 0.05, 'sine', 0.035); },
    merge(v, line) {
      const steps = Math.log2(v);
      const base = line === 'two' ? 300 : 360;
      const f = base * Math.pow(2, Math.min(steps, 11) / 11 * 0.9);
      this.tone(f, f * 1.5, 0.13, 'triangle', 0.16);
      this.tone(f * 2, f * 2.6, 0.09, 'sine', 0.07, 0.015);
      if (v >= 128) { this.tone(70, 45, 0.28, 'sine', 0.24); this.noise(0.16, 0.07); }
    },
    combo(n) { [0, 1, 2].slice(0, n).forEach((i) => this.tone(520 + i * 180, 700 + i * 200, 0.08, 'square', 0.05, i * 0.05)); },
    ui() { this.tone(500, 620, 0.05, 'square', 0.045); },
    win() { [0, 4, 7, 12, 16].forEach((s, i) => this.tone(440 * Math.pow(2, s / 12), null, 0.22, 'triangle', 0.13, i * 0.09)); },
    over() { [440, 349, 262, 196].forEach((f, i) => this.tone(f, f * 0.94, 0.3, 'sawtooth', 0.07, i * 0.16)); }
  };

  /* ================= GAME STATE ================= */

  let st = Logic.createState();
  let gstate = 'start';           // start | playing | paused | over
  let rng = Math.random;
  let ghosts = [];                // {x,y,tx,ty,start,v,line}
  let particles = [];             // {x,y,vx,vy,life,max,size,color,glow}
  let floaters = [];              // {x,y,vy,life,max,text,color,size}
  let timers = [];                // {at, fn}
  let shakeAmp = 0;
  let winShown = false;
  let winLine = 'two';
  let playerName = lsGet(LS_NAME, '');
  let mode = normMode(lsGet(LS_MODE, 'hard'));
  /* Hard keeps the historic key, so an existing player's best score carries
     over untouched; the other modes get their own. */
  const perMode = (base, m) => (m === 'easy' || m === 'medium') ? base + '.' + m : base;
  function bestKey(m) { return perMode(LS_BEST, m); }
  /* The local "your best" table is per mode too. Hard keeps the historic key, so
     every score this browser already recorded stays where it is; the other modes
     get their own table. */
  function localKey(m) { return perMode(LS_LOCAL, m); }
  function localList(m) {
    const rows = lsJSON(localKey(m), []);
    return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => (b.s || 0) - (a.s || 0)).slice(0, 10);
  }
  let best = parseInt(lsGet(bestKey(mode), '0'), 10) || 0;
  let lastTime = performance.now();
  let lastMoveStamp = 0;

  const MAX_PARTICLES = 340;

  /* ================= LAYOUT ================= */

  let L = { css: 480, dpr: 1, pad: 0, gap: 0, cell: 0 };
  function resize() {
    const rect = stage.getBoundingClientRect();
    const css = Math.max(220, Math.floor(Math.min(rect.width, rect.height || rect.width)));
    L.css = css;
    L.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(css * L.dpr);
    canvas.height = Math.floor(css * L.dpr);
    canvas.style.width = css + 'px';
    canvas.style.height = css + 'px';
    L.pad = css * 0.034;
    L.gap = css * 0.026;
    L.cell = (css - L.pad * 2 - L.gap * (N - 1)) / N;
  }
  const cellX = (c) => L.pad + c * (L.cell + L.gap);
  const cellY = (r) => L.pad + r * (L.cell + L.gap);

  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  resize();

  function forEachTile(fn) {
    for (let i = 0; i < st.grid.length; i++) {
      const cell = st.grid[i];
      if (cell && cell.t) fn(cell.t);
    }
  }

  /* ================= JUICE ================= */

  function burst(x, y, color, power) {
    const count = Math.min(34, 8 + Math.round(power));
    for (let i = 0; i < count; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 190) * (0.6 + power / 16);
      particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        life: 0, max: 0.42 + Math.random() * 0.4,
        size: L.cell * (0.02 + Math.random() * 0.045),
        color: Math.random() < 0.25 ? theme().particle : color,
        glow: true
      });
    }
  }

  function floater(x, y, text, color, size) {
    floaters.push({ x, y, vy: -60, life: 0, max: 0.9, text, color, size: size || L.cell * 0.3 });
  }

  function shake(amp) { shakeAmp = Math.min(18, shakeAmp + amp); }

  /* ================= MOVE ================= */

  function tileRenderPos(t, now) {
    if (t.animStart !== undefined && t.tx !== undefined) {
      const p = Math.min(1, (now - t.animStart) / ANIM);
      const e = 1 - Math.pow(1 - p, 3);
      return { x: t.fx + (t.tx - t.fx) * e, y: t.fy + (t.ty - t.fy) * e };
    }
    return { x: cellX(t.c), y: cellY(t.r) };
  }

  function doMove(dir) {
    if (gstate !== 'playing') return;
    const now = performance.now();
    if (now - lastMoveStamp < 45) return; // debounce insane key repeat
    lastMoveStamp = now;

    const snap = new Map();
    forEachTile((t) => snap.set(t, tileRenderPos(t, now)));

    const res = Logic.move(st, dir);
    if (!res.moved) { Audio.denied(); nudge(dir); return; }
    st.moves++;
    Audio.slide();

    forEachTile((t) => {
      const p = snap.get(t) || { x: cellX(t.c), y: cellY(t.r) };
      t.fx = p.x; t.fy = p.y;
      t.tx = cellX(t.c); t.ty = cellY(t.r);
      t.animStart = now;
    });

    res.events.forEach((ev) => {
      const target = st.grid[idxOf(ev.r, ev.c)].t;
      target.popStart = now + ANIM;
      const from = snap.get(ev.absorbed) || { x: cellX(ev.fromC), y: cellY(ev.fromR) };
      ghosts.push({ x: from.x, y: from.y, tx: cellX(ev.c), ty: cellY(ev.r), start: now, v: ev.v, line: ev.line });
      const cx = cellX(ev.c) + L.cell / 2, cy = cellY(ev.r) + L.cell / 2;
      const col = colorFor(ev.newV, ev.line);
      const power = Math.min(12, Math.log2(ev.newV));
      timers.push({
        at: now + ANIM,
        fn: () => {
          burst(cx, cy, col, power);
          floater(cx, cy - L.cell * 0.25, '+' + ev.newV, col);
          shake(1.6 + power * 0.75);
          Audio.merge(ev.newV, ev.line);
          bumpScore();
        }
      });
    });

    // combo bonus for multi-merge moves
    if (res.events.length > 1) {
      const bonus = Math.round(res.gained * 0.5 * (res.events.length - 1));
      st.score += bonus;
      const cx = L.css / 2, cy = L.css / 2;
      timers.push({
        at: now + ANIM + 60,
        fn: () => {
          floater(cx, cy, 'COMBO ×' + res.events.length + '  +' + bonus, theme().floater, L.cell * 0.34);
          shake(4);
          Audio.combo(res.events.length);
        }
      });
    }

    // spawn next tile (slightly delayed so it pops in behind the slide)
    const nt = Logic.spawn(st, rng);
    if (nt) {
      nt.fx = nt.tx = cellX(nt.c);
      nt.fy = nt.ty = cellY(nt.r);
      nt.animStart = now;
      nt.spawnT = now + ANIM * 0.55;
      timers.push({ at: nt.spawnT, fn: () => Audio.spawn() });
    }

    if (st.won && !winShown) {
      winShown = true;
      winLine = res.events[res.events.length - 1].line;
      timers.push({ at: now + ANIM + 120, fn: showWinToast });
    }

    if (!Logic.hasMoves(st)) {
      st.over = true;
      timers.push({ at: now + ANIM + 480, fn: gameOver });
    }

    updateHud();
  }

  function idxOf(r, c) { return r * N + c; }

  let nudgeDir = -1, nudgeStart = 0;
  function nudge(dir) { nudgeDir = dir; nudgeStart = performance.now(); }

  /* ================= GAME FLOW ================= */

  function startGame() {
    playerName = (nameInput.value || '').trim().slice(0, 16) || playerName || 'ANON';
    nameInput.value = playerName;
    lsSet(LS_NAME, playerName);
    elNameChip.textContent = playerName;

    rng = Math.random;
    Logic.newGame(st, rng, MODES[mode].walls);
    ghosts = []; particles = []; floaters = []; timers = [];
    shakeAmp = 0; winShown = false;

    const now = performance.now();
    let k = 0;
    forEachTile((t) => {
      t.fx = t.tx = cellX(t.c);
      t.fy = t.ty = cellY(t.r);
      t.animStart = now;
      t.spawnT = now + 60 + k * 110;
      k++;
    });

    gstate = 'playing';
    setScreen(null);
    updateHud();
    Audio.ensure();
    Audio.ui();
  }

  let pendingSubmit = null;

  function gameOver() {
    if (gstate === 'over') return;
    gstate = 'over';
    Audio.over();
    shake(12);

    const isRecord = st.score > best;
    if (isRecord) { best = st.score; lsSet(bestKey(mode), String(best)); }

    // local table for THIS mode (a game is always filed under the mode it was
    // played in, never under whichever mode is selected later)
    const local = lsJSON(localKey(mode), []);
    local.push({ n: playerName, s: st.score, t: st.maxTile, d: Date.now() });
    local.sort((a, b) => b.s - a.s);              // keep the full table, show the top 10
    lsSet(localKey(mode), JSON.stringify(local.slice(0, 50)));

    // phase 1: keep the final board visible with a review bar
    $('reviewScore').textContent = st.score.toLocaleString();
    $('reviewTile').textContent = st.maxTile || '—';
    $('reviewRecord').classList.toggle('hidden', !isRecord);
    setScreen('review');

    // pre-fill phase 2 (results screen)
    $('overScore').textContent = st.score.toLocaleString();
    $('overTile').textContent = st.maxTile || '—';
    $('overMoves').textContent = st.moves;
    $('overRecord').classList.toggle('hidden', !isRecord);

    // submit in the background so the board is ready when the user continues
    pendingSubmit = submitGlobal(playerName, st.score, st.maxTile).catch(() => null);

    updateHud();
  }

  async function showResults() {
    Audio.ui();
    setScreen('over');
    renderLocal();
    await (pendingSubmit || Promise.resolve(null)); // submit silently; the Global tab shows the outcome
    fetchGlobal();
  }

  function shareText() {
    return `I scored ${st.score.toLocaleString()} in Dual 2048 as ${playerName} — best tile ${st.maxTile}, ${st.moves} moves. ` + window.location.href;
  }

  /* Compose the final board + a score header into a shareable PNG. */
  function makeScreenshot() {
    return new Promise((resolve, reject) => {
      try {
        const scale = 2;
        const bw = L.css;
        const head = 96, foot = 30, padX = 20;
        const W = bw + padX * 2;
        const H = bw + head + foot;
        const c = document.createElement('canvas');
        c.width = Math.round(W * scale);
        c.height = Math.round(H * scale);
        const x = c.getContext('2d');
        if (!x || typeof c.toBlob !== 'function') { reject(new Error('no canvas export')); return; }
        x.scale(scale, scale);

        const T = theme();
        const bg = x.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, T.share[0]);
        bg.addColorStop(1, T.share[1]);
        x.fillStyle = bg;
        x.fillRect(0, 0, W, H);

        x.textAlign = 'center';
        const tg = x.createLinearGradient(0, 0, W, 0);
        tg.addColorStop(0, GOLD);
        tg.addColorStop(0.5, GOLD);
        tg.addColorStop(1, SKY);
        x.font = '900 30px "Trebuchet MS", system-ui, sans-serif';
        x.fillStyle = tg;
        x.fillText('Dual 2048', W / 2, 42);

        x.font = '700 15px "Trebuchet MS", system-ui, sans-serif';
        x.fillStyle = T.shareInk;
        x.fillText(`${playerName}  ·  score ${st.score.toLocaleString()}  ·  best tile ${st.maxTile || '—'}  ·  ${st.moves} moves`, W / 2, 70);

        x.drawImage(canvas, padX, head, bw, bw);

        x.font = '600 11px "Trebuchet MS", system-ui, sans-serif';
        x.fillStyle = T.shareDim;
        x.fillText(window.location.href, W / 2, H - 11);

        c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      } catch (e) {
        reject(e);
      }
    });
  }

  function shareScore() {
    Audio.ui();
    const blobPromise = makeScreenshot();
    const canFileShare = !!(navigator.canShare && navigator.share && window.File);

    if (!canFileShare && navigator.clipboard && window.ClipboardItem) {
      // Desktop: copy the PNG straight to the clipboard (promise-based item is Safari-friendly)
      navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blobPromise })])
        .then(() => showToast('Screenshot copied to clipboard 📸 — paste it anywhere!'))
        .catch(() => saveShot(blobPromise));
      return;
    }
    if (canFileShare) {
      // Mobile: native share sheet with the PNG attached
      blobPromise.then(async (blob) => {
        try {
          const file = new File([blob], `dual2048-${st.score}.png`, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: 'Dual 2048', text: `I scored ${st.score.toLocaleString()} in Dual 2048!` });
              return;
            } catch (e) {
              if (e && e.name === 'AbortError') return; // dismissed the sheet
            }
          }
          if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
            showToast('Screenshot copied to clipboard 📸');
            return;
          }
        } catch (e) { /* fall through */ }
        saveShot(Promise.resolve(blob));
      }).catch(() => saveShot(blobPromise));
      return;
    }
    saveShot(blobPromise);
  }

  async function saveShot(blobPromise) {
    let blob = null;
    try { blob = await blobPromise; } catch (e) { blob = null; }
    if (blob && URL.createObjectURL) {
      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dual2048-${playerName}-${st.score}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast('Screenshot saved as PNG 💾');
        return;
      } catch (e) { /* fall through */ }
    }
    try {
      await navigator.clipboard.writeText(shareText());
      showToast('Score text copied to clipboard 📋');
    } catch (e) {
      showToast(shareText());
    }
  }

  let toastTimer = null;
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.classList.add('hidden'), 350);
    }, 2400);
  }

  function togglePause(force) {
    if (gstate === 'playing' && force !== false) {
      gstate = 'paused';
      setScreen('pause');
      Audio.ui();
    } else if (gstate === 'paused' && force !== true) {
      gstate = 'playing';
      setScreen(null);
      lastTime = performance.now();
      Audio.ui();
    }
  }

  function toMenu() {
    gstate = 'start';
    setScreen('start');
    renderLocal();
    fetchGlobal();
    Audio.ui();
  }

  function showWinToast() {
    winToast.textContent = winLine === 'two' ? '★ 2048! Legendary merge! ★' : '★ 3072! Hex-lineage mastery! ★';
    winToast.classList.remove('hidden');
    winToast.classList.add('show');
    Audio.win();
    shake(10);
    for (let i = 0; i < 5; i++) {
      timers.push({
        at: performance.now() + i * 120,
        fn: () => burst(L.css * (0.2 + Math.random() * 0.6), L.css * (0.2 + Math.random() * 0.5), i % 2 ? GOLD : SKY, 10)
      });
    }
    setTimeout(() => { winToast.classList.remove('show'); setTimeout(() => winToast.classList.add('hidden'), 400); }, 2600);
  }

  function setScreen(which) {
    startScreen.classList.toggle('hidden', which !== 'start');
    pauseScreen.classList.toggle('hidden', which !== 'pause');
    overScreen.classList.toggle('hidden', which !== 'over');
    $('reviewBar').classList.toggle('hidden', which !== 'review');
  }

  function updateHud() {
    elScore.textContent = st.score.toLocaleString();
    elBest.textContent = Math.max(best, st.score).toLocaleString();
  }

  function bumpScore() {
    elScore.textContent = st.score.toLocaleString();
    elScore.classList.remove('bump');
    void elScore.offsetWidth;
    elScore.classList.add('bump');
  }

  /* ================= LEADERBOARDS ================= */

  /* Global scores use the shared write-once store (see leaderboard.js).
     Every finished game becomes ONE immutable record, so two players playing
     at the same time can never erase each other and a retry can never record
     the same play twice. Reads union the live records with the compacted
     archives, so nothing that was ever stored can disappear. */
  const LB = Leaderboard.create({
    bucket: Leaderboard.DEFAULT_BUCKET,
    storage: { get: (k) => lsGet(k), set: (k, v) => lsSet(k, v) }
  });
  // a stuck score must be delivered to the board it belongs to, so the queue
  // records the mode with the play and both are keyed per mode
  const LS_PENDING = 'dual2048-pending-v3';
  const HUB_API = 'https://dual-2048.onrender.com/api/scores'; // optional mirror/API
  const apiFor = (m) => HUB_API + '?mode=' + encodeURIComponent(normMode(m));

  function populateList(el, entries, emptyMsg) {
    if (!el) return;
    el.innerHTML = '';
    if (!entries.length) {
      el.innerHTML = `<li class="empty">${emptyMsg}</li>`;
      return;
    }
    entries.slice(0, 10).forEach((e, i) => {
      const li = document.createElement('li');
      if (playerName && e.name === playerName) li.className = 'me';
      li.innerHTML = `<span class="rk">${i + 1}</span><span class="nm">${escapeHtml(e.name)}</span>` +
        `<span class="bt">${e.maxTile || ''}</span><span class="sc">${(e.score || 0).toLocaleString()}</span>`;
      el.appendChild(li);
    });
  }

  function renderLocal() {
    const list = localList(mode).map((e) => ({ name: e.n, score: e.s, maxTile: e.t, mode }));
    const empty = 'No ' + MODES[mode].label.toLowerCase() + ' scores yet — be the first!';
    populateList($('localList'), list, empty);
    populateList($('overLocalList'), list, empty);
  }

  let globalCache = [];
  let globalTotal = 0;
  let globalQuality = '';
  const LS_GLOBAL = 'dual2048-global-v31';   // last board this browser saw (any source)
  const LS_DAYS = 'dual2048-days-v31';       // per-day archive rows, so the cache works

  /* A day cache the leaderboard core can use: day rows it has already seen are
     reused for ten minutes instead of being re-downloaded over and over (each
     re-download is a request against the store's per-IP limit). */
  const dayStore = (() => {
    let rows = {};
    try { rows = lsJSON(LS_DAYS, {}) || {}; } catch (e) { rows = {}; }
    const marks = {};
    let dirty = false;
    function save() {
      if (!dirty) return;
      try { lsSet(LS_DAYS, JSON.stringify(rows)); } catch (e) { /* full: drop it */ }
      dirty = false;
    }
    return {
      get: (k) => (Array.isArray(rows[k]) ? rows[k] : null),
      set: (k, list) => {
        rows[k] = list; marks[k] = Date.now(); dirty = true;
        const ks = Object.keys(rows);
        if (ks.length > 45) { dsorted: for (const old of ks.sort()) { if (ks.length <= 45) break; delete rows[old]; } }
        save();
      },
      mark: (k) => marks[k] || 0
    };
  })();

  const globalKey = (m) => LS_GLOBAL + '.' + normMode(m);
  function cacheGlobal() {
    try { lsSet(globalKey(mode), JSON.stringify(globalCache.slice(0, 3000))); } catch (e) { /* quota */ }
  }
  function hydrateGlobal() {
    const saved = lsJSON(globalKey(mode), []);
    if (Array.isArray(saved) && saved.length) globalCache = LB.merge(saved, globalCache);
    // the pre-modes cache is the hard board: keep those plays, never show them elsewhere
    if (mode === 'hard') {
      const legacy = lsJSON(LS_GLOBAL, []);
      if (Array.isArray(legacy) && legacy.length) globalCache = LB.merge(legacy, globalCache);
    }
  }

  async function timed(promise, ms) {
    return Promise.race([
      promise,
      new Promise((res) => setTimeout(() => res(null), ms))
    ]).catch(() => null);
  }

  /* Sources are asked IN PARALLEL and their results are unioned. Sequencing them
     (and stopping at the first that answered) is what made a score that only one
     source knew about disappear; a slow or rate-limited store must not delay or
     hide what the mirrors already have. */
  async function fetchGlobal() {
    const jobs = [
      // 1) the shared store — hall of fame (+ write-once records), a few requests
      (async () => {
        const r = await LB.read({ light: true, cache: dayStore, mode: mode });
        globalQuality = r.sources.quality;
        return r.entries;
      })(),
      // 2) this deployment's own API (only on a server deploy; 404 on Pages)
      (async () => {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch('/api/scores?mode=' + encodeURIComponent(mode), { signal: ctrl.signal });
        clearTimeout(to);
        if (!res.ok) return null;
        const data = await res.json();
        return (data.scores || []).length ? data.scores : null;
      })(),
      // 3) the archive committed in this repo (works even when the store refuses us)
      fetchArchive(),
      // 4) the hub API (a different host, so a store quota on this IP does not hide the board)
      (async () => {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(apiFor(mode), { signal: ctrl.signal });
        clearTimeout(to);
        if (!res.ok) return null;
        const data = await res.json();
        return (data.scores || []).length ? data.scores : null;
      })()
    ];
    const out = await Promise.all(jobs.map((p) => timed(p, 12000)));
    const got = out.filter((l) => Array.isArray(l) && l.length);
    if (got.length) {
      const before = globalCache.length;
      globalCache = LB.merge(globalCache, ...got).filter((e) => LB.modeOf(e) === mode);   // never shrinks
      globalTotal = globalCache.length;
      if (globalCache.length !== before) cacheGlobal();
      renderGlobal();
    } else if (!globalCache.length) {
      const msg = 'Leaderboard offline — try again later!';
      populateList($('globalList'), [], msg);
      populateList($('overGlobalList'), [], msg);
    }
  }

  async function fetchArchive() {
    // same-origin first (server.js serves public/), then the GitHub copy
    for (const url of ['archive.json', 'https://raw.githubusercontent.com/dimkadimon/dual-2048/main/public/archive.json']) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const list = await res.json();
        if (Array.isArray(list) && list.length) return list;
      } catch (e) { /* try the next mirror */ }
    }
    return [];
  }

  function renderGlobal() {
    const msg = 'No global scores yet — claim #1!';
    // include plays that are stored locally but not delivered yet, so a score
    // never looks lost to the player who just set it
    const top = LB.merge(globalCache, pendingAll()).slice(0, 100); // in-game shows the top 100; board.html shows the full archive
    populateList($('globalList'), top, msg);
    populateList($('overGlobalList'), top, msg);
  }

  /* Scores that could not be stored yet are kept here and delivered later —
     the record id is derived from the play's timestamp, so re-sending is
     idempotent (it re-writes the same record, it can never duplicate one). */
  function pendingAll() {
    return lsJSON(LS_PENDING, [])
      .map((e) => (e && e.mode == null ? Object.assign({}, e, { mode: 'hard' }) : e))
      .filter((e) => LB.modeOf(e) === mode);
  }
  function pendingAllModes() {
    return lsJSON(LS_PENDING, []).map((e) => (e && e.mode == null ? Object.assign({}, e, { mode: 'hard' }) : e));
  }
  const samePlay = (a, b) => a.ts === b.ts && a.name === b.name && LB.modeOf(a) === LB.modeOf(b);
  function pendingAdd(entry) {
    const list = pendingAllModes().filter((e) => !samePlay(e, entry));
    list.push(Object.assign({}, entry, { mode: LB.modeOf(entry) }));
    lsSet(LS_PENDING, JSON.stringify(list.slice(-50)));
  }
  function pendingDrop(entry) {
    lsSet(LS_PENDING, JSON.stringify(pendingAllModes().filter((e) => !samePlay(e, entry))));
  }
  let flushing = null;
  function flushPending() {
    if (flushing) return flushing;
    flushing = (async () => {
      const list = pendingAllModes();
      for (const e of list) {
        const out = await LB.submit(e, { id: e.ts + '-' + (e.name || '').slice(0, 4).replace(/\W/g, '') + 'r' });
        if (out.ok) pendingDrop(e); else break;   // still offline — keep them for later
        await new Promise((r) => setTimeout(r, 120));
      }
      flushing = null;
    })().catch(() => { flushing = null; });
    return flushing;
  }

  /* Anyone may compact — the lease in the store makes sure exactly one writer
     does it at a time. Running it from the client too means the archives stay
     current (and the ~30-day key expiry stays away) even when no server is up:
     a static deployment is fully self-maintaining. Throttled, and never
     awaited — it must not slow the game down. */
  const LS_COMPACT = 'dual2048-compact-at';
  function maybeCompact() {
    const last = Number(lsGet(LS_COMPACT, '0')) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    lsSet(LS_COMPACT, String(Date.now()));
    LB.compact({ quietMs: 60000 }).catch(() => {});
  }

  async function submitGlobal(name, score, maxTile) {
    if (!score) return null;
    const entry = { name, score, maxTile, ts: Date.now(), mode: mode };
    const out = await LB.submit(entry);
    if (!out.ok) pendingAdd(entry);            // never silently drop a score
    else maybeCompact();                       // keep the archives current
    // rank against what we last saw (+ this play) so the results screen is instant
    const merged = LB.merge(globalCache, [entry]);
    globalCache = merged;
    globalTotal = merged.length;
    const rank = merged.findIndex((e) => e.ts === entry.ts && e.name === entry.name) + 1;
    const isPB = !merged.some((e) => !(e.ts === entry.ts && e.name === entry.name) &&
      String(e.name).toLowerCase() === String(entry.name).toLowerCase() && e.score > entry.score);
    return { ok: out.ok, rank: rank || merged.length, total: merged.length, isPB, entry };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /* ================= RENDER ================= */

  function roundRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hexPath(cx, cy, rad) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 90);
      const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  function paintTile(cx, cy, s, v, line, now, alpha, glowMul) {
    if (s <= 1 || alpha <= 0) return;
    const col = colorFor(v, line);
    const isApex = (line === 'two' && v >= 2048) || (line === 'three' && v >= 3072);
    ctx.save();
    ctx.globalAlpha = alpha;

    // shape
    if (line === 'two') roundRectPath(cx - s / 2, cy - s / 2, s, s, s * 0.17);
    else hexPath(cx, cy, s * 0.53);

    // glow
    if (isApex) {
      const hue = (now / 9) % 360;
      ctx.shadowColor = `hsl(${hue},95%,65%)`;
      ctx.shadowBlur = s * (0.4 + 0.18 * Math.sin(now / 160));
    } else {
      ctx.shadowColor = col;
      ctx.shadowBlur = s * (0.16 + 0.3 * (glowMul || 0));
    }

    const T = theme();
    const g = ctx.createLinearGradient(cx, cy - s / 2, cx, cy + s / 2);
    g.addColorStop(0, lighten(col, T.tileTop));
    g.addColorStop(0.55, col);
    g.addColorStop(1, darken(col, T.tileBottom));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;

    // inner highlight
    ctx.strokeStyle = T.tileEdge;
    ctx.lineWidth = Math.max(1, s * 0.022);
    ctx.stroke();

    // value
    const fs = s * (v < 100 ? 0.44 : v < 1000 ? 0.37 : v < 10000 ? 0.31 : 0.26);
    ctx.font = `800 ${fs}px "Trebuchet MS", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isApex ? T.apexText : textOn(col);
    ctx.fillText(String(v), cx, cy + fs * 0.05);
    ctx.restore();
  }

  function drawWall(x, y, s, now) {
    ctx.save();
    roundRectPath(x, y, s, s, s * 0.14);
    const T = theme();
    const g = ctx.createLinearGradient(x, y, x, y + s);
    g.addColorStop(0, T.wall0);
    g.addColorStop(1, T.wall1);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = T.wallStripe;
    ctx.lineWidth = Math.max(2, s * 0.05);
    for (let i = -1; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (i * s) / 3, y + s);
      ctx.lineTo(x + (i * s) / 3 + s, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.save();
    roundRectPath(x, y, s, s, s * 0.14);
    ctx.strokeStyle = T.wallEdge;
    ctx.lineWidth = Math.max(1, s * 0.025);
    ctx.stroke();
    ctx.restore();
  }

  function draw(now) {
    const css = L.css;
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);

    const shx = shakeAmp > 0.1 ? (Math.random() * 2 - 1) * shakeAmp : 0;
    const shy = shakeAmp > 0.1 ? (Math.random() * 2 - 1) * shakeAmp : 0;
    ctx.save();
    ctx.translate(shx, shy);

    // board bg
    roundRectPath(-4, -4, css + 8, css + 8, css * 0.055);
    const T = theme();
    const bg = ctx.createLinearGradient(0, 0, 0, css);
    bg.addColorStop(0, T.board0);
    bg.addColorStop(1, T.board1);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = T.boardEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // cells
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const cell = st.grid[idxOf(r, c)];
        const x = cellX(c), y = cellY(r), s = L.cell;
        if (cell && cell.wall) {
          drawWall(x, y, s, now);
        } else {
          roundRectPath(x, y, s, s, s * 0.15);
          ctx.fillStyle = T.cell;
          ctx.fill();
        }
      }
    }

    // ghosts (absorbed tiles sliding into merges)
    for (const g of ghosts) {
      const p = Math.min(1, (now - g.start) / ANIM);
      const e = 1 - Math.pow(1 - p, 3);
      const x = g.x + (g.tx - g.x) * e, y = g.y + (g.ty - g.y) * e;
      const alpha = p > 0.72 ? 1 - (p - 0.72) / 0.28 : 1;
      paintTile(x + L.cell / 2, y + L.cell / 2, L.cell * 0.99, g.v, g.line, now, alpha * 0.95, 0);
    }

    // tiles
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const cell = st.grid[idxOf(r, c)];
        if (!cell || !cell.t) continue;
        const t = cell.t;
        if (t.spawnT !== undefined && now < t.spawnT) continue;
        const pos = tileRenderPos(t, now);
        let scale = 1;
        if (t.spawnT !== undefined) {
          const sp = Math.min(1, (now - t.spawnT) / SPAWN);
          const c1 = 1.7, c3 = c1 + 1, u = sp - 1;
          scale = Math.max(0, 1 + c3 * u * u * u + c1 * u * u);
        }
        let glow = 0;
        if (t.popStart !== undefined && now > t.popStart) {
          const pp = Math.min(1, (now - t.popStart) / POP);
          scale *= 1 + 0.3 * Math.sin(Math.PI * pp) * (1 - pp * 0.35);
          glow = Math.sin(Math.PI * pp);
        }
        paintTile(pos.x + L.cell / 2, pos.y + L.cell / 2, L.cell * 0.99 * scale, t.v, t.line, now, 1, glow);
      }
    }

    // particles (additive)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a * a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.size * a), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // floaters
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      const a = 1 - f.life / f.max;
      ctx.globalAlpha = Math.min(1, a * 1.6);
      ctx.font = `900 ${f.size}px "Trebuchet MS", system-ui, sans-serif`;
      ctx.strokeStyle = theme().floaterEdge;
      ctx.lineWidth = f.size * 0.14;
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();

    ctx.restore(); // shake

    // nudge hint when a move is blocked: thin red flash on that edge
    if (nudgeDir >= 0) {
      const p = (now - nudgeStart) / 180;
      if (p < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.5;
        ctx.strokeStyle = theme().nudge;
        ctx.lineWidth = 4;
        const m = 6;
        ctx.beginPath();
        if (nudgeDir === 0) { ctx.moveTo(m, m); ctx.lineTo(css - m, m); }
        if (nudgeDir === 1) { ctx.moveTo(css - m, m); ctx.lineTo(css - m, css - m); }
        if (nudgeDir === 2) { ctx.moveTo(m, css - m); ctx.lineTo(css - m, css - m); }
        if (nudgeDir === 3) { ctx.moveTo(m, m); ctx.lineTo(m, css - m); }
        ctx.stroke();
        ctx.restore();
      } else nudgeDir = -1;
    }
  }

  function update(now, dt) {
    // timers
    for (let i = timers.length - 1; i >= 0; i--) {
      if (now >= timers[i].at) { const fn = timers[i].fn; timers.splice(i, 1); fn(); }
    }
    // ghosts
    ghosts = ghosts.filter((g) => now - g.start < GHOST_LIFE);
    // particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt;
      p.vx *= 1 - 1.6 * dt;
    }
    // floaters
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life += dt;
      if (f.life >= f.max) { floaters.splice(i, 1); continue; }
      f.y += f.vy * dt;
      f.vy *= 1 - 2.2 * dt;
    }
    // shake decay
    shakeAmp *= Math.exp(-dt * 7.5);
    if (shakeAmp < 0.1) shakeAmp = 0;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (gstate !== 'paused') update(now, dt);
    draw(now);
  }
  requestAnimationFrame(frame);

  /* ================= INPUT ================= */

  const KEYMAP = {
    ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
    w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3
  };

  window.addEventListener('keydown', (e) => {
    if (e.target === nameInput) {
      if (e.key === 'Enter') { e.preventDefault(); startGame(); }
      return;
    }
    if (e.key in KEYMAP) {
      e.preventDefault();
      if (gstate === 'playing') doMove(KEYMAP[e.key]);
      return;
    }
    switch (e.key) {
      case 'p': case 'P': case 'Escape':
        e.preventDefault();
        if (gstate === 'playing' || gstate === 'paused') togglePause();
        break;
      case 'r': case 'R':
        if (gstate === 'playing' || gstate === 'over' || gstate === 'paused') startGame();
        break;
      case 'Enter': case ' ':
        if (gstate === 'start') { e.preventDefault(); startGame(); }
        else if (gstate === 'over') { e.preventDefault(); startGame(); }
        break;
      case 'm': case 'M':
        toggleMute();
        break;
    }
  });

  // swipe (pointer events cover touch + mouse drag)
  let pDown = null;
  stage.addEventListener('pointerdown', (e) => {
    if (gstate !== 'playing') return;
    pDown = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    const dx = e.clientX - pDown.x, dy = e.clientY - pDown.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 26 && performance.now() - pDown.t < 900) {
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      doMove(dir);
      pDown = null;
    }
  });
  stage.addEventListener('pointerup', () => { pDown = null; });
  stage.addEventListener('pointercancel', () => { pDown = null; });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // dpad
  document.querySelectorAll('.dpad button').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      Audio.ensure();
      if (gstate === 'playing') doMove(parseInt(btn.dataset.dir, 10));
    });
  });

  // buttons
  $('btnPlay').addEventListener('click', () => { Audio.ensure(); startGame(); });
  $('btnRestartOver').addEventListener('click', startGame);
  $('btnMenuOver').addEventListener('click', toMenu);
  $('btnShare').addEventListener('click', shareScore);
  $('btnContinue').addEventListener('click', showResults);
  $('btnResume').addEventListener('click', () => togglePause(false));
  $('btnRestartPause').addEventListener('click', startGame);
  $('btnMenuPause').addEventListener('click', toMenu);
  $('btnMute').addEventListener('click', toggleMute);
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = b.getAttribute('data-mode');
      if (normMode(m) === mode) return;
      setMode(m);
      Audio.ui();
    });
  });
  $('btnRestartTop').addEventListener('click', () => {
    if (gstate === 'playing' || gstate === 'paused' || gstate === 'over') startGame();
  });

  function toggleMute() {
    Audio.muted = !Audio.muted;
    lsSet(LS_MUTE, Audio.muted ? '1' : '0');
    $('btnMute').textContent = Audio.muted ? '🔇' : '🔊';
    $('btnMute').classList.toggle('off', Audio.muted);
    if (!Audio.muted) Audio.ui();
  }

  // leaderboard tabs (scoped per .lbwrap so menu & results screens work independently)
  document.querySelectorAll('.lbwrap').forEach((wrap) => {
    const btns = wrap.querySelectorAll('.tabs button');
    const lists = wrap.querySelectorAll('.lb');
    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        btns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        lists.forEach((l) => l.classList.toggle('hidden', l.dataset.tab !== btn.dataset.tab));
        Audio.ui();
      });
    });
  });

  // auto-pause when the tab loses focus
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && gstate === 'playing') togglePause(true);
  });
  window.addEventListener('blur', () => {
    if (gstate === 'playing') togglePause(true);
  });

  /* ================= DEBUG HOOK ================= */

  window.__dual = {
    get state() { return gstate; },
    get st() { return st; },
    doMove, startGame, gameOver, togglePause, toMenu
  };

  /* ================= BOOT ================= */

  nameInput.value = playerName;
  elNameChip.textContent = playerName || 'Guest';
  $('btnMute').textContent = Audio.muted ? '🔇' : '🔊';
  $('btnMute').classList.toggle('off', Audio.muted);
  updateHud();
  setScreen('start');
  renderLocal();
  setMode(mode, { force: true });   // paint the saved mode's chip, picker and board
  hydrateGlobal();       // show the last board this browser saw while the fresh read runs
  renderGlobal();
  fetchGlobal();
  flushPending().then(() => { maybeCompact(); fetchGlobal(); });
  // refresh whenever the player comes back to the tab (their own score, their
  // friends' scores) without re-fetching on every focus while playing
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    flushPending();                              // deliver anything the store refused earlier
    if (gstate === 'start') fetchGlobal();
  });
  window.addEventListener('focus', () => { if (gstate === 'start') fetchGlobal(); });
  // a score that could not be stored (store rate-limited, tab closed mid-submit)
  // is retried while the tab is open instead of waiting for the next page load
  setInterval(() => {
    if (pendingAll().length) flushPending().then(() => fetchGlobal());
  }, 120000);

  // read-only view of the live board, for tests and debugging
  try {
    window.__gameState = () => ({ grid: st.grid, score: st.score, mode, walls: MODES[mode].walls, moves: st.moves, over: st.over });
  } catch (e) { /* no window */ }

  // idle demo board behind the start overlay
  Logic.newGame(st, () => 0.42, MODES[mode].walls);
  try { draw(performance.now()); } catch (e) { /* canvas not sized yet: the rAF loop paints */ }

})();
