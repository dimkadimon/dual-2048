/* Headless tests for the pure game logic in public/game.js */
'use strict';
const L = require('./public/game.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { idx, inB } = L;
function put(st, r, c, v, line) {
  st.grid[idx(r, c)] = { t: { v, line, r, c, merged: false } };
}
function wall(st, r, c) { st.grid[idx(r, c)] = { wall: true }; }
function tileAt(st, r, c) { const cell = st.grid[idx(r, c)]; return cell && cell.t ? cell.t : null; }

console.log('1. newGame structure');
{
  const st = L.createState();
  L.newGame(st, mulberry32(1));
  const walls = st.grid.filter((c) => c && c.wall).length;
  const tiles = st.grid.filter((c) => c && c.t).length;
  ok(walls === 2, 'exactly 2 walls');
  ok(tiles === 2, 'exactly 2 starting tiles');
  const wallRows = new Set(), wallCols = new Set();
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const cell = st.grid[idx(r, c)];
    if (cell && cell.wall) { wallRows.add(r); wallCols.add(c); }
  }
  ok(wallRows.size === 2 && wallCols.size === 2, 'walls in distinct rows and columns');
  ok(L.hasMoves(st), 'fresh board has moves');
}

console.log('2. same-lineage merge (two: 2+2 → 4)');
{
  const st = L.createState();
  put(st, 0, 0, 2, 'two'); put(st, 0, 1, 2, 'two');
  const res = L.move(st, 3); // left
  ok(res.moved, 'move registered');
  ok(res.events.length === 1 && res.events[0].newV === 4, 'one merge to 4');
  ok(tileAt(st, 0, 0) && tileAt(st, 0, 0).v === 4, 'merged tile at (0,0) = 4');
  ok(!tileAt(st, 0, 1), 'source cell emptied');
  ok(st.score === 4 && st.maxTile === 4, 'score & maxTile updated');
}

console.log('3. three-lineage merge doubles too (3+3 → 6, 6+6 → 12)');
{
  const st = L.createState();
  put(st, 2, 2, 3, 'three'); put(st, 2, 3, 3, 'three');
  let res = L.move(st, 1); // right
  ok(tileAt(st, 2, 3).v === 6, '3+3 → 6');
  put(st, 2, 0, 6, 'three');
  res = L.move(st, 1);
  ok(tileAt(st, 2, 3).v === 12, '6+6 → 12');
  ok(res.events[0].line === 'three', 'event lineage correct');
}
{
  const st = L.createState();
  put(st, 0, 0, 9, 'three'); put(st, 0, 1, 9, 'three');
  L.move(st, 3); // left
  ok(tileAt(st, 0, 0).v === 18, '9+9 → 18 (not 27)');
}

console.log('4. lineages never mix (2 vs 3)');
{
  const st = L.createState();
  put(st, 0, 0, 2, 'two'); put(st, 0, 1, 3, 'three');
  const res = L.move(st, 3); // left — 3 blocked by 2, no merge
  ok(!res.moved && res.events.length === 0, 'no move, no merge across lineages');
  ok(tileAt(st, 0, 0).v === 2 && tileAt(st, 0, 1).v === 3, 'tiles unchanged');
}

console.log('5. walls block slides and merges');
{
  const st = L.createState();
  wall(st, 0, 1);
  put(st, 0, 3, 2, 'two');
  L.move(st, 3); // left
  ok(tileAt(st, 0, 2) && tileAt(st, 0, 2).v === 2, 'tile stops against wall at (0,2)');
  ok(st.grid[idx(0, 1)].wall, 'wall unchanged');
}
{
  const st = L.createState();
  wall(st, 1, 0);
  put(st, 0, 0, 4, 'two'); put(st, 2, 0, 4, 'two');
  const res = L.move(st, 2); // down — wall between them
  ok(res.events.length === 0, 'no merge through a wall');
  ok(tileAt(st, 0, 0).v === 4, 'tile above wall stays at (0,0)');
  ok(tileAt(st, 3, 0).v === 4, 'tile below wall slides to (3,0)');
}

console.log('6. chain row [2,2,4,·] → [4,4,·,·] left');
{
  const st = L.createState();
  put(st, 0, 0, 2, 'two'); put(st, 0, 1, 2, 'two'); put(st, 0, 2, 4, 'two');
  const res = L.move(st, 3);
  ok(tileAt(st, 0, 0).v === 4, 'first pair merged at c0');
  ok(tileAt(st, 0, 1).v === 4, 'lone 4 slid to c1 (no double-merge)');
  ok(!tileAt(st, 0, 2), 'c2 emptied');
  ok(res.events.length === 1 && st.score === 4, 'single merge, score 4');
}

console.log('7. all four directions move correctly');
{
  const st = L.createState();
  put(st, 1, 1, 2, 'two');
  L.move(st, 0); ok(tileAt(st, 0, 1), 'up → row 0');
  L.move(st, 1); ok(tileAt(st, 0, 3), 'right → col 3');
  L.move(st, 2); ok(tileAt(st, 3, 3), 'down → row 3');
  L.move(st, 3); ok(tileAt(st, 3, 0), 'left → col 0');
}

console.log('8. spawn rules');
{
  const st = L.createState();
  L.newGame(st, mulberry32(7));
  let bad = 0;
  for (let i = 0; i < 500; i++) {
    const t = L.spawn(st, mulberry32(i + 100));
    if (!t) break;
    if (!inB(t.r, t.c)) bad++;
    const cell = st.grid[idx(t.r, t.c)];
    if (!cell || cell.t !== t) bad++;
    const valid = (t.line === 'two' && (t.v === 2 || t.v === 4)) || (t.line === 'three' && (t.v === 3 || t.v === 6));
    if (!valid) bad++;
  }
  ok(bad === 0, '500 spawns always valid (in-bounds, empty cell, correct values)');
}

console.log('9. hasMoves & game over detection');
{
  const st = L.createState();
  // full board, checkerboard of unmergeable values
  const vals = [[2, 3, 2, 3], [3, 2, 3, 2], [2, 3, 2, 3], [3, 2, 3, 2]];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) put(st, r, c, vals[r][c], vals[r][c] === 2 ? 'two' : 'three');
  ok(!L.hasMoves(st), 'full board with no merges → no moves');
  st.grid[idx(2, 2)] = { t: { v: 3, line: 'three', r: 2, c: 2, merged: false } }; // (2,2)=3 next to (2,1)=3? (2,1)=3 yes
  ok(L.hasMoves(st), 'one mergeable pair → moves exist');
}

console.log('10. full random playthroughs (invariants + termination)');
{
  let games = 0, maxScore = 0, invariantFails = 0, overFails = 0;
  for (let g = 0; g < 60; g++) {
    const rng = mulberry32(g * 7919 + 13);
    const st = L.createState();
    L.newGame(st, rng);
    const wallIdx = [];
    st.grid.forEach((cell, i) => { if (cell && cell.wall) wallIdx.push(i); });
    let moves = 0, prevScore = 0;
    while (L.hasMoves(st) && moves < 3000) {
      const dir = Math.floor(rng() * 4);
      const res = L.move(st, dir);
      if (res.moved) {
        L.spawn(st, rng);
        moves++;
        // invariants
        if (st.score < prevScore) invariantFails++;
        prevScore = st.score;
        wallIdx.forEach((i) => { if (!st.grid[i] || !st.grid[i].wall) invariantFails++; });
        for (let i = 0; i < 16; i++) {
          const cell = st.grid[i];
          if (cell && cell.t) {
            const t = cell.t;
            if (t.r !== Math.floor(i / 4) || t.c !== i % 4) invariantFails++;
          }
        }
      }
    }
    if (L.hasMoves(st)) overFails++; // loop limit hit
    games++;
    maxScore = Math.max(maxScore, st.score);
  }
  ok(invariantFails === 0, 'score monotonic, walls fixed, tile r/c consistent across 60 games');
  ok(overFails === 0, 'every game reaches a genuine game-over state');
  ok(games === 60, '60 full games simulated without crash (max score seen: ' + maxScore + ')');
}

console.log('11. win detection');
{
  const st = L.createState();
  put(st, 0, 0, 1024, 'two'); put(st, 0, 1, 1024, 'two');
  L.move(st, 3);
  ok(st.won === true, 'two-lineage 2048 sets won');
  const st2 = L.createState();
  put(st2, 0, 0, 1536, 'three'); put(st2, 0, 1, 1536, 'three');
  L.move(st2, 1);
  ok(st2.won === true && tileAt(st2, 0, 3).v === 3072, 'three-lineage 3072 sets won');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
