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

/* Returns: array = known state (404 → empty), null = READ FAILED.
   Writers must never overwrite a key whose read failed. */
async function kvGet(key) {
  if (!KV_BASE) return null;
  try {
    const r = await fetch(KV_BASE + '/' + key, { cache: 'no-store' });
    if (r.status === 404) return [];
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(KV_BASE + '/' + key, { method: 'PUT', body: JSON.stringify(list) });
      if (r.ok) return;
      console.error('kv put failed:', key, r.status, (await r.text()).slice(0, 120));
    } catch (e) {
      console.error('kv sync failed:', key, e.message);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* Throttled KV refresh: kvdb rate-limits chatty IPs, so we read the shared
   store at most once per KV_TTL ms and serve from memory in between. */
const KV_TTL = parseInt(process.env.KV_TTL || '30000', 10);
let kvCache = { at: 0, top: null, day: null };
async function kvRefresh(force) {
  const now = Date.now();
  if (!force && now - kvCache.at < KV_TTL && kvCache.top !== undefined) return kvCache;
  const today = 'arc-' + new Date().toISOString().slice(0, 10);
  const [top, day] = await Promise.all([kvGet('top'), kvGet(today)]);
  kvCache = { at: now, top, day };
  return kvCache;
}

/* Serialize all KV read-modify-writes through one queue: concurrent
   requests must never interleave their read→write windows or they
   clobber each other's scores. */
let kvLock = Promise.resolve();
function kvSerial(fn) {
  const run = () => fn();
  const p = kvLock.then(run, run);
  kvLock = p.catch(() => {});
  return p;
}

/* Append a score: hall-of-fame key + today's day shard (arc-YYYY-MM-DD).
   Day shards are the full archive; the store's TTL rotates them after ~30 days. */
async function kvSubmit(entry) {
  const day = 'arc-' + new Date(entry.ts).toISOString().slice(0, 10);
  const [top, dayList] = await Promise.all([kvGet('top'), kvGet(day)]);
  if (top === null && dayList === null) return null; // store unreachable — don't guess, don't clobber
  const writes = [];
  let newTop = null;
  if (top !== null) {
    newTop = applyCaps(top.concat([entry]));
    writes.push(kvPut('top', newTop));
  }
  if (dayList !== null) {
    const ek = entry.ts + '|' + entry.name;
    writes.push(kvPut(day, dayList.some((e) => e.ts + '|' + e.name === ek) ? dayList : dayList.concat([entry])));
  }
  await Promise.all(writes);
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
      const extra = local.filter((e) => !seen.has(e.ts + '|' + e.name));
      const merged = applyCaps(kv.concat(extra));
      saveFile(merged);
      if (extra.length) kvPut('top', merged); // only write when boot actually adds entries
      return merged;
    }
    if (kv === null) { /* shared store unreachable — never seed over unknown state */ }
    else if (local.length) { kvPut('top', local); return applyCaps(local); } // seed an empty shared store
  }

  if (local.length) return applyCaps(local);
  const s = seed();
  saveFile(s);
  return s;
}

function applyCaps(list) {
  // idempotent: same ts|name can only ever appear once, no matter how many
  // times an entry gets appended by retries or stale reads
  const seen = new Set();
  const uniq = [];
  for (const e of list) {
    const k = e.ts + '|' + e.name;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }
  uniq.sort((a, b) => b.score - a.score || a.ts - b.ts);
  return uniq.slice(0, MAX_STORED);
}

let scores = [];

/* ---------------- simple rate limit ---------------- */

const RATE_MS = parseInt(process.env.RATE_MS || '1500', 10);
const HUB_SELF = process.env.HUB_SELF === '1';
const HUB_API = 'https://dual-2048.onrender.com/api/scores'; // single serialized writer for the shared board

const lastPost = new Map(); // ip -> ts
function rateOk(ip) {
  const now = Date.now();
  const prev = lastPost.get(ip) || 0;
  if (now - prev < RATE_MS) return false;
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
      await kvSerial(async () => {
        const { top: remote, day: dayList } = await kvRefresh();
        const pool = (remote || []).concat(dayList || []);
        if (remote !== null && pool.length) {
          // READ-ONLY merge for the served view. GET must never write to the
          // store: a "heal" rewrite here caused a storm that bred duplicates.
          const seen = new Set(pool.map((e) => e.ts + '|' + e.name));
          scores = applyCaps(pool.concat(scores.filter((e) => !seen.has(e.ts + '|' + e.name))));
        }
      });
    }
    res.setHeader('Access-Control-Allow-Origin', '*'); // let the board page union across deployments
    return sendJSON(res, 200, { ok: true, scores: scores.slice(0, 50) });
  }

  if (p === '/api/scores' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

    // non-hub deployments forward to the hub so exactly one writer touches the KV store
    const isHub = HUB_SELF || (req.headers.host || '').endsWith('dual-2048.onrender.com');
    if (KV_BASE && !isHub) {
      try {
        const fr = await fetch(HUB_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: payload.name, score: payload.score, maxTile: payload.maxTile })
        });
        if (fr.ok) {
          const j = await fr.json();
          res.setHeader('Access-Control-Allow-Origin', '*');
          return sendJSON(res, 200, j);
        }
      } catch (e) { /* hub asleep — write locally as fallback */ }
    }

    // hall-of-fame + sharded log first so reads see this write (serialized: one writer at a time)
    let hof = null;
    if (KV_BASE) hof = await kvSerial(() => kvSubmit(entry));
    if (KV_BASE && hof === null) {
      // KV store unreachable from this instance — tell the client so IT writes
      // directly instead of believing the score was persisted (prevents silent loss)
      res.setHeader('Access-Control-Allow-Origin', '*');
      return sendJSON(res, 503, { ok: false, error: 'store unavailable' });
    }
    if (hof) kvCache = { at: 0, top: null, day: null }; // invalidate refresh cache
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
    res.setHeader('Access-Control-Allow-Origin', '*'); // clients on any host may submit through this hub
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
