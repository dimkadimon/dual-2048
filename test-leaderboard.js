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
    kv.fail('get', 'top', 99, 429);   // the store stays busy for this key
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.sources.quality, 'partial', 'a failed source must be flagged, not reported as zero');
    assert(board.entries.length >= 1, 'entries from healthy sources are still returned, got ' + board.entries.length);
    assert.strictEqual(board.entries.length, 1, 'and the healthy day archive still carries the play');
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
  await test('a rate-limited store (429) is retried, not mistaken for an empty board', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const a = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    await a.submit(entry('Ivan', 640, t));
    await a.compact({ quietMs: 0 });
    kv.fail('get', 'top', 2, 429);       // the store is busy for the first two tries
    kv.fail('list', 'q/', 1, 429);
    const b = Leaderboard.create({ bucket: url + '/bucket' });
    const board = await b.read({ days: 3 });
    assert.strictEqual(board.sources.quality, 'ok', 'reads recovered after the limiter cleared, got ' + board.sources.quality);
    assert.strictEqual(board.entries.length, 1, 'the play is on the board, got ' + board.entries.length);
    await kv.stop();
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

  /* ------------------------------------------------------------------
     Regressions for the "my new score does not show up" reports. Each one
     reproduces a real failure of the deployed client.
     ---------------------------------------------------------------- */

  await test('a truncated (unparseable) hall of fame is rebuilt, never overwritten with nothing', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    // 20 archived plays ...
    for (let i = 0; i < 20; i++) await lb.submit(entry('Arch' + i, 500 + i, t + i * 1000));
    await lb.compact({ quietMs: 0 });
    // ... and the exact corruption found in the live store: `top` cut off
    // mid-row, which JSON.parse rejects
    const good = kv.dump()['top'];
    kv.put('top', good.slice(0, Math.floor(good.length / 2)));
    // a new play arrives: it must land in the archive AND `top` must recover
    const fresh = entry('Nekras', 878, Date.now() - 60000);
    const r = await lb.submit(fresh);
    assert(r.ok, 'submit works while top is corrupt');
    await lb.compact({ quietMs: 0 });
    const raw = JSON.parse(kv.dump()['top']);
    assert(Array.isArray(raw), 'top parses again');
    assert(raw.some((e) => e.name === 'Nekras' && e.score === 878), 'the new play is in the hall of fame');
    assert(raw.filter((e) => e.name.startsWith('Arch')).length === 20,
      'and the rebuilt hall of fame still holds every archived play, got ' +
      raw.filter((e) => e.name.startsWith('Arch')).length);
    await kv.stop();
  });

  await test('a big day is chunked so no archive key can be truncated', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 7200000;
    const n = 1600;                                  // more than one chunk
    const plays = [];
    for (let i = 0; i < n; i++) plays.push(entry('Bulk' + (i % 7), 100 + i, t + i * 100));
    const res = await lb.ingest(plays);
    assert.strictEqual(res.entries, n, 'every play was ingested, got ' + res.entries);
    const day = lb.dayKey(t);
    const dayKeys = kv.keys().filter((k) => k === day || k.indexOf(day + '.') === 0);
    assert(dayKeys.length > 1, 'the day spills into more than one key, got ' + dayKeys.length);
    for (const k of dayKeys) {
      const rows = JSON.parse(kv.dump()[k]);
      assert(rows.length <= 1500, k + ' stays small, got ' + rows.length + ' rows');
    }
    const board = await lb.read({ days: 3 });
    assert.strictEqual(board.entries.length, n, 'all plays are on the board, got ' + board.entries.length);
    await kv.stop();
  });

  await test('plays that only exist in an old arc-<timestamp> snapshot are still shown', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 30 * 86400000;
    // a v2.x full-board snapshot: keys no v2.x reader ever asked for
    kv.put('arc-' + (t - 1000), JSON.stringify([
      entry('Lukomor', 589, t, 48), entry('Nekras', 878, t + 1000, 64)
    ]));
    await lb.submit(entry('Newcomer', 300, Date.now() - 60000));
    const current = await lb.read({ days: 3 });
    assert(!current.entries.some((e) => e.name === 'Lukomor'), 'a recent-days board does not need to read 35 snapshots');
    const full = await lb.read({ days: 400, history: true });
    assert(full.entries.some((e) => e.name === 'Lukomor' && e.score === 589), 'the history read recovers Lukomor');
    assert(full.entries.some((e) => e.name === 'Nekras' && e.score === 878), 'and Nekras');
    assert.strictEqual(full.entries.length, 3, 'every play exactly once, got ' + full.entries.length);
    await kv.stop();
  });

  await test('a new play is visible on the very next read (no stale board after a submit)', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    // an existing board ...
    for (let i = 0; i < 5; i++) await lb.submit(entry('Veteran', 400 + i, Date.now() - 600000 + i * 1000));
    // ... plus a play submitted while a compaction is running
    kv.fail('put', 'arc-', 1, 500);
    const compacting = lb.compact({ quietMs: 0 });
    const r = await lb.submit(entry('Nekras', 878, Date.now()));
    assert(r.ok, 'submit succeeds during compaction');
    await compacting;
    const board = await lb.read({ days: 3 });
    assert(board.entries.some((e) => e.name === 'Nekras' && e.score === 878),
      'the new play is on the board immediately');
    assert.strictEqual(board.entries.length, 6, 'nothing was lost, got ' + board.entries.length);
    await kv.stop();
  });

  /* ------------------------------------------------------------------
     "My new score is on the in-game top 10 but not on the full board."
     The in-game list and the full board are two different readers; when the
     store starts refusing a host (kvdb rate-limits by IP) the full board used
     to fall back to the committed snapshot alone, which is hours old.
     ---------------------------------------------------------------- */

  await test('a cached day is reused instead of re-downloaded (fewer requests, fewer 429s)', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    await lb.submit(entry('Cached', 700, t));
    await lb.compact({ quietMs: 0 });
    const store = {};
    const marks = {};
    const cache = {
      get: (k) => (Array.isArray(store[k]) ? store[k] : null),
      set: (k, v) => { store[k] = v; marks[k] = Date.now(); },
      mark: (k) => marks[k] || 0
    };
    const before = kv.opCount.get;
    const first = await lb.read({ days: 40, cache });
    const afterFirst = kv.opCount.get;
    const second = await lb.read({ days: 40, cache });
    const afterSecond = kv.opCount.get;
    assert.strictEqual(first.entries.length, 1, 'the play is on the board');
    assert.strictEqual(second.entries.length, 1, 'and still there on the second read');
    const firstCost = afterFirst - before;
    const secondCost = afterSecond - afterFirst;
    assert(secondCost < firstCost,
      'the warm read must cost fewer requests (' + secondCost + ' vs ' + firstCost + ')');
    assert(second.sources.cached > 0, 'and it reports the cache hit, got ' + second.sources.cached);
    await kv.stop();
  });

  await test('the light read (in-game board) finds a play with three requests', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    await lb.submit(entry('Broski', 949, Date.now() - 60000, 96));
    const before = kv.opCount.get + kv.opCount.list;
    const r = await lb.read({ light: true });
    const cost = (kv.opCount.get + kv.opCount.list) - before;
    assert(r.entries.some((e) => e.name === 'Broski' && e.score === 949), 'the new play is found');
    assert(cost <= 4, 'a light read must stay cheap, used ' + cost + ' requests');
    await kv.stop();
  });

  await test('a board whose store reads all fail can still be completed from other sources', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    await lb.submit(entry('Broski', 949, Date.now() - 60000, 96));
    kv.fail('get', '', 9999, 429);
    kv.fail('list', '', 9999, 429);
    const store = await lb.read({ days: 40 });
    assert.strictEqual(store.entries.length, 0, 'the store really is unreadable');
    assert.strictEqual(store.sources.quality, 'offline', 'and it says so, got ' + store.sources.quality);
    // what the page must do: union whatever else answered (api / snapshot / cache)
    const fromApi = [entry('Broski', 949, Date.now() - 60000, 96)];
    const merged = lb.merge(store.entries, fromApi);
    assert(merged.some((e) => e.name === 'Broski' && e.score === 949),
      'a score known to another source must reach the board when the store refuses this host');
    await kv.stop();
  });

  /* ------------------------------------------------------------------
     A day shard is the only key that gets read-modify-written. Between the
     moments a record is compacted and someone re-ingests it, another writer can
     re-PUT the whole day from its own stale copy — and the play disappears from
     the store entirely (it was only still visible in one server's memory).
     ---------------------------------------------------------------- */
  await test('ingest verifies its writes, and re-adds a play another writer erased', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const t = Date.now() - 3600000;
    const target = entry('Natalia', 931, t + 5000, 96);

    // first ingest puts it in the day archive
    await lb.ingest([entry('Warmup', 100, t + 1000)]);
    await lb.ingest([target]);
    const day = lb.dayKey(t);
    assert(JSON.parse(kv.dump()[day]).some((e) => e.ts === target.ts), 'the play is archived');

    // ... and then a stale writer re-PUTs the whole day without it (the v2.x bug)
    kv.put(day, JSON.stringify([entry('Warmup', 100, t + 1000)]));
    assert(!JSON.parse(kv.dump()[day]).some((e) => e.ts === target.ts), 'the clobber happened');

    // a re-ingest must notice and put it back instead of trusting the PUT
    const res = await lb.ingest([target]);
    assert(res.repaired >= 1, 'the repair pass noticed the missing play, got ' + res.repaired);
    assert(JSON.parse(kv.dump()[day]).some((e) => e.ts === target.ts),
      'the play is back in the day archive after the repair');
    const board = await lb.read({ days: 3 });
    assert(board.entries.some((e) => e.ts === target.ts && e.name === 'Natalia'), 'and it is on the board');
    await kv.stop();
  });

  /* ------------------------------------------------------------------
     A name correction: the store is append-only, so the corrected play is
     submitted again and the old row is retired. Every reader merges through
     merge(), so a copy of the old row in a server cache, a browser's saved board
     or an older snapshot cannot put it back.
     ---------------------------------------------------------------- */
  await test('a retired row stays retired, whatever a source still hands us', async () => {
    const ts = 1793932031973;
    const oldRow = entry('ANON', 931, ts, 96);
    const newRow = entry('Natalia', 931, ts, 96);

    // a source (stale cache / saved board / older snapshot) still has the old row
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    kv.put('arc-2026-11-06', JSON.stringify([oldRow, newRow, entry('Other', 500, ts + 10)]));
    kv.put('top', JSON.stringify([oldRow, newRow]));

    const board = await lb.read({ days: 3 });
    assert(!board.entries.some((e) => e.ts === ts && e.name === 'ANON'), 'the retired row is gone from the board');
    assert(board.entries.some((e) => e.ts === ts && e.name === 'Natalia' && e.score === 931), 'the corrected row is there');
    assert(board.entries.some((e) => e.name === 'Other'), 'unrelated plays are untouched');

    // the same guard applies when merging a saved board with a fresh read
    const merged = lb.merge([oldRow], [newRow]);
    assert(merged.length === 1 && merged[0].name === 'Natalia', 'merge() drops the retired duplicate');
    await kv.stop();
  });

  await test('a retirement recorded in the store also applies to later reads', async () => {
    const kv = createMockKV();
    const url = await kv.start();
    const lb = Leaderboard.create({ bucket: url + '/bucket' });
    const ts = Date.now() - 7200000;
    kv.put('arc-2026-11-06', JSON.stringify([entry('Zed', 700, ts)]));
    const res = await lb.retire(ts, 'Zed', 'Zoe');
    assert(res.ok, 'the retirement was stored, got ' + res.status);
    assert(JSON.parse(kv.dump().superseded).length === 1, 'one retirement in the store');
    const board = await lb.read({ days: 3 });
    assert(!board.entries.some((e) => e.ts === ts), 'the retired play is not on the board');
    // and a second retirement of the same pair does not duplicate the record
    await lb.retire(ts, 'Zed', 'Zoe');
    assert(JSON.parse(kv.dump().superseded).length === 1, 'retiring twice keeps one record');
    await kv.stop();
  });

  /* ---------------------------------------------------------------- */
  console.log(results.join('\n'));
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
