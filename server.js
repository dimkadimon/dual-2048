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
const KV_BASE = KV_URL.replace(/\/scores\/?$/, ''); // bucket base (keys: top, scores, arc-*, meta)
const MAX_STORED = 2000; // hall-of-fame ("top") size
const SEAL_AT = 2000;    // active log ("scores") seals into a write-once arc-* shard here

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

async function kvGet(key) {
  if (!KV_BASE) return null;
  try {
    const r = await fetch(KV_BASE + '/' + key, { cache: 'no-store' });
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    if (!t) return [];
    const a = JSON.parse(t);
    return Array.isArray(a) ? a : null;
  } catch (e) {
    return null;
  }
}

async function kvGetRaw(key) {
  if (!KV_BASE) return null;
  try {
    const r = await fetch(KV_BASE + '/' + key, { cache: 'no-store' });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch (e) {
    return null;
  }
}

async function kvPut(key, list) {
  if (!KV_BASE) return;
  try {
    await fetch(KV_BASE + '/' + key, { method: 'PUT', body: JSON.stringify(list) });
  } catch (e) {
    console.error('kv sync failed:', e.message);
  }
}

/* Append a score: hall-of-fame key + active log; seal the log into a
   write-once arc-* shard when full (shards age out with the store's TTL). */
async function kvSubmit(entry) {
  const [top, log] = await Promise.all([kvGet('top'), kvGet('scores')]);
  const newTop = applyCaps((top || []).concat([entry]));
  const newLog = (log || []).concat([entry]);
  if (newLog.length >= SEAL_AT) {
    const id = 'arc-' + Date.now();
    await kvPut(id, newLog);
    await kvPut('scores', []);
    const meta = (await kvGetRaw('meta')) || {};
    const arcs = Array.isArray(meta.arcs) ? meta.arcs : [];
    if (!arcs.includes(id)) arcs.push(id);
    await kvPut('meta', { arcs });
  } else {
    await kvPut('scores', newLog);
  }
  await kvPut('top', newTop);
  return newTop;
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

  if (KV_BASE) {
    const kv = await kvGet('top');
    if (kv && kv.length) {
      // merge local + shared so neither side's entries are lost, then push the
      // superset back so every deployment converges on the same board
      const seen = new Set(kv.map((e) => e.ts + '|' + e.name));
      const merged = applyCaps(kv.concat(local.filter((e) => !seen.has(e.ts + '|' + e.name))));
      saveFile(merged);
      kvPut('top', merged);
      return merged;
    }
    if (local.length) { kvPut('top', local); return applyCaps(local); } // seed an empty shared store
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
    if (KV_BASE) {
      const [remote, log] = await Promise.all([kvGet('top'), kvGet('scores')]);
      const pool = (remote || []).concat(log || []);
      if (pool.length) {
        const seen = new Set(pool.map((e) => e.ts + '|' + e.name));
        const merged = applyCaps(pool.concat(scores.filter((e) => !seen.has(e.ts + '|' + e.name))));
        // self-heal: if the hall-of-fame lost entries to a stale writer, push the union back
        if (JSON.stringify(merged) !== JSON.stringify(applyCaps(remote || []))) kvPut('top', merged);
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

    // hall-of-fame + sharded log first so reads see this write
    let hof = null;
    if (KV_BASE) hof = await kvSubmit(entry);
    if (hof) {
      const seen = new Set(hof.map((e) => e.ts + '|' + e.name));
      scores = applyCaps(hof.concat(scores.filter((e) => !seen.has(e.ts + '|' + e.name))));
    } else {
      scores = applyCaps(scores.concat([entry]));
    }
    saveFile(scores);

    const ref = hof || scores;
    const rank = ref.findIndex((e) => e === entry) + 1 ||
                 ref.filter((e) => e.score > entry.score).length + 1;
    const isPB = !ref.some((e) => e !== entry && String(e.name).toLowerCase() === entry.name.toLowerCase() && e.score > entry.score);
    return sendJSON(res, 200, { ok: true, rank: rank || ref.length, total: ref.length, isPB });
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
