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

const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '300000', 10);
const CACHE_FILE = process.env.BOARD_CACHE || path.join(__dirname, 'data', 'board.json');
const SNAPSHOT_FILE = path.join(ROOT, 'archive.json');

let cache = { at: 0, entries: [], quality: 'unknown' };
let cooldownUntil = 0;
let lastGood = 0;

function readSnapshot() {
  try {
    const list = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && e.name != null && Number.isFinite(Number(e.ts))) : [];
  } catch (e) { return []; }
}

function loadCacheFile() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.entries) && j.entries.length) {
      cache = { at: 0, entries: j.entries, quality: 'cached' };
      lastGood = Number(j.at) || 0;
    }
  } catch (e) { /* first run */ }
}

function saveCacheFile() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), entries: cache.entries.slice(0, 5000) }));
  } catch (e) { /* disk full / read-only: the in-memory cache still works */ }
}

async function board(maxAge) {
  if (cache.entries.length && Date.now() - cache.at < (maxAge == null ? READ_TTL : maxAge)) return cache.entries;
  if (Date.now() < cooldownUntil) return cache.entries;          // store is busy: serve what we have
  try {
    const r = await lb.read({ days: 35 });
    if (r.sources.quality !== 'offline') {
      const fresh = r.entries.length ? r.entries : cache.entries;
      cache = { at: Date.now(), entries: fresh, quality: r.sources.quality };
      lastGood = Date.now();
      saveCacheFile();
      return cache.entries;
    }
    // the store is refusing to talk to this host — back off instead of hammering
    cooldownUntil = Date.now() + COOLDOWN_MS;
    console.error('[store] unreachable from this host; pausing store access for', Math.round(COOLDOWN_MS / 1000), 's');
  } catch (e) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  // Degraded: serve the union of everything we already know plus the snapshot
  // committed in the repo, so the mirror is never less complete than the file.
  const snap = readSnapshot();
  if (snap.length) {
    const merged = lb.collapse(lb.merge(cache.entries, snap));
    if (merged.length > cache.entries.length) {
      cache = { at: Date.now(), entries: merged, quality: 'snapshot' };
    }
  }
  return cache.entries;
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
    try {
      const entries = await board();
      return sendJSON(res, 200, { ok: true, scores: entries.slice(0, 50), total: entries.length, quality: cache.quality });
    } catch (e) {
      return sendJSON(res, 200, { ok: true, scores: cache.entries.slice(0, 50), total: cache.entries.length, quality: 'stale' });
    }
  }

  if (p === '/api/health') {
    const out = {
      ok: true,
      store: KV_URL,
      bucket: lb.bucket,
      cached: cache.entries.length,
      quality: cache.quality,
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

    const entry = lb.clean(payload);
    if (!entry) return sendJSON(res, 400, { ok: false, error: 'invalid score' });

    const out = await lb.submit(entry);
    if (!out.ok) return sendJSON(res, 503, { ok: false, error: 'store unavailable' });

    // rank against the current view (the record itself is durable regardless)
    let rank = 1, total = 1, isPB = true;
    try {
      const entries = await board();
      const merged = lb.merge(entries, [entry]);
      rank = merged.findIndex((e) => lb.idOf(e) === lb.idOf(entry)) + 1;
      total = merged.length;
      if (!rank) rank = merged.length;
      isPB = !merged.some((e) => lb.idOf(e) !== lb.idOf(entry) &&
        String(e.name).toLowerCase() === entry.name.toLowerCase() && e.score > entry.score);
      cache = { at: Date.now(), entries: merged, quality: 'ok' };
    } catch (e) { /* the score is stored; the view refreshes on the next read */ }

    setTimeout(() => lb.compact({ serial: true }).catch(() => {}), 3000).unref?.();
    return sendJSON(res, 200, { ok: true, rank, total, isPB });
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
      if (stats.skipped === 'list-failed') cooldownUntil = Date.now() + COOLDOWN_MS;
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
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
})();
