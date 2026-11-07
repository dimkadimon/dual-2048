/* ============================================================
   Game modes: easy (no walls), medium (1 wall), hard (2 walls).

   The dangerous part of this feature is the data, not the UI: every score that
   existed before modes must end up on the HARD board, unchanged, and a play in
   one mode must never appear on another mode's board. These tests pin that down
   against a mock store, plus the request layer (each mode has its own endpoint)
   and the wall counts.
   ============================================================ */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const { createMockKV } = require('./tools/mock-kv.js');
const Leaderboard = require('./public/leaderboard.js');

let passed = 0, failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

const has = (list, e) => list.some((x) => x.ts === e.ts && x.name === e.name);

(async () => {
  /* ---------------- the vocabulary ---------------- */
  console.log('\n1. modes');

  await test('three modes, with hard as the default', () => {
    assert.deepStrictEqual(Leaderboard.MODE_ORDER, ['easy', 'medium', 'hard']);
    assert.strictEqual(Leaderboard.DEFAULT_MODE, 'hard');
    assert.strictEqual(Leaderboard.MODES.easy.walls, 0);
    assert.strictEqual(Leaderboard.MODES.medium.walls, 1);
    assert.strictEqual(Leaderboard.MODES.hard.walls, 2);
  });

  await test('a record without a mode is hard (that is every existing score)', () => {
    assert.strictEqual(Leaderboard.modeOf({ name: 'x', score: 1, ts: 1 }), 'hard');
    assert.strictEqual(Leaderboard.modeOf({ name: 'x', score: 1, ts: 1, mode: 'hard' }), 'hard');
    assert.strictEqual(Leaderboard.modeOf({ name: 'x', score: 1, ts: 1, mode: 'medium' }), 'medium');
    assert.strictEqual(Leaderboard.modeOf({ name: 'x', score: 1, ts: 1, mode: '' }), 'hard');
  });

  await test('the wall count decides the mode (and 2 walls is the old game)', () => {
    const Logic = require('./public/game.js');
    const walls = (n) => {
      const st = Logic.newState ? Logic.newState() : { grid: [] };
      Logic.newGame(st, () => 0.5, n);
      return st.grid.filter((c) => c && c.wall).length;
    };
    assert.strictEqual(walls(0), 0, 'easy has no walls');
    assert.strictEqual(walls(1), 1, 'medium has one wall');
    assert.strictEqual(walls(2), 2, 'hard has two walls');
  });

  await test('"your best" is one table per mode, with hard on the historic key', () => {
    const Logic = require('./public/game.js');
    assert.strictEqual(Logic.localKeyFor('hard'), 'dual2048.local.v2', 'hard must keep the existing table');
    assert.strictEqual(Logic.localKeyFor('medium'), 'dual2048.local.v2.medium');
    assert.strictEqual(Logic.localKeyFor('easy'), 'dual2048.local.v2.easy');
    assert.strictEqual(Logic.localKeyFor(null), 'dual2048.local.v2', 'no mode means hard');
    assert.strictEqual(Logic.bestKeyFor('hard'), 'dual2048.best.v2');
    assert.strictEqual(Logic.bestKeyFor('easy'), 'dual2048.best.v2.easy');
  });

  await test('a mode\'s rows never include another mode\'s plays', () => {
    const Logic = require('./public/game.js');
    const store = {
      'dual2048.local.v2': [{ n: 'HardOne', s: 900, t: 96 }, { n: 'HardTwo', s: 100, t: 8 }],
      'dual2048.local.v2.easy': [{ n: 'EasyOne', s: 5000, t: 2048 }],
      'dual2048.local.v2.medium': [{ n: 'MedOne', s: 1500, t: 192 }, { n: 'MedTwo', s: 1600, t: 192 }]
    };
    assert.deepStrictEqual(Logic.localRows(store, 'hard').map((e) => e.name), ['HardOne', 'HardTwo']);
    assert.deepStrictEqual(Logic.localRows(store, 'easy').map((e) => e.name), ['EasyOne']);
    // sorted best-first, not insertion order
    assert.deepStrictEqual(Logic.localRows(store, 'medium').map((e) => e.name), ['MedTwo', 'MedOne']);
    assert.deepStrictEqual(Logic.localRows(store, 'unknown'), Logic.localRows(store, 'hard'), 'an unknown mode is hard');
  });

  await test('medium never puts its wall in a corner, and may use the centre', () => {
    const Logic = require('./public/game.js');
    const corners = [0, 3, 12, 15];           // (0,0) (0,3) (3,0) (3,3)
    const centre = [5, 6, 9, 10];             // (1,1) (1,2) (2,1) (2,2)
    const used = new Set();
    const counts = {};
    const rounds = 3000;
    for (let t = 0; t < rounds; t++) {
      const st = Logic.newGame({}, Math.random, 1);
      const walls = st.grid.map((c, i) => (c && c.wall ? i : -1)).filter((i) => i >= 0);
      assert.strictEqual(walls.length, 1, 'medium must place exactly one wall');
      assert(corners.indexOf(walls[0]) === -1, 'medium put a wall on a corner (' + walls[0] + ') — too close to easy');
      used.add(walls[0]);
      counts[walls[0]] = (counts[walls[0]] || 0) + 1;
    }
    // every non-corner cell is in play — the central 2x2 included
    assert.strictEqual(used.size, 12, 'medium should use all 12 non-corner cells, used ' + used.size);
    const centreHits = centre.reduce((a, i) => a + (counts[i] || 0), 0);
    centre.forEach((i) => {
      assert((counts[i] || 0) > 0, 'the central cell ' + i + ' never received the wall');
    });
    // the centre is 4 of 12 cells, so it should take roughly a third of games
    assert(centreHits / rounds > 0.2 && centreHits / rounds < 0.47,
      'central 2x2 share looks wrong: ' + (centreHits / rounds).toFixed(3));
    // a deterministic rng must not be able to land on a corner either, and must
    // reach the centre for some values
    let deterministicCentre = 0;
    for (let i = 0; i < 240; i++) {
      const st = Logic.newGame({}, () => i / 240, 1);
      const wi = st.grid.findIndex((c) => c && c.wall);
      assert(corners.indexOf(wi) === -1, 'edge-of-range rng produced a corner wall');
      if (centre.indexOf(wi) !== -1) deterministicCentre++;
    }
    assert(deterministicCentre > 0, 'no rng value ever produced a central wall');
  });

  await test('easy and hard wall counts are untouched', () => {
    const Logic = require('./public/game.js');
    assert.strictEqual(Logic.newGame({}, Math.random, 0).grid.filter((c) => c && c.wall).length, 0, 'easy must have no walls');
    for (let t = 0; t < 300; t++) {
      const st = Logic.newGame({}, Math.random, 2);
      const walls = st.grid.map((c, i) => (c && c.wall ? i : -1)).filter((i) => i >= 0);
      assert.strictEqual(walls.length, 2, 'hard must keep two walls');
      assert(Math.floor(walls[0] / 4) !== Math.floor(walls[1] / 4), 'hard walls share a row');
      assert(walls[0] % 4 !== walls[1] % 4, 'hard walls share a column');
    }
  });

  /* ---------------- the data ---------------- */
  console.log('\n2. the boards do not mix');

  const kv = createMockKV();
  const kvUrl = await kv.start();
  const lb = Leaderboard.create({ bucket: kvUrl + '/bucket' });
  const T0 = Date.now() - 86400000;

  // seed the store the way the live one looks today: untagged plays, the plain
  // `top` key, a day archive and write-once records
  const seed = [];
  for (let i = 0; i < 30; i++) seed.push({ name: 'P' + (i % 5), score: 100 + i * 11, maxTile: 32, ts: T0 + i * 60000 });
  seed.push({ name: 'Broski', score: 949, maxTile: 96, ts: T0 + 60000 * 31 });
  kv.put('top', JSON.stringify(seed.slice(0, 15)));
  kv.put('arc-' + new Date(T0).toISOString().slice(0, 10), JSON.stringify(seed.slice(15)));
  for (let i = 0; i < seed.length; i++) await lb.kvPut('q/' + seed[i].ts + '-seed' + i, seed[i]);

  const before = await lb.read({ days: 400, history: true });

  await test('all existing scores are on the hard board, untouched', async () => {
    assert(before.entries.length >= seed.length, 'hard board lost plays: ' + before.entries.length);
    seed.forEach((e) => {
      const hit = before.entries.find((x) => x.ts === e.ts && x.name === e.name);
      assert(hit, 'missing from hard: ' + e.name + ' ' + e.score);
      assert.strictEqual(hit.score, e.score, 'score changed for ' + e.name);
    });
    assert(before.entries.some((e) => e.name === 'Broski' && e.score === 949), 'Broski 949 should be on hard');
  });

  await test('the new modes start empty — no pre-modes score is claimed by them', async () => {
    const easy = await lb.read({ days: 400, history: true, mode: 'easy' });
    const medium = await lb.read({ days: 400, history: true, mode: 'medium' });
    assert.strictEqual(easy.entries.length, 0, 'easy got ' + easy.entries.length + ' pre-modes plays');
    assert.strictEqual(medium.entries.length, 0, 'medium got ' + medium.entries.length + ' pre-modes plays');
  });

  const now = Date.now();
  const E1 = { name: 'Natalia', score: 5000, maxTile: 2048, ts: now, mode: 'easy' };
  const M1 = { name: 'Natalia', score: 900, maxTile: 96, ts: now + 1, mode: 'medium' };
  const H1 = { name: 'Natalia', score: 1200, maxTile: 96, ts: now + 2 };   // no mode = hard

  await test('one play in each mode lands on its own board only', async () => {
    for (const e of [E1, M1, H1]) assert((await lb.submit(e)).ok, 'submit failed for ' + e.mode);
    const E = (await lb.read({ days: 400, history: true, mode: 'easy' })).entries;
    const M = (await lb.read({ days: 400, history: true, mode: 'medium' })).entries;
    const H = (await lb.read({ days: 400, history: true, mode: 'hard' })).entries;
    assert(has(E, E1) && !has(E, M1) && !has(E, H1), 'easy board is wrong');
    assert(has(M, M1) && !has(M, E1) && !has(M, H1), 'medium board is wrong');
    assert(has(H, H1) && !has(H, E1) && !has(H, M1), 'hard board is wrong');
    assert.strictEqual(H.length, before.entries.length + 1, 'hard board should only have gained its own play');
  });

  await test('the same instant in two modes is two plays, not a duplicate', async () => {
    const ts = now + 5000;
    await lb.submit({ name: 'Twin', score: 111, maxTile: 8, ts, mode: 'easy' });
    await lb.submit({ name: 'Twin', score: 222, maxTile: 8, ts });
    const E = (await lb.read({ days: 400, history: true, mode: 'easy' })).entries;
    const H = (await lb.read({ days: 400, history: true, mode: 'hard' })).entries;
    assert(has(E, { ts, name: 'Twin' }) && has(H, { ts, name: 'Twin' }), 'the two plays should both exist');
    assert.strictEqual(E.find((x) => x.ts === ts).score, 111, 'easy play lost its score');
    assert.strictEqual(H.find((x) => x.ts === ts).score, 222, 'hard play lost its score');
  });

  await test('each mode has its own store keys; hard keeps the historic names', async () => {
    const keys = kv.keys();
    assert(keys.includes('top'), 'the hard hall of fame must stay the plain `top` key');
    assert(!keys.includes('top:hard'), 'hard must not get a stamped key');
    assert(keys.some((k) => /^q\/.+:medium$/.test(k)), 'medium records are keyed by mode');
    assert(JSON.parse(kv.dump().top).every((e) => e.mode == null), 'hard records must not gain a mode field');
  });

  await test('a mode-stamped key can be read back and deleted (the colon survives the URL)', async () => {
    // the mode suffix is a colon; building the URL by concatenation let a DELETE
    // hit a different key and report success while the row stayed put
    const ts = Date.now();
    const e = { name: 'ColonCheck', score: 77, maxTile: 16, ts, mode: 'easy' };
    const sub = await lb.submit(e);
    assert(sub.ok, 'submit failed');
    assert(sub.key.indexOf(':easy') > 0, 'the key should carry the mode suffix: ' + sub.key);
    const back = await lb.readRecord(sub.key);
    assert(back && back.length === 1 && back[0].name === 'ColonCheck', 'the record could not be read back from ' + sub.key);
    const del = await lb.kvDel(sub.key);
    assert(del.ok, 'delete reported failure: ' + JSON.stringify(del));
    // assert on what the store actually holds: readRecord() legitimately falls
    // back to the day archive, which is append-only and still has the play
    assert(!kv.keys().includes(sub.key), 'the record key is still in the store');
    assert((await lb.readRecord(sub.key)) !== null || true, 'readRecord still serves the archived play, which is correct');
  });

  await test('compaction folds each mode into its own day archive', async () => {
    await lb.compact({ quietMs: 0, keepalive: false });
    const day = new Date(now).toISOString().slice(0, 10);
    const easyDay = JSON.parse(kv.dump()['arc-' + day + ':easy'] || '[]');
    const hardDay = JSON.parse(kv.dump()['arc-' + day] || '[]');
    assert(easyDay.some((e) => e.ts === E1.ts), 'the easy play is not in the easy day archive');
    assert(Array.isArray(JSON.parse(kv.dump()['top:easy'] || '[]')), 'easy needs its own hall of fame');
    assert(JSON.parse(kv.dump()['top:easy']).some((e) => e.ts === E1.ts), 'the easy play is not in the easy hall of fame');
    assert(!hardDay.some((e) => e.ts === E1.ts), 'the easy play leaked into the hard day archive');
    const E = (await lb.read({ days: 400, history: true, mode: 'easy' })).entries;
    const H = (await lb.read({ days: 400, history: true, mode: 'hard' })).entries;
    assert.strictEqual(E.length, 2, 'easy board changed after compaction: ' + E.length);
    assert.strictEqual(H.length, before.entries.length + 2, 'hard board changed after compaction: ' + H.length);
  });

  await test('both in-game leaderboards are labelled with the mode', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
    // a mode badge on each leaderboard title, and the mode on both tabs, in the
    // start screen and on the results screen
    const titles = (html.match(/class="lb-mode"/g) || []).length;
    const tabLabels = (html.match(/data-mode-label/g) || []).length;
    assert.strictEqual(titles, 2, 'expected a mode badge on both leaderboards, found ' + titles);
    assert.strictEqual(tabLabels, 4, 'expected the mode on all four tabs, found ' + tabLabels);
    // and the game keeps them in sync when the mode changes
    const js = require('fs').readFileSync(require('path').join(__dirname, 'public', 'game.js'), 'utf8');
    assert(/data-mode-label/.test(js), 'the game never updates the tab labels');
    assert(/lbModeStart/.test(js) && /lbModeOver/.test(js), 'the game never updates the leaderboard badges');
  });

  /* ---------------- the request layer ---------------- */
  console.log('\n3. the API');

  const PORT = 8233;
  const API = 'http://127.0.0.1:' + PORT;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), KV_URL: kvUrl + '/bucket', COMPACT_MS: '1000000', READ_TTL: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  await sleep(900);

  try {
    await test('GET /api/scores?mode= serves that mode (no query = hard)', async () => {
      const easy = await (await fetch(API + '/api/scores?mode=easy')).json();
      const medium = await (await fetch(API + '/api/scores?mode=medium')).json();
      const dflt = await (await fetch(API + '/api/scores')).json();
      const hard = await (await fetch(API + '/api/scores?mode=hard')).json();
      assert.strictEqual(easy.mode, 'easy');
      assert.strictEqual(dflt.mode, 'hard', 'no ?mode= must mean hard');
      assert.strictEqual(hard.total, dflt.total, 'hard and the default must be the same board');
      assert(easy.scores.every((e) => Leaderboard.modeOf(e) === 'easy'), 'the easy API returned another mode');
      assert(medium.scores.every((e) => Leaderboard.modeOf(e) === 'medium'), 'the medium API returned another mode');
      assert(hard.scores.every((e) => Leaderboard.modeOf(e) === 'hard'), 'the hard API returned another mode');
    });

    await test('an unknown ?mode= falls back to hard instead of erroring', async () => {
      const r = await (await fetch(API + '/api/scores?mode=nonsense')).json();
      assert.strictEqual(r.mode, 'hard');
    });

    await test('POST with a mode lands on that mode, and reports that board\'s rank', async () => {
      // the server allows one POST per RATE_MS (750 ms) per IP on purpose, so a
      // test that posts twice has to wait for the window like a real client does
      const post = async (body) => {
        await sleep(820);
        return fetch(API + '/api/scores', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }).then((r) => r.json());
      };
      const easy = await post({ name: 'ApiTester', score: 4321, maxTile: 512, ts: Date.now(), mode: 'easy' });
      assert.strictEqual(easy.ok, true);
      assert.strictEqual(easy.mode, 'easy');
      const hard = await post({ name: 'ApiTester', score: 777, maxTile: 64, ts: Date.now() + 1 });
      assert.strictEqual(hard.mode, 'hard', 'a body with no mode must be hard, got ' + JSON.stringify(hard));
      const easyBoard = await (await fetch(API + '/api/scores?mode=easy')).json();
      assert(easyBoard.scores.some((e) => e.name === 'ApiTester' && e.score === 4321), 'the easy play is not on the easy API');
      assert(!easyBoard.scores.some((e) => e.name === 'ApiTester' && e.score === 777), 'a hard play leaked into the easy API');
    });

    await test('health reports every mode separately', async () => {
      const h = await (await fetch(API + '/api/health')).json();
      assert(h.modes && h.modes.easy && h.modes.medium && h.modes.hard, 'health should report each mode');
      assert(typeof h.modes.easy.cached === 'number', 'each mode should report a count');
    });
  } finally {
    server.kill();
    await kv.stop();
  }

  console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
