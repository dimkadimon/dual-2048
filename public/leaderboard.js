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
  /* ============================ MODES ============================
     A mode is how many walls a game has. It is part of a play's identity.

     `hard` (2 walls) is the original game and the DEFAULT: every record written
     before modes existed has no `mode` field at all, so "no mode" means hard —
     which is why the whole existing leaderboard is the hard leaderboard with
     nothing to copy, rewrite or risk. Easy and medium write `mode: 'easy'` /
     `mode: 'medium'` on every record.

     Storage mirrors that: hard keeps the original keys (`top`,
     `arc-YYYY-MM-DD`), while a new mode gets its own keys (`top:medium`,
     `arc-YYYY-MM-DD:medium`, …). Old readers therefore cannot see, count or
     overwrite the new modes, and new readers are strict: an easy/medium board
     only accepts records that explicitly say so. A hard board reads both
     `hard` and untagged records, so a stray untagged record can never appear
     on the wrong board, and no untagged play can be lost. */
  var MODES = {
    easy:   { id: 'easy',   walls: 0, label: 'Easy',   wallsLabel: 'no walls' },
    medium: { id: 'medium', walls: 1, label: 'Medium', wallsLabel: '1 wall' },
    hard:   { id: 'hard',   walls: 2, label: 'Hard',   wallsLabel: '2 walls' }
  };
  var MODE_ORDER = ['easy', 'medium', 'hard'];
  var DEFAULT_MODE = 'hard';

  function modeInfo(m) {
    if (m === 'hard' || m == null || m === '') return MODES.hard;
    return MODES[m] || MODES.hard;
  }
  /* the mode a stored record belongs to (untagged = hard, see above) */
  function modeOf(e) {
    if (!e || e.mode == null || e.mode === '') return DEFAULT_MODE;
    return MODES[e.mode] ? e.mode : DEFAULT_MODE;
  }
  /* hard keeps the historic key names, so nothing had to be migrated */
  function modeSuffix(m) { return m === DEFAULT_MODE ? '' : ':' + m; }

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
          catch (e) {
            // 2xx but unparseable. The store does this for oversized values
            // (truncated body) and, occasionally, when it is under load. Callers
            // treat it as "unknown", never as "empty".
            return { ok: false, status: 'bad-json', httpStatus: r.status, bytes: txt.length, body: txt.slice(0, 120) };
          }
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
      var mode = entry && entry.mode != null && MODES[entry.mode] ? entry.mode : null;
      var out = { name: name, score: score, maxTile: maxTile, ts: ts };
      // hard is the default, and is stored exactly as it always was
      if (mode && mode !== DEFAULT_MODE) out.mode = mode;
      return out;
    }

    /* identity of a play: one name finishing at one instant, in one mode.
       The mode is part of it, so the same instant in two modes is two plays
       and the day archives of the two modes can never be mistaken for each
       other's duplicates. */
    function idOf(e) { return e.ts + '|' + e.name + '|' + modeOf(e); }

    function validEntry(e) {
      return !!e && typeof e === 'object' && typeof e.name === 'string' &&
        Number.isFinite(Number(e.score)) && Number.isFinite(Number(e.ts));
    }

    /* Union of any number of lists, de-duplicated by identity.
       Deliberately NOT a "near duplicate" heuristic: the v2.x 10-minute
       collapse threw away real back-to-back games that ended on the same
       score, which is exactly the "my score vanished" complaint. Two plays
       are two plays unless they share an identity. */
    /* A corrected play. The store is append-only, so a row whose name had to be
       fixed cannot be overwritten in place: the play is submitted again under the
       right name and the old (timestamp, name) pair is retired here. Retired pairs
       are dropped by merge(), which every reader and every writer goes through —
       so a copy sitting in a browser's saved board, in a server's memory, or in an
       older snapshot cannot resurrect the old row. */
    var SUPERSEDED_KEY = 'superseded';
    var SUPERSEDED = [
      { ts: 1793932031973, name: 'ANON', replacedBy: 'Natalia' }   // 2026-11-06, score 931
    ];
    var retired = Object.create(null);
    function rebuildRetired(extra) {
      retired = Object.create(null);
      var all = SUPERSEDED.concat(Array.isArray(extra) ? extra : []);
      for (var i = 0; i < all.length; i++) {
        var r = all[i];
        if (r && Number(r.ts) > 0 && r.name != null) retired[Number(r.ts) + '|' + String(r.name).toUpperCase()] = 1;
      }
    }
    rebuildRetired(null);

    /* Retire a play in the store too, so the rule survives a redeploy. */
    async function retire(ts, name, replacedBy) {
      var cur = (await readRecord(SUPERSEDED_KEY)) || [];
      var rec = { ts: Number(ts), name: String(name), replacedBy: replacedBy ? String(replacedBy) : null, at: now() };
      var next = cur.filter(function (e) { return !(Number(e.ts) === rec.ts && String(e.name).toUpperCase() === rec.name.toUpperCase()); });
      next.push(rec);
      var res = await kvPut(SUPERSEDED_KEY, next);
      rebuildRetired(next);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, list: next };
    }

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
          var rec = { name: String(e.name), score: Number(e.score), maxTile: Number(e.maxTile) || 0, ts: Number(e.ts) };
          if (modeOf(e) !== DEFAULT_MODE) rec.mode = modeOf(e);
          out.push(rec);
        }
      }
      var kept = [];
      for (var q = 0; q < out.length; q++) {
        if (!retired[out[q].ts + '|' + out[q].name.toUpperCase()]) kept.push(out[q]);
      }
      kept.sort(function (a, b) { return b.score - a.score || a.ts - b.ts; });
      return kept;
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

    function dayKey(ts, mode) {
      return 'arc-' + new Date(ts).toISOString().slice(0, 10) + modeSuffix(modeInfo(mode).id);
    }

    /* A day is one key while it is small and several keys once it is not:

         arc-YYYY-MM-DD      chunk 0 (the day's first CHUNK_MAX entries)
         arc-YYYY-MM-DD.1   chunk 1 (the next CHUNK_MAX entries)
         arc-YYYY-MM-DD.2   …

       Chunks are append-only: a chunk is written only while it has room, and
       once full it never changes again. So no archive key has to be rewritten
       forever, and — the reason this matters — no archive key ever grows past
       CHUNK_MAX rows. kvdb accepts a large value but can then serve a
       TRUNCATED copy of it (the live `top` key is exactly that today: valid
       JSON cut off in the middle of a row). Small keys cannot do that. */
    var CHUNK_MAX = 1500;                         // rows per archive chunk

    function chunkKey(day, i) { return i ? day + '.' + i : day; }
    function chunkIndex(key, day) {
      return key === day ? 0 : parseInt(String(key).slice(day.length + 1), 10);
    }

    // every day key in the window (chunk 0 only; used when listing fails)
    function shardKeys(days, from) {
      var out = [];
      for (var i = 0; i < days; i++) out.push(dayKey((from || now()) - i * DAY));
      return out;
    }

    /* ---------- write path: one immutable record per game ---------- */

    /* Live-record key. Hard keeps the historic `q/<id>`; a new mode appends
       `:<mode>` so an old client's `q/` listing cannot see or clobber it. */
    function liveKeyFor(id, mode) { return LIVE_PREFIX + id + modeSuffix(mode); }

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
      var key = liveKeyFor(id, modeOf(e));
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

    async function readLive(mode) {
      var m = modeInfo(mode).id;
      var l = await kvList(LIVE_PREFIX);
      if (!l.ok) return null;
      // easy/medium records carry the mode in their key (see submit)
      if (m !== DEFAULT_MODE) l.keys = l.keys.filter(function (k) { return k.slice(-(m.length + 1)) === ':' + m; });
      if (!l.keys.length) return [];
      // Read in small batches, not all at once: 1000 parallel GETs from one
      // browser is exactly how a host earns a 429, and a 429 on a record read
      // used to look like "that play does not exist".
      var out = [];
      var BATCH = 8;
      for (var b = 0; b < l.keys.length; b += BATCH) {
        var batch = l.keys.slice(b, b + BATCH);
        var vals = await Promise.all(batch.map(function (k) { return readRecord(k, 6000); }));
        for (var i = 0; i < vals.length; i++) if (vals[i]) for (var j = 0; j < vals[i].length; j++) out.push(vals[i][j]);
      }
      return out;
    }

    /* The store also holds `arc-<timestamp>` keys: full-board snapshots written
       by v2.x that no v2.x reader ever looked at (it only ever requested
       hard-coded key names). They contain real plays that exist nowhere else, so
       a board that wants the *history* reads them too. They are insert-only and
       never written by this code again. */
    async function readLegacySnapshots() {
      var l = await kvList('arc-');
      if (!l.ok) return null;
      var snap = l.keys.filter(function (k) { return /^arc-\d{9,}$/.test(k); });
      if (!snap.length) return [];
      var out = [];
      for (var i = 0; i < snap.length; i++) {
        var rows = await readList(snap[i], 20000);
        if (rows) out.push.apply(out, rows);
      }
      return out;
    }

    /* Which archive keys exist, in one request. Listing beats guessing: the
       guess was 35 hard-coded day names (28 of which usually do not exist) and
       it could not see the `arc-<timestamp>` snapshots at all. */
    async function archiveKeys(mode) {
      var m = modeInfo(mode).id;
      var l = await kvList('arc-');
      if (!l.ok) return null;
      var days = [], legacy = [];
      for (var i = 0; i < l.keys.length; i++) {
        var k = l.keys[i];
        if (!keyInMode(k, m)) continue;          // another mode's archives stay out of sight
        if (/^arc-\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(k)) days.push(k);
        else if (/^arc-\d{9,}$/.test(k)) legacy.push(k);
      }
      return { days: days, legacy: legacy };
    }

    /* Is this archive key part of `mode`? Hard owns the untagged keys. */
    function keyInMode(k, m) {
      if (m === DEFAULT_MODE) return !/:(easy|medium)$/.test(k);
      return k.slice(-(m.length + 1)) === ':' + m;
    }

    /* The board: live records ∪ hall of fame ∪ day archives ∪ legacy keys.
       opts.cache: {get(key), set(key,list)} — used to avoid re-reading days
       that are already sealed (a day is final once it is 2 days old).
       opts.days: how far back to read (default SHARD_DAYS).
       opts.history: also read the v2.x `arc-<timestamp>` snapshots. */
    /* ---- cheap reads ----
       Every full read used to be 1 list + 3 GETs, and the full board added 24-35
       more. A shared or busy IP hits the store's rate limiter quickly, and before
       this the whole board then fell back to a stale snapshot — which is exactly
       "my new score is missing from the full leaderboard". So the cache is used
       for EVERY day (not just sealed ones, so a warm cache costs 3 requests),
       anything already fetched is reused, and one retry turns a transient 429
       into a success instead of a miss. */
    var READ_CACHE_MS = 10 * 60000;               // the hot keys are re-read at most every 10 min

    async function readFresh(key, cache) {
      if (cache && cache.mark) {
        var hit = cache.get(key);
        if (Array.isArray(hit) && cache.mark(key) && now() - cache.mark(key) < READ_CACHE_MS) return hit;
      }
      var rows = await readList(key, 20000);
      if (Array.isArray(rows) && cache && cache.set) cache.set(key, rows);
      return rows;
    }

    /* The board: live records ∪ hall of fame ∪ day archives ∪ legacy keys.
       opts.cache: {get(key), set(key,list), mark?(key) -> last fetch time}
       opts.days: how far back to read (default SHARD_DAYS)
       opts.history: also read the v2.x `arc-<timestamp>` snapshots
       opts.light: read the three hot keys only (the in-game board) */
    /* Board read for ONE mode. opts.mode: 'easy' | 'medium' | 'hard' (default).
       A hard read accepts untagged and `hard` records; easy/medium accept only
       their own tag, so a board can never show another mode's play. */
    async function read(opts2) {
        opts2 = opts2 || {};
        var mode = modeInfo(opts2.mode).id;
        var days = opts2.days || SHARD_DAYS;
        var files = opts2.extra || [];              // e.g. the repo archive snapshot
        if (!opts2.light) {
          // retirements recorded in the store (the built-in list always applies)
          var supp = await readRecord(SUPERSEDED_KEY);
          if (Array.isArray(supp) && supp.length) rebuildRetired(supp);
        }
        var cache = opts2.cache || null;
        var oldest = now() - (days - 1) * DAY;

        // one listing tells us which archive keys exist (listing beats guessing:
        // the guess covered 28 day names that usually do not exist and could not
        // see the `arc-<timestamp>` snapshots at all)
        var listing = opts2.light ? null : await archiveKeys(mode);

        var topKey = TOP_KEY + modeSuffix(mode);
        var tasks = [
          readLive(mode),
          readFresh(topKey, cache)
        ];
        // the v2.x `scores` key is untagged history, i.e. hard-mode plays only
        if (mode === DEFAULT_MODE) tasks.push(readFresh(LEGACY_KEYS[0], cache));
        var shardNames = [];

        if (listing) {
          for (var n = 0; n < listing.days.length; n++) {
            var k = listing.days[n];
            var dayTs = Date.parse(k.slice(4, 14) + 'T00:00:00Z');
            if (!Number.isFinite(dayTs) || dayTs < oldest - DAY) continue;
            shardNames.push(k);
          }
          if (opts2.history) {
            for (var h = 0; h < listing.legacy.length; h++) tasks.push(readFresh(listing.legacy[h], cache));
          }
        } else if (!opts2.light) {
          shardNames = shardKeys(days);             // listing failed: fall back to guessed days
        }

        var fromCache = 0;
        for (var i = 0; i < shardNames.length; i++) {
          var c = cache && cache.get ? cache.get(shardNames[i]) : null;
          if (Array.isArray(c)) fromCache++;
        }
        tasks = tasks.concat(shardNames.map(function (k) { return readFresh(k, cache); }));

        var res = await Promise.all(tasks);
        var live = res[0], top = res[1], legacy = res[2];
        var shards = res.slice(3);

        if (live === null || top === null) {
          // a failed read must never look like an empty one: try once more
          await sleep(600);
          if (live === null) live = await readLive(mode);
          if (top === null) top = await readFresh(topKey, null);
        }

        var sources = [live, top, legacy].concat(shards).concat(files);
        var merged = collapse(merge.apply(null, sources).filter(function (e) { return modeOf(e) === mode; }));
        return {
          mode: mode,
          entries: merged,
          sources: {
            live: live ? live.length : null,
            top: top ? top.length : null,
            shards: shards.filter(Array.isArray).length,
            cached: fromCache,
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
       every entry is really present. insert-only + verify = no lost updates.

       `dayKeyName` is the day's first key (`arc-YYYY-MM-DD`); the entries go
       into its chunks (see CHUNK_MAX) so that no archive key grows past a size
       the store can serve back intact. A chunk that already holds an entry is
       not touched — that entry is archived already. */
    async function appendToShard(dayKeyName, entries, tries, counter) {
      tries = tries || 3;
      for (var i = 0; i < tries; i++) {
        // the day's chunks, in order
        var listing = await kvList(dayKeyName, 10000);
        if (!listing.ok) { await sleep(400 * (i + 1)); continue; }
        var keys = listing.keys.filter(function (k) {
          return k === dayKeyName || k.indexOf(dayKeyName + '.') === 0;
        }).sort(function (a, b) { return chunkIndex(a, dayKeyName) - chunkIndex(b, dayKeyName); });
        if (!keys.length) keys = [dayKeyName];

        var chunks = [];
        var readFailed = false;
        for (var c = 0; c < keys.length; c++) {
          var rows = await readList(keys[c], 20000);
          if (rows === null) { readFailed = true; break; }     // unknown state: never write blind
          chunks.push(rows);
        }
        if (readFailed) { await sleep(400 * (i + 1)); continue; }

        var have = Object.create(null);
        for (var ch = 0; ch < chunks.length; ch++) {
          for (var j = 0; j < chunks[ch].length; j++) have[idOf(chunks[ch][j])] = true;
        }
        var todo = [];
        for (var t = 0; t < entries.length; t++) if (!have[idOf(entries[t])]) todo.push(entries[t]);
        if (!todo.length) return true;                          // everything is archived already
        if (counter) counter.added += todo.length;              // entries the store was missing

        // append to the last chunk while it has room, then start a new one
        var added = chunks.map(function () { return []; });
        for (var e = 0; e < todo.length; e++) {
          var last = chunks.length - 1;
          if (chunks[last].length + added[last].length >= CHUNK_MAX) {
            chunks.push([]);
            added.push([]);
            last++;
          }
          added[last].push(todo[e]);
        }

        var ok = true;
        for (var w = 0; w < chunks.length; w++) {
          if (!added[w].length) continue;
          var key = chunkKey(dayKeyName, w);
          var merged = merge(chunks[w], added[w]);
          var put = await kvPut(key, merged, 20000);
          if (!put.ok) { ok = false; continue; }
          var back = await readList(key, 20000);
          if (!back) { ok = false; continue; }
          var backIds = Object.create(null);
          for (var q = 0; q < back.length; q++) backIds[idOf(back[q])] = true;
          for (var a = 0; a < added[w].length; a++) {
            if (!backIds[idOf(added[w][a])]) { ok = false; break; }
          }
        }
        if (ok) return true;
        await sleep(400 * (i + 1));
      }
      return false;
    }

    /* `top` is a cache of the best plays, and it is the one key every client
       *writes* (the hall of fame is derived, not authoritative). A single
       oversized PUT has already left a truncated, unparseable value in the live
       store, and a reader that treats "unparseable" as "empty" would both serve
       an empty board and overwrite the real list on the next write.
       So: never write over a list that failed to parse, and rebuild it from the
       archives (which are write-once / small-key and therefore intact). */
    async function updateTop(entries, mode) {
      var m = modeInfo(mode).id;
      var topKey = TOP_KEY + modeSuffix(m);
      for (var i = 0; i < 3; i++) {
        var raw = await kvGet(topKey, 6000);
        // 'bad-json' = the store returned something that is not a list: a
        // truncated value (exactly what the live `top` key is), or another
        // shape. Writing over it would destroy the hall of fame, so rebuild it
        // from the archives (which are small keys and therefore intact).
        if (!raw.ok) {
          if (raw.status !== 'bad-json') { await sleep(400); continue; }  // read failed: leave it alone
          if (await rebuildTopFromArchives(entries, m)) return true;
          await sleep(400);
          continue;
        }
        var cur = [];
        if (!raw.missing && raw.value != null) {
          if (!Array.isArray(raw.value)) {              // wrong shape, same treatment
            if (await rebuildTopFromArchives(entries, m)) return true;
            await sleep(400);
            continue;
          }
          cur = raw.value;
        }
        var merged = merge(cur, entries)
          .filter(function (e) { return modeOf(e) === m; })
          .slice(0, TOP_CAP);
        var w = await kvPut(topKey, merged, 20000);
        if (!w.ok) { await sleep(400); continue; }
        var back = await readList(topKey);
        if (back) {
          var wanted = merged.slice(0, 200);        // verify the head, not all 2000
          if (wanted.every(function (e) { return back.some(function (b) { return idOf(b) === idOf(e); }); })) return true;
        }
        await sleep(300);
      }
      return false;
    }

    /* Reconstruct the hall of fame from the day archives + anything the caller
       is holding. Only ever called when `top` itself is unusable, so there is
       nothing to clobber. */
    async function rebuildTopFromArchives(extra, mode) {
      var m = modeInfo(mode).id;
      var pool = [];
      var listing = await archiveKeys(m);
      if (!listing) return false;
      var keys = listing.days.concat(listing.legacy);
      for (var k = 0; k < keys.length; k++) {
        var rows = await readList(keys[k], 20000);
        if (rows === null) return false;                // a read failed: do not guess
        if (rows.length) pool.push.apply(pool, rows);
      }
      pool.push.apply(pool, extra || []);
      var merged = merge(pool).filter(function (e) { return modeOf(e) === m; }).slice(0, TOP_CAP);
      if (!merged.length) return false;
      var topKey = TOP_KEY + modeSuffix(m);
      var w = await kvPut(topKey, merged, 20000);
      if (!w.ok) return false;
      var back = await readList(topKey);
      return !!(back && merged.slice(0, 50).every(function (e) {
        return back.some(function (b) { return idOf(b) === idOf(e); });
      }));
    }

    /* Insert entries into the archives without requiring a lease: it only
       ever ADDS, and verifies with a read-back, so it is safe to run from a
       migration script, a server or a client. Used to fold history that
       lived only in a legacy key into the day archives. */
    async function ingest(entries) {
      var out = { days: 0, entries: 0, top: false, repaired: 0 };
      var clean = [];
      for (var i = 0; i < (entries || []).length; i++) if (validEntry(entries[i])) clean.push(entries[i]);
      if (!clean.length) return out;
      var byDay = Object.create(null);
      clean.forEach(function (e) { var d = dayKey(e.ts, modeOf(e)); (byDay[d] = byDay[d] || []).push(e); });
      var counter = { added: 0 };
      for (var day in byDay) {
        if (await appendToShard(day, byDay[day], 3, counter)) { out.days++; out.entries += byDay[day].length; }
      }
      out.repaired = counter.added;
      // A day shard is the one key that is read-modify-written (by this function
      // and by older clients). Anything that was written into it in between —
      // typically by the previous build, which re-PUT the whole list from its own
      // stale copy — can erase what we just added. So verify, and append again
      // (appendToShard only ever adds) until the store really holds every play.
      for (var attempt = 0; attempt < 2; attempt++) {
        var missing = [];
        for (var d2 in byDay) {
          var present = Object.create(null);
          var failed = false;
          var keys = await kvList(d2, 10000);
          var list = keys.ok ? (keys.keys.length ? keys.keys : [d2]) : [d2];
          for (var ki = 0; ki < list.length; ki++) {
            var rows = await readList(list[ki], 20000);
            if (rows === null) { failed = true; break; }
            for (var ri = 0; ri < rows.length; ri++) present[idOf(rows[ri])] = true;
          }
          if (failed) { missing.push.apply(missing, byDay[d2]); continue; }
          for (var ei = 0; ei < byDay[d2].length; ei++) {
            if (!present[idOf(byDay[d2][ei])]) missing.push(byDay[d2][ei]);
          }
        }
        if (!missing.length) break;
        var again = Object.create(null);
        missing.forEach(function (e) { var d3 = dayKey(e.ts, modeOf(e)); (again[d3] = again[d3] || []).push(e); });
        for (var d4 in again) await appendToShard(d4, again[d4]);
        await sleep(400);
      }
      // one hall of fame per mode
      var byMode = Object.create(null);
      clean.forEach(function (e) { var mm = modeOf(e); (byMode[mm] = byMode[mm] || []).push(e); });
      out.top = 0;
      for (var mm2 in byMode) if (await updateTop(byMode[mm2], mm2)) out.top++;
      out.top = !!out.top;
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
              entries.forEach(function (e) { var d = dayKey(e.ts, modeOf(e)); (byDay[d] = byDay[d] || []).push(e); });
              var allOk = true;
              for (var day in byDay) {
                var ok = await appendToShard(day, byDay[day]);
                if (!ok) { allOk = false; stats.failed++; log('compact: shard write failed', day); }
              }
              var byMode = Object.create(null);
              entries.forEach(function (e) { var mm = modeOf(e); (byMode[mm] = byMode[mm] || []).push(e); });
              for (var mm in byMode) {
                if (!(await updateTop(byMode[mm], mm))) { allOk = false; stats.failed++; log('compact: top write failed', mm); }
              }
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
              var tops = MODE_ORDER.map(function (m) { return TOP_KEY + modeSuffix(m); });
              var keys = tops.concat(arch.ok && arch.keys.length ? arch.keys : shardKeys(4));
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
      retire: retire, retiredList: function (x) { rebuildRetired(x); },
      MODES: MODES, MODE_ORDER: MODE_ORDER, DEFAULT_MODE: DEFAULT_MODE,
      modeOf: modeOf, modeInfo: modeInfo, topKeyFor: function (m) { return TOP_KEY + modeSuffix(modeInfo(m).id); },
      readList: readList, readRecord: readRecord,
      listKeys: function (prefix) { return kvList(prefix || ''); },
      constants: { TOP_KEY: TOP_KEY, LOCK_KEY: LOCK_KEY, LIVE_PREFIX: LIVE_PREFIX, LEGACY_KEYS: LEGACY_KEYS, TOP_CAP: TOP_CAP, SHARD_DAYS: SHARD_DAYS }
    };
  }

  return {
    create: create, DEFAULT_BUCKET: DEFAULT_BUCKET, TOP_CAP: TOP_CAP, SHARD_DAYS: SHARD_DAYS, LIVE_PREFIX: LIVE_PREFIX,
    MODES: MODES, MODE_ORDER: MODE_ORDER, DEFAULT_MODE: DEFAULT_MODE, modeOf: modeOf
  };
});
