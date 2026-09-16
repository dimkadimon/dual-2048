/* ============================================================
   Dual 2048 — server: static files + global leaderboard API
   Zero dependencies. Run: node server.js  (PORT env optional)

   Leaderboard storage is layered:
     - data/scores.json  (local persistence)
     - KV_URL            (optional shared store, e.g. a kvdb.io bucket)
       When KV_URL is set, the KV store is the source of truth so
       multiple deployments (Render, static hosts, sandbox) share
       one unified global leaderboard even on ephemeral disks.
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8123', 10);
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'scores.json');
const KV_URL = process.env.KV_URL || '';
const MAX_STORED = 2000; // full archive of scores (no per-player cap)

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

/* ---------------- shared KV store (optional) ---------------- */

async function kvGet() {
  if (!KV_URL) return null;
  try {
    const r = await fetch(KV_URL, { cache: 'no-store' });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    if (!t) return [];
    const a = JSON.parse(t);
    return Array.isArray(a) ? a : null;
  } catch (e) {
    return null;
  }
}

async function kvPut(list) {
  if (!KV_URL) return;
  try {
    await fetch(KV_URL, { method: 'PUT', body: JSON.stringify(list) });
  } catch (e) {
    console.error('kv sync failed:', e.message);
  }
}

/* ---------------- leaderboard storage ---------------- */

/* The board starts empty — players populate it. */
function seed() {
  return [];
}

function saveFile(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('Failed to save scores file:', e.message);
  }
}

async function loadScores() {
  let local = [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) local = list;
  } catch (e) { /* no local file yet */ }

  if (KV_URL) {
    const kv = await kvGet();
    if (kv && kv.length) {
      // merge local + shared so neither side's entries are lost, then push the
      // superset back so every deployment converges on the same board
      const seen = new Set(kv.map((e) => e.ts + '|' + e.name));
      const merged = applyCaps(kv.concat(local.filter((e) => !seen.has(e.ts + '|' + e.name))));
      saveFile(merged);
      kvPut(merged);
      return merged;
    }
    if (local.length) { kvPut(local); return applyCaps(local); } // seed an empty shared store
  }

  if (local.length) return applyCaps(local);
  const s = seed();
  saveFile(s);
  return s;
}

function applyCaps(list) {
  list.sort((a, b) => b.score - a.score || a.ts - b.ts);
  return list.slice(0, MAX_STORED);
}

let scores = [];

/* ---------------- simple rate limit ---------------- */

const lastPost = new Map(); // ip -> ts
function rateOk(ip) {
  const now = Date.now();
  const prev = lastPost.get(ip) || 0;
  if (now - prev < 1500) return false;
  lastPost.set(ip, now);
  if (lastPost.size > 5000) lastPost.clear();
  return true;
}

/* ---------------- helpers ---------------- */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024) {
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

function sanitizeName(n) {
  return String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'ANON';
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // --- API ---
  if (p === '/api/scores' && req.method === 'GET') {
    if (KV_URL) {
      const remote = await kvGet(); // shared store wins when configured
      if (remote && remote.length) {
        const seen = new Set(remote.map((e) => e.ts + '|' + e.name));
        const merged = applyCaps(remote.concat(scores.filter((e) => !seen.has(e.ts + '|' + e.name))));
        // self-heal: if the shared store lost entries to a stale writer, push the union back
        if (JSON.stringify(merged) !== JSON.stringify(applyCaps(remote))) kvPut(merged);
        scores = merged;
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*'); // let the board page union across deployments
    return sendJSON(res, 200, { ok: true, scores: scores.slice(0, 50) });
  }

  if (p === '/api/scores' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  if (p === '/api/scores' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateOk(ip)) return sendJSON(res, 429, { ok: false, error: 'slow down' });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'bad request' });
    }
    const score = Math.floor(Number(payload.score));
    const maxTile = Math.floor(Number(payload.maxTile)) || 0;
    if (!Number.isFinite(score) || score < 0 || score > 1e9) {
      return sendJSON(res, 400, { ok: false, error: 'invalid score' });
    }
    const entry = { name: sanitizeName(payload.name), score, maxTile, ts: Date.now() };

    // merge with the shared store first so parallel deployments don't clobber each other
    let base = scores;
    if (KV_URL) {
      const remote = await kvGet();
      if (remote) {
        const seen = new Set(scores.map((e) => e.ts + '|' + e.name));
        base = scores.concat(remote.filter((e) => !seen.has(e.ts + '|' + e.name)));
      }
    }
    base.push(entry);
    scores = applyCaps(base);
    saveFile(scores);
    await kvPut(scores); // sync before responding so reads see this write

    const rank = scores.findIndex((e) => e === entry) + 1 ||
                 scores.filter((e) => e.score > entry.score).length + 1;
    const isPB = !scores.some((e) => e !== entry && String(e.name).toLowerCase() === entry.name.toLowerCase() && e.score > entry.score);
    return sendJSON(res, 200, { ok: true, rank: rank || scores.length, total: scores.length, isPB });
  }

  if (p.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }

  // --- static ---
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-ish fallback to index for unknown paths without extension
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

(async () => {
  scores = applyCaps(await loadScores());
  server.listen(PORT, HOST, () => {
    console.log(`Dual 2048 running at http://${HOST}:${PORT}` + (KV_URL ? ' (KV sync on)' : ''));
  });
})();
