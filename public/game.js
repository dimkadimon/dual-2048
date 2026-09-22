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

    newGame(st, rng = Math.random) {
      st.grid = new Array(N * N).fill(null);
      st.score = 0; st.maxTile = 0; st.won = false; st.over = false; st.moves = 0;
      this.placeWalls(st, rng);
      this.spawn(st, rng);
      this.spawn(st, rng);
      return st;
    },

    /* 2 walls, in distinct rows and distinct columns,
       so every row/column always keeps 3 playable cells. */
    placeWalls(st, rng = Math.random) {
      const rows = shuffle([0, 1, 2, 3], rng).slice(0, 2);
      const cols = shuffle([0, 1, 2, 3], rng).slice(0, 2);
      for (let i = 0; i < 2; i++) st.grid[idx(rows[i], cols[i])] = { wall: true };
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

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof globalThis !== 'undefined') globalThis.DuoLogic = Logic;
  if (typeof document === 'undefined') return; // headless: logic only

  /* ================= CONFIG / THEME ================= */

  const ANIM = 105;        // slide ms
  const SPAWN = 170;       // spawn pop ms
  const POP = 210;         // merge pop ms
  const GHOST_LIFE = ANIM + 30;

  const COLORS = {
    two:   { 2:'#fbbf24', 4:'#f59e0b', 8:'#fb923c', 16:'#f97316', 32:'#ef4444', 64:'#ec4899',
             128:'#e879f9', 256:'#d946ef', 512:'#a855f7', 1024:'#8b5cf6', 2048:'#f8fafc',
             4096:'#fde68a', 8192:'#ffffff', 16384:'#ffffff' },
    three: { 3:'#38bdf8', 6:'#22d3ee', 12:'#2dd4bf', 24:'#34d399', 48:'#4ade80', 96:'#a3e635',
             192:'#a5b4fc', 384:'#818cf8', 768:'#60a5fa', 1536:'#c084fc', 3072:'#f8fafc',
             6144:'#c4b5fd', 12288:'#ffffff', 24576:'#ffffff' }
  };

  function colorFor(v, line) {
    const map = COLORS[line];
    return map[v] || (line === 'two' ? '#ffffff' : '#e0e7ff');
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

  const LS_NAME = 'dual2048.name.v1';
  // v2 keys: old-rules (×3 hexes) scores are intentionally left behind so
  // YOUR BEST starts clean and matches the cleared global board.
  const LS_BEST = 'dual2048.best.v2';
  const LS_LOCAL = 'dual2048.local.v2';
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
  let best = parseInt(lsGet(LS_BEST, '0'), 10) || 0;
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
        color: Math.random() < 0.25 ? '#ffffff' : color,
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
          floater(cx, cy, 'COMBO ×' + res.events.length + '  +' + bonus, '#f8fafc', L.cell * 0.34);
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
    Logic.newGame(st, rng);
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
    if (isRecord) { best = st.score; lsSet(LS_BEST, String(best)); }

    // local table
    const local = lsJSON(LS_LOCAL, []);
    local.push({ n: playerName, s: st.score, t: st.maxTile, d: Date.now() });
    local.sort((a, b) => b.s - a.s);
    lsSet(LS_LOCAL, JSON.stringify(local.slice(0, 10)));

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

        const bg = x.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#141a3a');
        bg.addColorStop(1, '#070a16');
        x.fillStyle = bg;
        x.fillRect(0, 0, W, H);

        x.textAlign = 'center';
        const tg = x.createLinearGradient(0, 0, W, 0);
        tg.addColorStop(0, '#fbbf24');
        tg.addColorStop(0.5, '#fb7185');
        tg.addColorStop(1, '#22d3ee');
        x.font = '900 30px "Trebuchet MS", system-ui, sans-serif';
        x.fillStyle = tg;
        x.fillText('Dual 2048', W / 2, 42);

        x.font = '700 15px "Trebuchet MS", system-ui, sans-serif';
        x.fillStyle = '#e8ecff';
        x.fillText(`${playerName}  ·  score ${st.score.toLocaleString()}  ·  best tile ${st.maxTile || '—'}  ·  ${st.moves} moves`, W / 2, 70);

        x.drawImage(canvas, padX, head, bw, bw);

        x.font = '600 11px "Trebuchet MS", system-ui, sans-serif';
        x.fillStyle = '#929ac4';
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
        fn: () => burst(L.css * (0.2 + Math.random() * 0.6), L.css * (0.2 + Math.random() * 0.5), i % 2 ? '#fbbf24' : '#22d3ee', 10)
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

  /* Global scores run in two modes:
     1. same-origin Node API (/api/scores) when served by server.js
     2. free kvdb.io bucket fallback — lets the game run as a pure static
        deploy (surge.sh, Netlify, GitHub Pages, file://…) with a working
        shared leaderboard. */
  const KV_BASE = 'https://kvdb.io/WFqmZseFLUPww2FWnuzBWs';
  const HOF_CAP = 2000; // hall-of-fame key ("top") size — permanent, rewritten every submit
  const SEAL_AT = 2000; // active log ("scores") seals into a write-once arc-* shard at this size

  async function kvGet(key) {
    const res = await fetch(KV_BASE + '/' + key, { cache: 'no-store' });
    if (!res.ok) throw new Error('kv get failed');
    const txt = (await res.text()).trim();
    if (!txt) return [];
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  }

  async function kvPut(key, list) {
    const res = await fetch(KV_BASE + '/' + key, { method: 'PUT', body: JSON.stringify(list) });
    if (!res.ok) throw new Error('kv put failed');
  }

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
    const list = lsJSON(LS_LOCAL, []).map((e) => ({ name: e.n, score: e.s, maxTile: e.t }));
    populateList($('localList'), list, 'No scores yet — be the first!');
    populateList($('overLocalList'), list, 'No scores yet — be the first!');
  }

  let globalCache = [];
  async function fetchGlobal() {
    // 1) same-origin Node API
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('/api/scores', { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      globalCache = data.scores || [];
      renderGlobal();
      return;
    } catch (e) { /* fall through to kv mode */ }
    // 2) kvdb fallback (static deploy)
    try {
      let list = await kvGet('top');
      if (!list.length) list = await kvGet('scores'); // pre-sharding / migration window
      globalCache = list;
      renderGlobal();
    } catch (e) {
      const msg = 'Leaderboard offline — try again later!';
      populateList($('globalList'), [], msg);
      populateList($('overGlobalList'), [], msg);
    }
  }

  function renderGlobal() {
    const msg = 'No global scores yet — claim #1!';
    const top = globalCache.slice(0, 100); // in-game shows the top 100; board.html shows the full archive
    populateList($('globalList'), top, msg);
    populateList($('overGlobalList'), top, msg);
  }

  async function submitGlobal(name, score, maxTile) {
    if (!score) return null;
    // 1) same-origin Node API
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, score, maxTile }),
        signal: ctrl.signal
      });
      clearTimeout(to);
      if (res.ok) return await res.json();
    } catch (e) { /* fall through to kv mode */ }
    // 2) kvdb fallback (static deploy): hall-of-fame + sharded append log
    try {
      const entry = { name: String(name).replace(/[<>]/g, '').trim().slice(0, 16) || 'ANON', score, maxTile, ts: Date.now() };
      const [top, log] = await Promise.all([
        kvGet('top').catch(() => []),
        kvGet('scores').catch(() => [])
      ]);
      const newTop = top.concat([entry]).sort((a, b) => b.score - a.score || a.ts - b.ts).slice(0, HOF_CAP);
      const newLog = log.concat([entry]);
      if (newLog.length >= SEAL_AT) {
        const id = 'arc-' + Date.now();
        await kvPut(id, newLog);
        await kvPut('scores', []);
        let arcs = [];
        try {
          const mr = await fetch(KV_BASE + '/meta', { cache: 'no-store' });
          if (mr.ok) { const mj = JSON.parse(await mr.text()); if (mj && Array.isArray(mj.arcs)) arcs = mj.arcs; }
        } catch (e) { /* fresh meta */ }
        if (!arcs.includes(id)) arcs.push(id);
        await kvPut('meta', { arcs });
      } else {
        await kvPut('scores', newLog);
      }
      await kvPut('top', newTop);
      const rank = newTop.findIndex((e) => e === entry) + 1 || newTop.filter((e) => e.score > entry.score).length + 1;
      const isPB = !newTop.some((e) => e !== entry && String(e.name).toLowerCase() === entry.name.toLowerCase() && e.score > entry.score);
      return { ok: true, rank, total: newTop.length, isPB };
    } catch (e) {
      return null;
    }
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

    const g = ctx.createLinearGradient(cx, cy - s / 2, cx, cy + s / 2);
    g.addColorStop(0, lighten(col, 0.22));
    g.addColorStop(0.55, col);
    g.addColorStop(1, darken(col, 0.16));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;

    // inner highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, s * 0.022);
    ctx.stroke();

    // value
    const fs = s * (v < 100 ? 0.44 : v < 1000 ? 0.37 : v < 10000 ? 0.31 : 0.26);
    ctx.font = `800 ${fs}px "Trebuchet MS", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isApex ? '#1a1030' : textOn(col);
    ctx.fillText(String(v), cx, cy + fs * 0.05);
    ctx.restore();
  }

  function drawWall(x, y, s, now) {
    ctx.save();
    roundRectPath(x, y, s, s, s * 0.14);
    const g = ctx.createLinearGradient(x, y, x, y + s);
    g.addColorStop(0, '#2b3360');
    g.addColorStop(1, '#1a2044');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(129,144,255,0.14)';
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
    ctx.strokeStyle = 'rgba(140,155,255,0.35)';
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
    const bg = ctx.createLinearGradient(0, 0, 0, css);
    bg.addColorStop(0, '#141a3a');
    bg.addColorStop(1, '#0d1230');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(124,140,255,0.18)';
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
          ctx.fillStyle = 'rgba(10,14,36,0.55)';
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
      ctx.strokeStyle = 'rgba(5,8,20,0.8)';
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
        ctx.strokeStyle = '#f87171';
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
  $('btnPause').addEventListener('click', () => {
    if (gstate === 'playing' || gstate === 'paused') togglePause();
  });
  $('btnMute').addEventListener('click', toggleMute);
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
  fetchGlobal();

  // idle demo board behind the start overlay
  Logic.newGame(st, () => 0.42);

})();
