/* ============================================================
   End-to-end test: the real server.js against a stand-in store.

   Boots the server with KV_URL pointed at a mock kvdb, plays a few games
   the way the browser does (direct write-once records) and through the API,
   and checks that the board comes back complete, de-duplicated and durable
   after the compactor has run.
   ============================================================ */
'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const { createMockKV } = require('./tools/mock-kv.js');
const Leaderboard = require('./public/leaderboard.js');

const PORT = 8231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n      ' + (e && e.message)); }
}

(async () => {
  const kv = createMockKV();
  const kvUrl = await kv.start();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), KV_URL: kvUrl + '/bucket', COMPACT_MS: '1000000', READ_TTL: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  await sleep(700);

  const API = 'http://127.0.0.1:' + PORT;
  const lb = Leaderboard.create({ bucket: kvUrl + '/bucket' });

  await test('serves the game', async () => {
    const r = await fetch(API + '/');
    assert(r.ok, 'GET / should be 200, got ' + r.status);
    const html = await r.text();
    assert(html.includes('leaderboard.js'), 'index.html must load the shared leaderboard module');
  });

  await test('browser-style writes (write-once records) land on the board', async () => {
    const t = Date.now() - 3600000;
    await lb.submit({ name: 'Alice', score: 300, maxTile: 48, ts: t });
    await lb.submit({ name: 'Bob', score: 250, maxTile: 32, ts: t + 1000 });
    const r = await fetch(API + '/api/scores');
    const j = await r.json();
    assert(j.ok, 'API ok');
    assert(j.scores.length === 2, 'two plays on the board, got ' + j.scores.length);
    assert(j.scores[0].name === 'Alice', 'ordered by score');
  });

  await test('POST /api/scores stores a play and reports rank/total', async () => {
    const r = await fetch(API + '/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Carol', score: 400, maxTile: 64, ts: Date.now() - 1800000 })
    });
    const j = await r.json();
    assert(j.ok, 'POST ok: ' + JSON.stringify(j));
    assert.strictEqual(j.rank, 1, 'best score is rank 1');
    assert.strictEqual(j.total, 3, 'three plays total, got ' + j.total);
    assert.strictEqual(j.isPB, true, 'personal best');
  });

  await test('the same POST retried does not create a second play', async () => {
    const ts = Date.now() - 1700000;
    const body = JSON.stringify({ name: 'Carol', score: 400, maxTile: 64, ts });
    await fetch(API + '/api/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const r = await fetch(API + '/api/scores');
    const j = await r.json();
    assert.strictEqual(j.scores.filter((e) => e.name === 'Carol').length, 1, 'Carol appears once');
  });

  await test('compaction moves records into the archive and the board still has everything', async () => {
    const stats = await lb.compact({ quietMs: 0 });
    // 3 distinct plays: the repeated POST for Carol is the same play (same ts),
    // so it merges to one entry instead of double-counting
    assert.strictEqual(stats.ingested, 3, 'compacted the plays, got ' + stats.ingested);
    assert.strictEqual(kv.keys().filter((k) => k.startsWith('q/')).length, 0, 'records folded away');
    const r = await fetch(API + '/api/scores');
    const j = await r.json();
    assert.strictEqual(j.scores.length, 3, 'board intact after compaction, got ' + j.scores.length);
    assert.strictEqual(j.quality, 'ok', 'all sources healthy');
  });

  await test('health endpoint reports the store', async () => {
    const j = await (await fetch(API + '/api/health')).json();
    assert(j.ok && j.store, 'health ok');
  });

  server.kill();
  await kv.stop();
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
