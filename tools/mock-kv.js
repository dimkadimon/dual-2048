/* ============================================================
   In-process kvdb.io look-alike used by the test suite.

   Implements the parts of the real API the leaderboard depends on:
     GET  /<bucket>/<key>            → raw value (404 when absent)
     PUT  /<bucket>/<key>            → store value (creates/overwrites)
     DELETE /<bucket>/<key>          → remove
     GET  /<bucket>/?prefix=<p>      → newline separated key list
   plus the failure modes that actually bit the old design:
     - TTL expiry (kvdb free tier expires keys after ~30 days)
     - injected 429/500/timeouts/read failures on chosen keys
   ============================================================ */
'use strict';
const http = require('http');

function createMockKV(opts) {
  opts = opts || {};
  const ttlMs = opts.ttlMs == null ? 30 * 86400000 : opts.ttlMs;
  const data = new Map();            // key -> {value, at}
  const faults = { put: [], get: [], list: [], del: [] };  // [{match, times, status}]
  const opCount = { get: 0, put: 0, del: 0, list: 0 };

  function faultFor(kind, key) {
    const list = faults[kind];
    for (const f of list) {
      if (f.times <= 0) continue;
      if (f.match && key.indexOf(f.match) === -1) continue;
      f.times--;
      return f.status || 500;
    }
    return 0;
  }
  function expired(k) {
    const rec = data.get(k);
    if (!rec) return true;
    if (ttlMs > 0 && Date.now() - rec.at > ttlMs) { data.delete(k); return true; }
    return false;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/^\//, '').split('/');
    const bucket = decodeURIComponent(parts.shift() || '');
    const key = parts.map(decodeURIComponent).join('/');
    const prefix = url.searchParams.get('prefix');
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const text = Buffer.concat(body).toString('utf8');
      if (req.method === 'GET' && !key) {
        opCount.list++;
        const f = faultFor('list', prefix || '');
        if (f) return res.writeHead(f).end('fault');
        const keys = [...data.keys()].filter((k) => !expired(k)).filter((k) => (prefix == null ? true : k.startsWith(prefix)));
        return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(keys.join('\n'));
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        opCount.get++;
        const f = faultFor('get', key);
        if (f) return res.writeHead(f).end('fault');
        if (expired(key)) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
        const rec = data.get(key);
        rec.at = Date.now();               // a write refreshes TTL; a read does not in kvdb
        return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(rec.value);
      }
      if (req.method === 'PUT') {
        opCount.put++;
        const f = faultFor('put', key);
        if (f) return res.writeHead(f).end('fault');
        if (opts.maxValue && text.length > opts.maxValue) return res.writeHead(413).end('too large');
        data.set(key, { value: text, at: Date.now() });
        return res.writeHead(200).end('');
      }
      if (req.method === 'DELETE') {
        opCount.del++;
        const f = faultFor('del', key);
        if (f) return res.writeHead(f).end('fault');
        data.delete(key);
        return res.writeHead(202).end('');
      }
      res.writeHead(405).end('nope');
    });
  });

  return {
    server,
    data,
    opCount,
    faults,
    fail(kind, match, times, status) { faults[kind].push({ match, times, status }); },
    dump() { return Object.fromEntries([...data.entries()].map(([k, v]) => [k, v.value])); },
    keys() { return [...data.keys()].filter((k) => !expired(k)); },
    expire(key) { data.delete(key); },
    start() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
    },
    stop() { return new Promise((resolve) => server.close(resolve)); }
  };
}

module.exports = { createMockKV };
