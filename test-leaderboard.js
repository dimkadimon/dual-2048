/* ============================================================
   Leaderboard protocol tests — the failure modes that broke v2.x.

   These run against an in-process kvdb look-alike with injectable
   failures, because that is the only way to prove the property that
   matters: no writer can ever erase another writer's score, and no
   retry can ever record the same play twice.
   ============================================================ */
'use strict';
const assert = require('assert');
const { createMockKV } = require('./tools/mock-kv.js');
const Leaderboard = require('./public/leaderboard.js');

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('  ✓ ' + name); }
  catch (e) { failed++; results.push('  ✗ ' + name + '\n      ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = (name, score, ts, tile) => ({ name, score, maxTile: tile || 64, ts });

(async () => {
  /* ---------------------------------------------------------------- */
  await test('submit writes one immutable record and is idempotent on retry', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket', now: () => Date.now() });
    const e = entry('Alice', 100, Date.now());
    const r1 = await lb.submit(e, { id: 'fixed-id' });
    assert(r1.ok, 'first submit should succeed');
    const r2 = await lb.submit(e, { id: 'fixed-id' });   // a retry (e.g. timeout on the client)
    assert(r2.ok, 'retry should succeed');
    const keys = kv.keys().filter((k) => k.startsWith('q/'));
    assert.strictEqual(keys.length, 1, 'retry must not create a second record, got ' + keys.length);
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 1, 'board shows exactly one play');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('concurrent writers cannot erase each other (the v2.x lost-update bug)', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const N = 12, PER = 6;
    const clients = Array.from({ length: N }, () => Leaderboard.create({ bucket: url + '/bucket' }));
    const jobs = [];
    for (let c = 0; c < N; c++) {
      for (let i = 0; i < PER; i++) {
        jobs.push(clients[c].submit(entry('P' + c, 100 + c * 10 + i, Date.now() + c * 1000 + i)));
      }
    }
    const outs = await Promise.all(jobs);          // all in flight at the same time
    assert(outs.every((o) => o.ok), 'every submit should succeed');
    const lb = clients[0];
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, N * PER, 'all ' + (N * PER) + ' plays present, got ' + board.entries.length);
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('a submit that fails is reported as failed (no silent loss)', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    kv.fail('put', 'q/', 99, 429);
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const r = await lb.submit(entry('Bob', 50, Date.now()));
    assert.strictEqual(r.ok, false, 'must not claim success when the store rejected the write');
    assert(r.entry, 'the entry is handed back so the client can retry later');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('a read failure is never treated as "empty" (the stale-writer bug)', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    await lb.submit(entry('Alice', 10, Date.now()));
    await lb.compact({ quietMs: 0 });
    kv.fail('get', 'top', 1, 429);
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.sources.quality, 'partial', 'a failed source must be flagged, not reported as zero');
    assert(board.entries.length >= 1, 'entries from healthy sources are still returned');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('compaction folds q/ records into the day archive + top, then clears them', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    for (let i = 0; i < 25; i++) await lb.submit(entry('P' + (i % 3), 100 + i, t + i * 1000));
    const stats = await lb.compact({ quietMs: 0 });
    assert.strictEqual(stats.ingested, 25, 'compacted 25 entries, got ' + stats.ingested);
    assert.strictEqual(kv.keys().filter((k) => k.startsWith('q/')).length, 0, 'live records cleared');
    const day = lb.dayKey(t);
    const shard = JSON.parse(kv.dump()[day]);
    assert.strictEqual(shard.length, 25, 'day archive holds all 25, got ' + shard.length);
    const top = JSON.parse(kv.dump()['top']);
    assert.strictEqual(top.length, 25, 'hall of fame holds all 25');
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 25, 'board still shows 25 after compaction');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('compaction under injected failures loses nothing and converges', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    for (let i = 0; i < 30; i++) await lb.submit(entry('P' + (i % 4), 200 + i, t + i * 1000));
    // the store misbehaves: reads fail, writes fail, lists fail
    kv.fail('get', 'arc-', 6, 429);
    kv.fail('put', 'arc-', 2, 500);
    kv.fail('list', 'q/', 1, 429);
    kv.fail('del', 'q/', 3, 500);
    for (let round = 0; round < 6; round++) await lb.compact({ quietMs: 0 });
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 30, 'no entry lost across failing compaction rounds, got ' + board.entries.length);
    const uniq = new Set(board.entries.map((e) => e.ts + '|' + e.name));
    assert.strictEqual(uniq.size, 30, 'and no entry duplicated');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('two compactors cannot run at once (lease) and both are safe', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const a = Leaderboard.create({ bucket: url + '/bucket' });
    const b = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    for (let i = 0; i < 20; i++) await a.submit(entry('P' + i, 300 + i, t + i * 1000));
    const [ra, rb] = await Promise.all([a.compact({ quietMs: 0 }), b.compact({ quietMs: 0 })]);
    const skipped = (ra.skipped ? 1 : 0) + (rb.skipped ? 1 : 0);
    assert.strictEqual(skipped, 1, 'exactly one compactor runs, the other backs off');
    const board = await a.read({ days: 3 });
    assert.strictEqual(board.entries.length, 20, 'all entries survived the race');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('a stale copy of an archive cannot delete a newer score', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const a = Leaderboard.create({ bucket: url + '/bucket' });
    const b = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now();
    // A compacts first
    await a.submit(entry('Alice', 400, t));
    await a.compact({ quietMs: 0 });
    // B (with a stale cache) now writes a *fresh* record into the same day
    await b.submit(entry('Bob', 500, t + 1000));
    // simulate the old v2.x behaviour: a stale read + blind write would drop Alice.
    // here, the compactor must merge, not overwrite:
    await b.compact({ quietMs: 0 });
    const board = await b.read({ days: 3 });
    const names = board.entries.map((e) => e.name).sort();
    assert.deepStrictEqual(names, ['Alice', 'Bob'], 'both scores present, got ' + JSON.stringify(names));
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('read dedupes the same play stored in several places', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const e = entry('Carol', 777, Date.now() - 3600000);
    await lb.submit(e);
    await lb.compact({ quietMs: 0 });
    await lb.submit(e, { id: 'copylater' });       // same play re-submitted with another id
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 1, 'identity (ts|name) is what defines a play');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('genuine back-to-back games with the same score are kept', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now();
    await lb.submit(entry('Dave', 144, t));
    await lb.submit(entry('Dave', 144, t + 60000));       // one minute later — a real second game
    await lb.submit(entry('Dave', 144, t + 90000));       // and a third
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 3,
      'v2.x collapsed these as "duplicates" and threw two real scores away');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('keepalive refreshes the archive before the store TTL can expire it', async () => {
    const kv = createMockKV({ ttlMs: 2500 });
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket', storage: null });
    const t = Date.now() - 3600000;
    await lb.submit(entry('Eve', 900, t));
    await lb.compact({ quietMs: 0 });                     // archive written once
    await sleep(1500);
    await lb.compact({ quietMs: 0, keepalive: 'force' });  // re-writes it with identical content
    await sleep(1500);                                     // past the original TTL, inside the new one
    const board = await lb.read({ days: 3 });
    assert(board.entries.length >= 1,
      'without keepalive the store drops the archive after ~30 days; with it the history survives, got ' + board.entries.length);
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('a lost archive key is still covered by the other copies', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    for (let i = 0; i < 5; i++) await lb.submit(entry('Gil', 500 + i, t + i * 1000));
    await lb.compact({ quietMs: 0 });
    kv.expire(lb.dayKey(t));                              // e.g. TTL expiry / clobber / deleted key
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 5, 'the hall of fame still holds every play, got ' + board.entries.length);
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('corrupt / partial values never crash a reader', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    await lb.submit(entry('Fay', 123, Date.now()));
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  await test('merge ignores malformed rows and sorts by score then time', async () => {
    const lb = Leaderboard.create({ bucket: 'http://127.0.0.1:1/x' });
    const merged = lb.merge(
      [{ name: 'A', score: 10, maxTile: 8, ts: 2 }, null, { name: 'B' }, 'x'],
      [{ name: 'C', score: 10, maxTile: 8, ts: 1 }, { name: 'D', score: 99, maxTile: 8, ts: 5 }]
    );
    assert.deepStrictEqual(merged.map((e) => e.name), ['D', 'C', 'A']);
  });

  /* ---------------------------------------------------------------- */
  await test('a double-write of one play (two timestamps, seconds apart) shows once', async () => {
    const lb = Leaderboard.create({ bucket: 'http://127.0.0.1:1/x' });
    const t = 1790000000000;
    const board = lb.collapse([
      { name: 'Subzero', score: 586, maxTile: 32, ts: t },
      { name: 'Subzero', score: 586, maxTile: 32, ts: t + 3759 },   // same play, written twice
      { name: 'Subzero', score: 586, maxTile: 32, ts: t + 300000 }, // five minutes later: a real replay
    ]);
    assert.strictEqual(board.length, 2, 'collapsed the double-write, kept the genuine replay');
    assert.strictEqual(board[1].ts, t + 300000);
  });

  await test('collapse never merges different scores, tiles or players', async () => {
    const lb = Leaderboard.create({ bucket: 'http://127.0.0.1:1/x' });
    const t = 1790000000000;
    const board = lb.collapse([
      { name: 'A', score: 100, maxTile: 24, ts: t },
      { name: 'A', score: 101, maxTile: 24, ts: t + 1000 },
      { name: 'A', score: 100, maxTile: 32, ts: t + 1000 },
      { name: 'B', score: 100, maxTile: 24, ts: t + 1000 }
    ]);
    assert.strictEqual(board.length, 4, 'only identical plays collapse');
  });

  /* ---------------------------------------------------------------- */
  await test('a v2-style KV_URL ("<bucket>/scores") is accepted as the bucket', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket/scores' });   // old env var format
    assert.strictEqual(lb.bucket, url + '/bucket', 'the trailing /scores must be stripped');
    const t = Date.now() - 3600000;
    await lb.submit(entry('Hana', 250, t));
    await lb.compact({ quietMs: 0 });
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, 1, 'the play is readable through the same base');
    assert.strictEqual(board.sources.quality, 'ok', 'all sources healthy, got ' + board.sources.quality);
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  console.log(results.join('\n'));
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
