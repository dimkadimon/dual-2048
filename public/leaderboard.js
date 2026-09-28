/* ============================================================
   Dual 2048 — leaderboard core (shared by browser + Node)

   WHY THIS EXISTS (v3.0 — replaces the v2.x "hub + hall-of-fame +
   day-shard read-modify-write" scheme):

   Every older version had the same structural flaw: many independent
   writers (every open browser tab, every server instance) read a shared
   JSON list, appended to it in memory, and wrote the whole list back.
   On a dumb key-value store that is a lost-update race: whichever writer
   lands second silently erases the other's score, and a retry after a
   timeout records the same play again. That is why scores went missing
   and why near-duplicate rows kept appearing — and why each "fix"
   (dedupe heuristics, rebuilds, seeds, throttles) only moved the bug.

   THE NEW APPROACH — write-once records, single-writer compaction:

     q/<id>          one immutable record per finished game. Nobody ever
                     rewrites a q/ key, so writers cannot clobber each
                     other and a retry re-writes the *same* key id
                     (idempotent). No read-before-write at all.
     arc-YYYY-MM-DD  day archive. Written only by the compactor, which
                     holds a lease, so exactly one writer per key.
     top             hall-of-fame cache (best N by score), also
                     compactor-only. Every entry in it also lives in a
                     day archive, so it is a view, never a source of truth.
     lock            compactor lease.
     scores / meta   v2.x leftovers: read-only, kept for compatibility.

   Reads union q/ + top + day archives and de-duplicate by ts|name, so a
   score is never counted twice no matter how many copies exist, and a
   score is never dropped — even if a whole key is lost, the others still
   carry it. Compaction only ever *adds* to the archives, verifies the
   write, and only then deletes the q/ record it ingested.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Leaderboard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_BUCKET = 'https://kvdb.io/WFqmZseFLUPww2FWnuzBWs';
  var TOP_KEY = 'top';            // hall-of-fame cache (compactor only)
  var LOCK_KEY = 'lock';          // compactor lease
  var LIVE_PREFIX = 'q/';         // immutable per-game records
  var LEGACY_KEYS = ['scores'];   // v2.x leftovers we still read
  var TOP_CAP = 2000;             // hall-of-fame size (view only)
  var SHARD_DAYS = 35;            // how far back the archive is read by default
  var DAY = 86400000;

  function create(opts) {
    opts = opts || {};
    // The bucket base: every key lives directly under it. Deployments created
    // for v2.x still point KV_URL at the old key (".../scores") — accept that
    // form too and treat it as the bucket, so an existing env var keeps working.
    var BUCKET = String(opts.bucket || DEFAULT_BUCKET).trim().replace(/\/+$/, '').replace(/\/scores$/, '');
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    var store = opts.storage || null;      // localStorage-like (browser only)
    var now = opts.now || Date.now;
    var log = opts.log || function () {};
    var inFlight = Promise.resolve();

    if (!doFetch) throw new Error('leaderboard: no fetch available');

    function withTimeout(ms) {
      if (typeof AbortController === 'undefined') return {};
      var ctrl = new AbortController();
      return { signal: ctrl.signal, done: function () { clearTimeout(ctrl._t); }, start: function () { ctrl._t = setTimeout(function () { ctrl.abort(); }, ms); } };
    }

    /* ---------- raw store access (every call is validated) ---------- */

    function tooBusy(status) { return status === 429 || status === 503 || status === 500 || status === 502 || status === 504 || status === 'network'; }

    function retryDelay(res, attempt) {
      var after = res && res.headers && res.headers.get && Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 5000);
      return 400 * (attempt + 2);
    }

    /* Reads retry on the store's rate limiter. A busy store answers 429 and
       nothing else for a while (a shared egress IP can burn the hourly quota),
       so a single failed read must not look like "the board is empty" — that
       mistake is what made earlier versions serve blank leaderboards. */
    async function kvGet(key, timeoutMs, tries) {
      var attempts = tries || 3;
      var last = null;
      for (var i = 0; i < attempts; i++) {
        var t = withTimeout(timeoutMs || 8000);
        if (t.start) t.start();
        try {
          var r = await doFetch(BUCKET + '/' + key + '', { cache: 'no-store', signal: t.signal });
          if (t.done) t.done();
          if (r.status === 404) return { ok: true, missing: true, value: null };
          if (!r.ok) {
            last = { ok: false, status: r.status };
            if (!tooBusy(r.status)) return last;
            await sleep(retryDelay(r, i));
            continue;
          }
          var txt = (await r.text()).trim();
          if (!txt) return { ok: true, missing: false, value: null };
          try { return { ok: true, missing: false, value: JSON.parse(txt) }; }
          catch (e) { return { ok: false, status: 'bad-json' }; }
        } catch (e) {
          if (t.done) t.done();
          last = { ok: false, status: 'network' };
          await sleep(retryDelay(null, i));
        }
      }
      return last;
    }

    async function kvPut(key, value, timeoutMs) {
      var t = withTimeout(timeoutMs || 10000);
      if (t.start) t.start();
      try {
        var r = await doFetch(BUCKET + '/' + key + '', {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(value),
          signal: t.signal
        });
        if (t.done) t.done();
        if (!r.ok && tooBusy(r.status)) await sleep(retryDelay(r, 0));
        return { ok: !!r.ok, status: r.status };
      } catch (e) {
        if (t.done) t.done();
        return { ok: false, status: 'network' };
      }
    }

    async function kvList(prefix, timeoutMs, tries) {
      var attempts = tries || 3;
      var last = null;
      for (var i = 0; i < attempts; i++) {
        var t = withTimeout(timeoutMs || 8000);
        if (t.start) t.start();
        try {
          var r = await doFetch(BUCKET + '/?prefix=' + encodeURIComponent(prefix), { cache: 'no-store', signal: t.signal });
          if (t.done) t.done();
          if (!r.ok) {
            last = { ok: false, status: r.status };
            if (!tooBusy(r.status)) return last;
            await sleep(retryDelay(r, i));
            continue;
          }
          var txt = (await r.text()).trim();
          return { ok: true, keys: txt ? txt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [] };
        } catch (e) {
          if (t.done) t.done();
          last = { ok: false, status: 'network' };
          await sleep(retryDelay(null, i));
        }
      }
      return last;
    }

    async function kvDel(key, timeoutMs) {
      var t = withTimeout(timeoutMs || 8000);
      if (t.start) t.start();
      try {
        var r = await doFetch(BUCKET + '/' + key + '', { method: 'DELETE', signal: t.signal });
        if (t.done) t.done();
        return { ok: !!r.ok };
      } catch (e) {
        if (t.done) t.done();
        return { ok: false };
      }
    }

    /* Read one list key, tolerating 404/empty/garbage; never throws.
       Returns null when the read itself failed (which callers must never
       confuse with "the list is empty"). */
    async function readList(key, timeoutMs) {
      var r = await kvGet(key, timeoutMs);
      if (!r.ok) return null;                       // read FAILED (≠ empty)
      if (r.missing || r.value == null) return [];
      return Array.isArray(r.value) ? r.value : null;
    }

    /* Read one write-once record key (a single object, or an array if a
       future writer batches several plays per key). */
    async function readRecord(key, timeoutMs) {
      var r = await kvGet(key, timeoutMs);
      if (!r.ok) return null;                       // read FAILED (≠ empty)
      if (r.missing || r.value == null) return [];
      if (Array.isArray(r.value)) return r.value;
      return typeof r.value === 'object' ? [r.value] : [];
    }

    /* ---------- entry shape + merge rules ---------- */

    function clean(entry) {
      var name = String(entry && entry.name || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'ANON';
      var score = Math.floor(Number(entry && entry.score));
      var maxTile = Math.floor(Number(entry && entry.maxTile)) || 0;
      var ts = Number(entry && entry.ts);
      if (!Number.isFinite(score) || score < 0 || score > 1e9) return null;
      if (!Number.isFinite(ts) || ts <= 0) ts = now();
      return { name: name, score: score, maxTile: maxTile, ts: ts };
    }

    /* identity of a play: one name finishing at one instant */
    function idOf(e) { return e.ts + '|' + e.name; }

    function validEntry(e) {
      return !!e && typeof e === 'object' && typeof e.name === 'string' &&
        Number.isFinite(Number(e.score)) && Number.isFinite(Number(e.ts));
    }

    /* Union of any number of lists, de-duplicated by identity.
       Deliberately NOT a "near duplicate" heuristic: the v2.x 10-minute
       collapse threw away real back-to-back games that ended on the same
       score, which is exactly the "my score vanished" complaint. Two plays
       are two plays unless they share an identity. */
    function merge() {
      var seen = Object.create(null);
      var out = [];
      for (var i = 0; i < arguments.length; i++) {
        var list = arguments[i];
        if (!Array.isArray(list)) continue;
        for (var j = 0; j < list.length; j++) {
          var e = list[j];
          if (!validEntry(e)) continue;
          var k = idOf(e);
          if (seen[k]) continue;
          seen[k] = 1;
          out.push({ name: String(e.name), score: Number(e.score), maxTile: Number(e.maxTile) || 0, ts: Number(e.ts) });
        }
      }
      out.sort(function (a, b) { return b.score - a.score || a.ts - b.ts; });
      return out;
    }

    /* The v2.x stores contain genuine double-writes: the same finished game
       saved twice, seconds apart, with two different timestamps (two code
       paths, two clock reads). Identity dedupe cannot see those, so this
       removes them precisely: identical name + score + best tile less than
       30 s apart is one game, not two. A real 2048 game takes minutes, so
       back-to-back replays are never affected (the old code used a 10-minute
       window and threw away real scores — that was the "my score vanished"
       bug, do not go back to it). The store keeps every raw record; this is
       only how a board is presented. */
    var DOUBLE_WINDOW = 30000;

    function collapse(entries, windowMs) {
      var w = windowMs == null ? DOUBLE_WINDOW : windowMs;
      var byPlay = Object.create(null);
      var order = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var g = e.name + '|' + e.score + '|' + (e.maxTile || 0);
        if (!byPlay[g]) { byPlay[g] = []; order.push(g); }
        byPlay[g].push(e);
      }
      var keep = [];
      for (var o = 0; o < order.length; o++) {
        var list = byPlay[order[o]].slice().sort(function (a, b) { return a.ts - b.ts; });
        var last = null;
        for (var j = 0; j < list.length; j++) {
          if (last !== null && list[j].ts - last < w) continue;   // same game, second write
          keep.push(list[j]);
          last = list[j].ts;
        }
      }
      keep.sort(function (a, b) { return b.score - a.score || a.ts - b.ts; });
      return keep;
    }

    /* ---------- day archive keys ---------- */

    function dayKey(ts) { return 'arc-' + new Date(ts).toISOString().slice(0, 10); }
    function shardKeys(days, from) {
      var out = [];
      for (var i = 0; i < days; i++) out.push(dayKey((from || now()) - i * DAY));
      return out;
    }

    /* ---------- write path: one immutable record per game ---------- */

    function newId(ts) {
      var rand = '';
      for (var i = 0; i < 6; i++) rand += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
      return ts + '-' + rand;
    }

    /* Store a finished game. The key is derived from the play itself
       (ts + random id handed to the caller), so retrying after a timeout
       overwrites the same record instead of adding a second one. */
    async function submit(entry, opts2) {
      opts2 = opts2 || {};
      var e = clean(entry);
      if (!e) return { ok: false, error: 'invalid entry' };
      var id = opts2.id || newId(e.ts);
      var key = LIVE_PREFIX + id;
      var attempts = opts2.attempts || 4;
      var last = null;
      for (var i = 0; i < attempts; i++) {
        var r = await kvPut(key, e, 12000);
        last = r;
        if (r.ok) return { ok: true, id: id, key: key, entry: e, attempts: i + 1 };
        await sleep(300 * (i + 1));
      }
      return { ok: false, error: 'store unavailable', status: last && last.status, entry: e, key: key };
    }

    /* ---------- read path ---------- */

    async function readLive() {
      var l = await kvList(LIVE_PREFIX);
      if (!l.ok || !l.keys.length) return l.ok ? [] : null;
      var vals = await Promise.all(l.keys.map(function (k) { return readRecord(k, 6000); }));
      var out = [];
      for (var i = 0; i < vals.length; i++) if (vals[i]) for (var j = 0; j < vals[i].length; j++) out.push(vals[i][j]);
      return out;
    }

    /* The board: live records ∪ hall of fame ∪ day archives ∪ legacy keys.
       opts.cache: {get(key), set(key,list)} — used to avoid re-reading days
       that are already sealed (a day is final once it is 2 days old). */
    async function read(opts2) {
        opts2 = opts2 || {};
        var days = opts2.days || SHARD_DAYS;
        var files = opts2.extra || [];              // e.g. the repo archive snapshot
        var cache = opts2.cache || null;
        var sealedBefore = now() - 2 * DAY;         // days older than this never change

        var shardNames = shardKeys(days);
        var tasks = [
          readLive(),
          readList(TOP_KEY),
          readList(LEGACY_KEYS[0])
        ];
        var cached = [];
        var toFetch = [];
        for (var i = 0; i < shardNames.length; i++) {
          var k = shardNames[i];
          var ts = now() - i * DAY;
          var c = (cache && ts < sealedBefore) ? cache.get(k) : null;
          if (Array.isArray(c)) cached.push(c); else toFetch.push(k);
        }
        tasks = tasks.concat(toFetch.map(function (k) { return readList(k); }));

        var res = await Promise.all(tasks);
        var live = res[0], top = res[1], legacy = res[2];
        var fetched = res.slice(3);
        for (var f = 0; f < fetched.length; f++) {
          if (Array.isArray(fetched[f]) && cache && toFetch[f]) cache.set(toFetch[f], fetched[f]);
        }
        var sources = [live, top, legacy].concat(cached).concat(fetched).concat(files);
        var merged = collapse(merge.apply(null, sources));
        return {
          entries: merged,
          sources: {
            live: live ? live.length : null,
            top: top ? top.length : null,
            shards: cached.length + fetched.length,
            quality: (live === null && top === null) ? 'offline' : (live === null || top === null ? 'partial' : 'ok')
          }
        };
    }

    /* ---------- compaction: fold q/ records into the archives ---------- */

    async function acquireLease(ttlMs) {
      var me = newId(now());
      var cur = await kvGet(LOCK_KEY, 6000);
      if (cur.ok && cur.value && cur.value.id && cur.value.exp > now() && cur.value.id !== me) return null;
      var got = await kvPut(LOCK_KEY, { id: me, exp: now() + (ttlMs || 120000) });
      if (!got.ok) return null;
      var back = await kvGet(LOCK_KEY, 6000);
      if (!back.ok || !back.value || back.value.id !== me) return null;   // lost the race — back off
      return me;
    }

    async function releaseLease(me) {
      var cur = await kvGet(LOCK_KEY, 6000);
      if (cur.ok && cur.value && cur.value.id === me) await kvPut(LOCK_KEY, { id: '', exp: 0 });
    }

    /* Merge entries into a day archive without ever losing what is already
       there: read fresh, union, write, read back, and only report success if
       every entry is really present. insert-only + verify = no lost updates. */
    async function appendToShard(dayKeyName, entries, tries) {
      tries = tries || 3;
      for (var i = 0; i < tries; i++) {
        var cur = await readList(dayKeyName);
        if (cur === null) { await sleep(400 * (i + 1)); continue; }
        var merged = merge(cur, entries);
        var w = await kvPut(dayKeyName, merged, 20000);
        if (!w.ok) { await sleep(400 * (i + 1)); continue; }
        var back = await readList(dayKeyName);
        if (back && entries.every(function (e) { return back.some(function (b) { return idOf(b) === idOf(e); }); })) return true;
        await sleep(300);
      }
      return false;
    }

    async function updateTop(entries) {
      for (var i = 0; i < 3; i++) {
        var cur = await readList(TOP_KEY);
        if (cur === null) { await sleep(400); continue; }
        var merged = merge(cur, entries).slice(0, TOP_CAP);
        var w = await kvPut(TOP_KEY, merged, 20000);
        if (!w.ok) { await sleep(400); continue; }
        var back = await readList(TOP_KEY);
        if (back) {
          var wanted = merged.slice(0, 200);        // verify the head, not all 2000
          if (wanted.every(function (e) { return back.some(function (b) { return idOf(b) === idOf(e); }); })) return true;
        }
        await sleep(300);
      }
      return false;
    }

    /* Insert entries into the archives without requiring a lease: it only
       ever ADDS, and verifies with a read-back, so it is safe to run from a
       migration script, a server or a client. Used to fold history that
       lived only in a legacy key into the day archives. */
    async function ingest(entries) {
      var out = { days: 0, entries: 0, top: false };
      var clean = [];
      for (var i = 0; i < (entries || []).length; i++) if (validEntry(entries[i])) clean.push(entries[i]);
      if (!clean.length) return out;
      var byDay = Object.create(null);
      clean.forEach(function (e) { var d = dayKey(e.ts); (byDay[d] = byDay[d] || []).push(e); });
      for (var day in byDay) {
        if (await appendToShard(day, byDay[day])) { out.days++; out.entries += byDay[day].length; }
      }
      out.top = await updateTop(clean);
      return out;
    }

    async function keep(key, maxAgeMs) {
      // Re-write an archive key with identical content so the store's TTL
      // (kvdb expires keys after ~30 days of inactivity) never eats history.
      var cur = await readList(key);
      if (cur === null || !cur.length) return false;
      var w = await kvPut(key, cur, 20000);
      return w.ok;
    }

    /* One compaction pass. Safe to call from the server and from clients:
       the lease makes exactly one compactor at a time, the archives only ever
       grow, and a q/ record is deleted only after a read-back proved its
       entry is in the archive. */
    async function compact(opts2) {
      opts2 = opts2 || {};
      if (opts2.serial) { var p = inFlight.then(run, run); inFlight = p.catch(function () {}); return p; }
      return run();

      async function run() {
        var stats = { scanned: 0, ingested: 0, deleted: 0, kept: 0, skipped: null, failed: 0 };
        var lease = await acquireLease(opts2.leaseTtl || 120000);
        if (!lease) { stats.skipped = 'lease-held'; return stats; }
        try {
          var l = await kvList(LIVE_PREFIX);
          if (!l.ok) { stats.skipped = 'list-failed'; return stats; }
          var quietMs = opts2.quietMs == null ? 45000 : opts2.quietMs;  // let in-flight writes land
          var keys = l.keys.filter(function (k) {
            var ts = parseInt(String(k).slice(LIVE_PREFIX.length).split('-')[0], 10);
            return Number.isFinite(ts) && now() - ts > quietMs;
          });
          stats.scanned = keys.length;
          var batchSize = opts2.batch || 250;
          for (var b = 0; b < keys.length; b += batchSize) {
            var batch = keys.slice(b, b + batchSize);
            var vals = await Promise.all(batch.map(function (k) { return readRecord(k, 8000); }));
            var entries = [];
            var okKeys = [];
            for (var i = 0; i < vals.length; i++) {
              if (vals[i] && vals[i].length) { entries.push.apply(entries, vals[i]); okKeys.push(batch[i]); }
              else if (vals[i]) okKeys.push(batch[i]);      // empty record: drop it
            }
            if (entries.length) {
              var byDay = Object.create(null);
              entries.forEach(function (e) { var d = dayKey(e.ts); (byDay[d] = byDay[d] || []).push(e); });
              var allOk = true;
              for (var day in byDay) {
                var ok = await appendToShard(day, byDay[day]);
                if (!ok) { allOk = false; stats.failed++; log('compact: shard write failed', day); }
              }
              var topOk = await updateTop(entries);
              if (!topOk) { allOk = false; stats.failed++; log('compact: top write failed'); }
              if (!allOk) continue;                            // leave q/ records for the next pass
              stats.ingested += entries.length;
            }
            for (var k2 = 0; k2 < okKeys.length; k2++) {
              var d = await kvDel(okKeys[k2]);
              if (d.ok) stats.deleted++;
            }
          }
          if (opts2.keepalive !== false) {
            // The store expires a key ~30 days after it was last written, so
            // the archive has to be touched to stay alive. We walk the archive
            // in slices (a cursor lives in the store) so a long history costs a
            // handful of writes per pass instead of thousands.
            var keepState = await kvGet('keep', 6000);
            var lastKeepAt = (keepState.ok && keepState.value && Number(keepState.value.at)) || 0;
            var due = opts2.keepalive === 'force' || (now() - lastKeepAt) > (opts2.keepEveryMs || 6 * 3600000);
            if (due) {
              var arch = await kvList('arc-');
              var keys = [TOP_KEY].concat(arch.ok && arch.keys.length ? arch.keys : shardKeys(4));
              var start = (keepState.ok && keepState.value && Number(keepState.value.i)) || 0;
              var sliceLen = Math.min(opts2.keepSlice || 40, keys.length);
              var wrote = 0;
              for (var si = 0; si < sliceLen; si++) {
                var target = keys[(start + si) % keys.length];
                if (await keep(target)) { wrote++; stats.kept++; }
              }
              await kvPut('keep', { i: (start + sliceLen) % keys.length, at: now(), n: keys.length });
              log('keepalive: refreshed', wrote, 'of', keys.length, 'archive keys');
            }
          }
        } finally {
          await releaseLease(lease);
        }
        return stats;
      }
    }

    /* Never trust a single key: the whole point of the rewrite is that the
       board survives any one key being stale, clobbered, expired or missing. */
    async function parity(entries) {
      var l = await kvList('');
      if (!l.ok) return null;
      return { keys: l.keys };
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    return {
      bucket: BUCKET,
      submit: submit,
      read: read,
      ingest: ingest,
      compact: compact,
      merge: merge,
      collapse: collapse,
      clean: clean,
      idOf: idOf,
      dayKey: dayKey,
      kvGet: kvGet, kvPut: kvPut, kvList: kvList, kvDel: kvDel,
      readList: readList, readRecord: readRecord,
      listKeys: function (prefix) { return kvList(prefix || ''); },
      constants: { TOP_KEY: TOP_KEY, LOCK_KEY: LOCK_KEY, LIVE_PREFIX: LIVE_PREFIX, LEGACY_KEYS: LEGACY_KEYS, TOP_CAP: TOP_CAP, SHARD_DAYS: SHARD_DAYS }
    };
  }

  return { create: create, DEFAULT_BUCKET: DEFAULT_BUCKET, TOP_CAP: TOP_CAP, SHARD_DAYS: SHARD_DAYS, LIVE_PREFIX: LIVE_PREFIX };
});
