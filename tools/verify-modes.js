/* Verify the game-mode split against the live store.

   Two independent questions:

   1. Did anything move or vanish? The oracle is a raw read of every key in the
      bucket (no help from the reader): every play it contains must be on the
      HARD board, with the same score and tile.
   2. Did the new modes steal anything? No play that existed before modes may
      appear on easy or medium.

   `node tools/verify-modes.js` (read-only: it never writes to the store).
   `node tools/verify-modes.js --backup <file>` also diffs against a backup
   snapshot taken before the change.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const LB = require('../public/leaderboard.js');

const argv = process.argv.slice(2);
const backupPath = argv.includes('--backup') ? argv[argv.indexOf('--backup') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (e) => ({
  name: String(e.name),
  score: Number(e.score),
  maxTile: Number(e.maxTile) || 0,
  ts: Number(e.ts)
});
const idOf = (e) => Number(e.ts) + '|' + String(e.name);

(async () => {
  const bucket = LB.DEFAULT_BUCKET;
  const res = [];
  const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (x ? '  [' + x + ']' : ''));

  /* ---- read the store raw: this is the oracle ---- */
  /* The store rate-limits by IP, so this walks the keys the way the app does:
     a few at a time, with a retry and a longer pause when it pushes back (429).
     A 429 is "ask again later", never "this play does not exist". */
  async function getKey(k, tries) {
    for (let i = 0; i < (tries || 4); i++) {
      const r = await fetch(bucket + '/' + encodeURIComponent(k), { cache: 'no-store' });
      if (r.ok) return { ok: true, text: await r.text() };
      if (r.status === 404) return { ok: true, text: '' };
      await sleep(800 * (i + 1) + Math.random() * 400);   // 429/5xx: back off and retry
    }
    return { ok: false, status: 'unreachable' };
  }

  /* The key list itself is rate-limited harder than single reads. When the
     listing is refused, fall back to: every known archive key reconstructed from
     the committed snapshot's dates, plus the hot keys. Reading is still done one
     key at a time with back-off, and any key that cannot be read is reported. */
  let keys = [];
  for (let attempt = 0; attempt < 3 && !keys.length; attempt++) {
    const listRes = await fetch(bucket + '/?prefix=', { cache: 'no-store' });
    if (listRes.ok) keys = (await listRes.text()).trim().split('\n').filter(Boolean);
    else await sleep(1500 * (attempt + 1));
  }
  if (!keys.length) {
    const days = new Set();
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'archive.json'), 'utf8'));
      snap.forEach((e) => days.add('arc-' + new Date(Number(e.ts)).toISOString().slice(0, 10)));
    } catch (e) { /* no snapshot */ }
    keys = ['top', 'keep', 'lock', 'superseded', 'scores'].concat([...days]);
    console.log('(the store would not list its keys — using the snapshot\'s ' + days.size + ' days + hot keys)');
  }
  const raw = [];
  const unreadable = [];
  const BATCH = 3;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const got = await Promise.all(batch.map((k) => getKey(k)));
    for (let j = 0; j < batch.length; j++) {
      if (!got[j].ok) { unreadable.push(batch[j] + ':' + got[j].status); continue; }
      let v;
      try { v = JSON.parse(got[j].text); } catch (e) {
        if (got[j].text.trim()) unreadable.push(batch[j] + ':unparseable');
        continue;
      }
      (Array.isArray(v) ? v : [v]).forEach((e) => {
        if (e && typeof e.name === 'string' && Number.isFinite(Number(e.ts)) && Number.isFinite(Number(e.score))) raw.push(norm(e));
      });
    }
    await sleep(250);
  }
  console.log('store:', keys.length, 'keys,', raw.length, 'rows', unreadable.length ? '| unreadable: ' + unreadable.join(' ') : '');
  ok('every key was readable', unreadable.length === 0, unreadable.join(' '));

  const oracle = new Map();
  raw.forEach((e) => { if (!oracle.has(idOf(e))) oracle.set(idOf(e), e); });
  console.log('distinct plays in the store:', oracle.size);

  /* ---- what each mode's board says ---- */
  const lb = LB.create({ bucket });
  const boards = {};
  for (const m of LB.MODE_ORDER) {
    const r = await lb.read({ days: 400, history: true, mode: m });
    boards[m] = new Map(r.entries.map((e) => [idOf(e), e]));
    console.log('  ' + m.padEnd(6), '->', String(r.entries.length).padStart(5), 'plays', JSON.stringify(r.sources));
  }

  /* ---- 1. nothing lost, nothing altered ---- */
  const missing = [...oracle.keys()].filter((id) => !boards.hard.has(id));
  const altered = [...oracle.values()].filter((p) => {
    const b = boards.hard.get(idOf(p));
    return b && (b.score !== p.score || (b.maxTile || 0) !== p.maxTile);
  });
  const invented = [...boards.hard.keys()].filter((id) => !oracle.has(id));

  ok('every play in the store is on the hard board', missing.length === 0, missing.length + ' missing');
  ok('no score or tile was altered', altered.length === 0, altered.length + ' altered');
  ok('the hard board contains no invented play', invented.length === 0, invented.length + ' unknown');

  /* ---- 2. the new modes are clean ---- */
  const easyLeak = [...boards.easy.keys()].filter((id) => oracle.has(id));
  const mediumLeak = [...boards.medium.keys()].filter((id) => oracle.has(id));
  ok('easy holds no pre-modes play', easyLeak.length === 0, easyLeak.length + ' leaked');
  ok('medium holds no pre-modes play', mediumLeak.length === 0, mediumLeak.length + ' leaked');

  /* ---- 3. the top of the board ---- */
  const top = [...oracle.values()].sort((a, b) => b.score - a.score)[0];
  const hardTop = [...boards.hard.values()].sort((a, b) => b.score - a.score)[0];
  if (!top) { console.log('\nthe store could not be read from this network (rate limit) — re-run in a minute'); process.exit(2); }
  ok('the best score is on hard', !!hardTop && hardTop.score === top.score,
    (hardTop ? hardTop.name + ' ' + hardTop.score : 'none') + ' (store best ' + top.name + ' ' + top.score + ')');

  /* ---- 4. optional: diff against a pre-change backup ---- */
  if (backupPath) {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const before = new Map();
    for (const rec of Object.values(backup.keys)) {
      let v; try { v = JSON.parse(rec.body); } catch (e) { continue; }
      (Array.isArray(v) ? v : [v]).forEach((e) => {
        if (e && typeof e.name === 'string' && Number.isFinite(Number(e.ts)) && Number.isFinite(Number(e.score))) {
          if (!before.has(idOf(norm(e)))) before.set(idOf(norm(e)), norm(e));
        }
      });
    }
    const lostSinceBackup = [...before.keys()].filter((id) => !boards.hard.has(id) && !oracle.has(id));
    const changedSinceBackup = [...before.values()].filter((p) => {
      const b = boards.hard.get(idOf(p));
      return b && b.score !== p.score;
    });
    ok('nothing that was in the backup is gone', lostSinceBackup.length === 0,
      lostSinceBackup.length ? lostSinceBackup.slice(0, 5).join(', ') : before.size + ' plays checked');
    ok('no score changed since the backup', changedSinceBackup.length === 0, changedSinceBackup.length + ' changed');
  }

  console.log('\n' + res.join('\n'));
  if (missing.length) {
    console.log('\nmissing (first 10):');
    missing.slice(0, 10).forEach((id) => {
      const p = oracle.get(id);
      console.log('   ', p.name + '/' + p.score, '@', new Date(p.ts).toISOString());
    });
  }
  const fails = res.filter((r) => r.startsWith('FAIL')).length;
  console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'TRANSFER VERIFIED — every score is on hard, nothing leaked into easy/medium'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('verify failed:', e && e.message); process.exit(1); });
