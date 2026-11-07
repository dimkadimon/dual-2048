/* ============================================================
   Dual 2048 — server: static files + global leaderboard API
   Zero dependencies. Run: node server.js  (PORT env optional)

   v3.0: the server no longer owns the leaderboard. Scores live in an
   append-only store (see public/leaderboard.js) that any client can
   safely write to, and this process only:

     - serves the game,
     - answers GET/POST /api/scores (compatibility + a fast cached view),
     - runs the compactor: folds write-once records into the day archives
       and the hall-of-fame cache, and re-writes them so the store's
       ~30-day TTL can never eat the history.

   The previous design kept the board in this process, in data/scores.json
   and in a shared key, and let every browser read-modify-write those
   lists. On an ephemeral disk plus dozens of independent writers that is
   a lost-update race, which is why scores went missing and duplicated.
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Leaderboard = require('./public/leaderboard.js');

const PORT = parseInt(process.env.PORT || '8123', 10);
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
const KV_URL = process.env.KV_URL || Leaderboard.DEFAULT_BUCKET;
const READ_TTL = parseInt(process.env.READ_TTL || '30000', 10);   // cached board view
const COMPACT_MS = parseInt(process.env.COMPACT_MS || '120000', 10); // compactor interval

const lb = Leaderboard.create({ bucket: KV_URL, log: (...a) => console.error('[leaderboard]', ...a) });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ---------------- cached board view ----------------

   The shared store rate-limits by IP (kvdb: ~1000 requests/hour). A server's
   egress IP can be exhausted by its neighbours, which is exactly what the old
   "hub" design ran into: every read answered 429 and the hub served an empty
   board. So this process:

     - retries a little, then backs off entirely for a cooldown
     - keeps serving the last board it managed to read (memory + data/board.json)
     - falls back to the snapshot committed in the repo (public/archive.json),
       which is always available and always complete

   Players never depend on any of this: the browser talks to the store itself,
   from its own IP. The API here is a convenience mirror. */

const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '300000', 10);   // base backoff
const COOLDOWN_MAX = parseInt(process.env.COOLDOWN_MAX || '3600000', 10); // ceiling
let cooldownStep = 0;   // grows while the store keeps refusing us, resets on success
const CACHE_FILE = process.env.BOARD_CACHE || path.join(__dirname, 'data', 'board.json');
const SNAPSHOT_FILE = path.join(ROOT, 'archive.json');

/* One cached board view per mode. A mode is the number of walls: easy (none),
   medium (1), hard (2). Hard is the default and keeps the plain ?mode= form
   working (no query = hard), so every existing link and client still works. */
function modeOfRequest(url) {
  const m = String(url.searchParams.get('mode') || '').toLowerCase();
  return Leaderboard.MODES[m] ? m : Leaderboard.DEFAULT_MODE;
}

let cache = { at: 0, entries: [], quality: 'unknown' };     // hard (the historic default)
const caches = { hard: cache };
let cooldownUntil = 0;
let lastGood = 0;

function backOff() {
  cooldownStep = Math.min(cooldownStep + 1, 5);
  const wait = Math.min(COOLDOWN_MS * Math.pow(2, cooldownStep - 1), COOLDOWN_MAX);
  cooldownUntil = Date.now() + wait;
  console.error('[store] refusing this host; backing off for', Math.round(wait / 1000), 's (step ' + cooldownStep + ')');
}

function storeHealthy() { cooldownStep = 0; cooldownUntil = 0; }

function readSnapshot() {
  try {
    const list = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && e.name != null && Number.isFinite(Number(e.ts))) : [];
  } catch (e) { return []; }
}

/* When the store is refusing this host, the snapshot in the repo is what keeps
   the API useful. Pull the newest one from GitHub (a different host, so the
   store's per-IP quota does not apply) rather than the copy baked into the
   container at deploy time — that copy can be hours old. */
const SNAPSHOT_URL = process.env.SNAPSHOT_URL ||
  'https://raw.githubusercontent.com/dimkadimon/dual-2048/main/public/archive.json';
let remoteSnapshot = null;
let remoteSnapshotAt = 0;
const SNAPSHOT_TTL = parseInt(process.env.SNAPSHOT_TTL || '600000', 10);

async function freshSnapshot() {
  if (Date.now() - remoteSnapshotAt < SNAPSHOT_TTL && remoteSnapshot) return remoteSnapshot;
  try {
    const r = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list) && list.length) {
        remoteSnapshot = list.filter((e) => e && e.name != null && Number.isFinite(Number(e.ts)));
        remoteSnapshotAt = Date.now();
      }
    }
  } catch (e) { /* offline or GitHub unreachable — the local file still works */ }
  return remoteSnapshot || readSnapshot();
}

function cacheFileFor(mode) {
  mode = Leaderboard.MODES[mode] ? mode : Leaderboard.DEFAULT_MODE;
  if (mode === Leaderboard.DEFAULT_MODE) return CACHE_FILE;      // the historic file name
  return CACHE_FILE.replace(/\.json$/, '') + ':' + mode + '.json';
}

function loadCacheFile() {
  for (const mode of Leaderboard.MODE_ORDER) {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFileFor(mode), 'utf8'));
      if (j && Array.isArray(j.entries) && j.entries.length) {
        const view = { at: 0, entries: lb.merge(j.entries).filter((e) => lb.modeOf(e) === mode), quality: 'cached' };
        caches[mode] = view;
        if (mode === Leaderboard.DEFAULT_MODE) cache = view;
        lastGood = lastGood || (Number(j.at) || 0);
      }
    } catch (e) { /* first run for this mode */ }
  }
}

function saveCacheFile(mode) {
  mode = Leaderboard.MODES[mode] ? mode : Leaderboard.DEFAULT_MODE;
  const view = caches[mode] || cache;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(cacheFileFor(mode), JSON.stringify({ at: Date.now(), entries: view.entries.slice(0, 5000) }));
  } catch (e) { /* disk full / read-only: the in-memory cache still works */ }
}

async function board(maxAge, mode) {
  mode = Leaderboard.MODES[mode] ? mode : Leaderboard.DEFAULT_MODE;
  if (!caches[mode] || caches[mode] === cache) caches[mode] = mode === Leaderboard.DEFAULT_MODE ? cache : { at: 0, entries: [], quality: 'unknown' };
  const view = caches[mode];
  const same = (list) => lb.merge(list).filter((e) => lb.modeOf(e) === mode);
  if (view.entries.length && Date.now() - view.at < (maxAge == null ? READ_TTL : maxAge)) return view.entries;
  if (Date.now() < cooldownUntil) return view.entries;           // store is busy: serve what we have
  try {
    const r = await lb.read({ days: 35, mode: mode });
    if (r.sources.quality !== 'offline') {
      storeHealthy();
      const fresh = r.entries.length ? r.entries : view.entries;
      caches[mode] = { at: Date.now(), entries: fresh, quality: r.sources.quality };
      if (mode === Leaderboard.DEFAULT_MODE) cache = caches[mode];
      lastGood = Date.now();
      saveCacheFile(mode);
      return caches[mode].entries;
    }
    // The store is refusing to talk to this host. Back off exponentially: a
    // host whose egress IP is out of quota must not keep burning requests
    // (it cannot win, and it makes the quota situation worse for everyone).
    backOff();
  } catch (e) {
    backOff();
  }
  // Degraded: serve the union of everything we already know plus every snapshot
  // we can find (the one baked into the container at deploy time and the newest
  // one on GitHub), so the mirror is never less complete than the archive file.
  // The GitHub copy can lag behind a just-pushed commit (CDN), so union both.
  const snap = same(lb.merge(await freshSnapshot(), readSnapshot()));
  if (snap.length) {
    const merged = lb.collapse(lb.merge(view.entries, snap));
    if (merged.length > view.entries.length) {
      const next = { at: Date.now(), entries: merged, quality: 'snapshot' };
      caches[mode] = next;
      if (mode === Leaderboard.DEFAULT_MODE) cache = next;
    }
  }
  return caches[mode].entries;
}

/* A brand-new deployment (or one whose data/ was wiped) must not push its own
   small board over the shared one: `top` can only ever be *rebuilt* from the
   archives, never seeded from a subset. Returns the repair report. */
async function repairHallOfFame() {
  var out = { repaired: false, valid: 0, reason: '' };
  try {
    var raw = await lb.kvGet(lb.constants.TOP_KEY, 15000);
    if (raw.ok) {
      if (raw.missing) { out.reason = 'missing'; }
      else if (Array.isArray(raw.value)) { out.valid = raw.value.length; out.reason = 'ok'; return out; }
      else { out.reason = 'not-a-list'; }
    } else if (raw.status === 'bad-json') {
      out.reason = 'unparseable (' + (raw.bytes || '?') + ' bytes)';
    } else {
      out.reason = 'read failed: ' + raw.status;
      return out;                                   // never guess on a read failure
    }
    console.log('[repair] hall of fame is ' + out.reason + ' — rebuilding from the archives');
    var stats = await lb.compact({ quietMs: 0, keepalive: false });   // folds any q/ records in first
    if (!stats.skipped) {
      var after = await lb.kvGet(lb.constants.TOP_KEY, 15000);
      if (after.ok && Array.isArray(after.value)) {
        out.repaired = true;
        out.valid = after.value.length;
        console.log('[repair] hall of fame rebuilt: ' + out.valid + ' entries');
      }
    } else {
      out.reason += ' (compactor busy: ' + stats.skipped + ')';
    }
  } catch (e) {
    out.reason = e.message;
  }
  return out;
}

/* ---------------- helpers ---------------- */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const RATE_MS = parseInt(process.env.RATE_MS || '750', 10);
const lastPost = new Map();
function rateOk(ip) {
  const now = Date.now();
  const prev = lastPost.get(ip) || 0;
  if (now - prev < RATE_MS) return false;
  lastPost.set(ip, now);
  if (lastPost.size > 5000) lastPost.clear();
  return true;
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/api/scores' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (p === '/api/scores' && req.method === 'GET') {
    const mode = modeOfRequest(url);
    try {
      const entries = await board(null, mode);
      return sendJSON(res, 200, {
        ok: true, mode, modes: Leaderboard.MODE_ORDER, scores: entries.slice(0, 50),
        total: entries.length, quality: (caches[mode] || {}).quality || 'unknown'
      });
    } catch (e) {
      const view = caches[mode] || cache;
      return sendJSON(res, 200, { ok: true, mode, scores: view.entries.slice(0, 50), total: view.entries.length, quality: 'stale' });
    }
  }

  if (p === '/api/health') {
    const out = {
      ok: true,
      store: KV_URL,
      bucket: lb.bucket,
      cached: cache.entries.length,
      quality: cache.quality,
      modes: Leaderboard.MODE_ORDER.reduce((acc, m) => {
        const v = caches[m] || { entries: [], quality: 'unknown', at: 0 };
        acc[m] = { cached: v.entries.length, quality: v.quality };
        return acc;
      }, {}),
      lastGoodRead: lastGood ? new Date(lastGood).toISOString() : null,
      storeCooldownSec: Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000))
    };
    if (url.searchParams.get('probe')) {
      // what THIS host sees when it talks to the store: status codes + timing,
      // so a deployment that cannot reach the store says so out loud
      const t0 = Date.now();
      const [top, live, shards, one] = await Promise.all([
        lb.kvGet('top', 8000),
        lb.kvList('q/', 8000),
        lb.kvList('arc-', 8000),
        lb.kvGet('arc-' + new Date().toISOString().slice(0, 10), 8000)
      ]);
      out.probe = {
        ms: Date.now() - t0,
        top: top.ok ? (Array.isArray(top.value) ? top.value.length : (top.missing ? 'missing' : 'empty')) : 'ERR ' + top.status,
        live: live.ok ? live.keys.length : 'ERR ' + live.status,
        shards: shards.ok ? shards.keys.length : 'ERR ' + shards.status,
        today: one.ok ? (Array.isArray(one.value) ? one.value.length : (one.missing ? 'missing' : 'empty')) : 'ERR ' + one.status
      };
    }
    return sendJSON(res, 200, out);
  }

  if (p === '/api/scores' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateOk(ip)) return sendJSON(res, 429, { ok: false, error: 'slow down' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad request' }); }

    // the mode comes from the body, or from ?mode=; no mode at all means hard,
    // which is what every pre-modes client sends
    if (payload && typeof payload === 'object' && payload.mode == null) {
      const qm = url.searchParams.get('mode');
      if (qm) payload.mode = qm;
    }
    const entry = lb.clean(payload);
    if (!entry) return sendJSON(res, 400, { ok: false, error: 'invalid score' });
    const entryMode = payload && payload.mode ? (Leaderboard.MODES[payload.mode] ? payload.mode : Leaderboard.DEFAULT_MODE)
                                              : Leaderboard.modeOf(entry);

    const out = await lb.submit(entry);
    if (!out.ok) return sendJSON(res, 503, { ok: false, error: 'store unavailable' });

    // rank against the current view of THAT mode (the record is durable regardless)
    let rank = 1, total = 1, isPB = true;
    try {
      const entries = await board(null, entryMode);
      const merged = lb.merge(entries, [entry]).filter((e) => lb.modeOf(e) === entryMode);
      rank = merged.findIndex((e) => lb.idOf(e) === lb.idOf(entry)) + 1;
      total = merged.length;
      if (!rank) rank = merged.length;
      isPB = !merged.some((e) => lb.idOf(e) !== lb.idOf(entry) &&
        String(e.name).toLowerCase() === entry.name.toLowerCase() && e.score > entry.score);
      const next = { at: Date.now(), entries: merged, quality: 'ok' };
      caches[entryMode] = next;
      if (entryMode === Leaderboard.DEFAULT_MODE) cache = next;
    } catch (e) { /* the score is stored; the view refreshes on the next read */ }

    setTimeout(() => lb.compact({ serial: true }).catch(() => {}), 3000).unref?.();
    return sendJSON(res, 200, { ok: true, mode: entryMode, rank, total, isPB });
  }

  if (p.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  /* ---------------- static ---------------- */

  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[\\/])+/, '');
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!path.extname(full)) {
        return fs.createReadStream(path.join(ROOT, 'index.html'))
          .on('error', () => { res.writeHead(404); res.end('Not found'); })
          .pipe(res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, must-revalidate'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
});

/* ---------------- compactor ---------------- */

(async () => {
  loadCacheFile();
  server.listen(PORT, HOST, () => {
    console.log(`Dual 2048 running at http://${HOST}:${PORT}  (store: ${KV_URL})`);
  });

  const pass = async (why) => {
    if (Date.now() < cooldownUntil) return;
    try {
      const stats = await lb.compact({ serial: true });
      if (stats.skipped === 'list-failed') backOff(); else if (stats.scanned || stats.kept) storeHealthy();
      if (stats.ingested || stats.deleted || stats.kept) {
        console.log(`[compact:${why}]`, JSON.stringify(stats));
      }
      if (stats.ingested || stats.deleted) cache.at = 0;   // view is stale now
    } catch (e) {
      console.error('[compact] failed:', e && e.message);
    }
  };

  await pass('boot');
  setInterval(() => pass('tick'), COMPACT_MS).unref?.();
  // self-heal the hall of fame (the one key every writer touches): if it is
  // unparseable or missing, rebuild it from the archives instead of letting the
  // next write start from an empty list
  await repairHallOfFame();
  setInterval(() => { repairHallOfFame().catch(() => {}); }, 30 * 60 * 1000).unref?.();
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
})();
