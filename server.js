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

/* ---------------- cached board view ---------------- */

let cache = { at: 0, entries: [], quality: 'unknown' };

async function board(maxAge) {
  if (cache.entries.length && Date.now() - cache.at < (maxAge == null ? READ_TTL : maxAge)) return cache.entries;
  const r = await lb.read({ days: 35 });
  cache = { at: Date.now(), entries: r.entries, quality: r.sources.quality };
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
    return sendJSON(res, 200, { ok: true, store: KV_URL, cached: cache.entries.length, quality: cache.quality });
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
  server.listen(PORT, HOST, () => {
    console.log(`Dual 2048 running at http://${HOST}:${PORT}  (store: ${KV_URL})`);
  });

  const pass = async (why) => {
    try {
      const stats = await lb.compact({ serial: true });
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
