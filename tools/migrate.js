/* ============================================================
   Migration / export / verification for the v3 leaderboard.

     node tools/migrate.js            report        (read-only)
     node tools/migrate.js --write    write public/archive.json + fold history
                                      into the day archives
     node tools/migrate.js --verify   compare the repo archive against the store

   It reads EVERY key in the bucket (the store can be listed, so nothing is
   missed — the v2.x readers only ever looked at hard-coded key names, which is
   how two `arc-<timestamp>` snapshots went unnoticed for a week), unions all
   of it by play identity (ts|name), and reports anything that only exists in
   one place. It never deletes anything.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const Leaderboard = require('../public/leaderboard.js');

const BUCKET = process.env.KV_URL || Leaderboard.DEFAULT_BUCKET;
const ARCHIVE_FILE = path.join(__dirname, '..', 'public', 'archive.json');
const lb = Leaderboard.create({ bucket: BUCKET, log: (...a) => console.error('[migrate]', ...a) });

function isEntry(e) {
  return e && typeof e === 'object' && !Array.isArray(e) &&
    typeof e.name === 'string' && Number.isFinite(Number(e.score)) && Number.isFinite(Number(e.ts));
}

(async () => {
  const write = process.argv.includes('--write');
  const verify = process.argv.includes('--verify');

  const listing = await lb.listKeys('');
  if (!listing.ok) {
    console.error('cannot list the store:', listing.status);
    process.exit(1);
  }
  console.log('bucket keys (' + listing.keys.length + '):');
  for (const k of listing.keys) console.log('   ', k);

  const sources = {};
  const all = [];
  for (const key of listing.keys) {
    const r = await lb.kvGet(key, 20000);
    if (!r.ok) { console.log('  ! read failed (skipped):', key, r.status); continue; }
    const v = r.value;
    if (Array.isArray(v)) {
      const rows = v.filter(isEntry);
      sources[key] = rows.length;
      all.push(...rows);
    } else if (isEntry(v)) {
      sources[key] = 1;
      all.push(v);
    } else {
      sources[key] = 0;   // meta/lock/etc.
    }
  }

  const union = lb.merge(all);              // identity dedupe (raw store view)
  const board = lb.collapse(union);         // + collapse legacy double-writes for the board
  const dupes = all.length - union.length;
  console.log('\nsources:');
  for (const [k, n] of Object.entries(sources).sort()) console.log('   ', String(n).padStart(5), k);
  console.log('\nrows read from the store :', all.length);
  console.log('distinct plays (ts|name) :', union.length, dupes ? '(collapsed ' + dupes + ' duplicate copies)' : '');
  console.log('board rows (no doubles)  :', board.length, union.length - board.length ? '(collapsed ' + (union.length - board.length) + ' double-writes)' : '');
  if (union.length) {
    const tsAll = union.map((e) => e.ts);
    console.log('best / newest            :', board[0].name, board[0].score, '/',
      new Date(Math.max(...tsAll)).toISOString());
    console.log('span                     :',
      new Date(Math.min(...tsAll)).toISOString().slice(0, 10), '→',
      new Date(Math.max(...tsAll)).toISOString().slice(0, 10));
    const names = {};
    union.forEach((e) => { names[e.name] = (names[e.name] || 0) + 1; });
    console.log('players                  :', Object.entries(names).sort((a, b) => b[1] - a[1]).map(([n, c]) => n + '×' + c).join(', '));
  }

  let committed = [];
  try { committed = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')); } catch (e) { committed = []; }
  if (committed.length) {
    const storeBoard = lb.collapse(lb.merge(committed, board));
    const seen = new Set(storeBoard.map(lb.idOf));
    const onlyInRepo = committed.filter((e) => isEntry(e) && !seen.has(lb.idOf(e)));
    const seenRepo = new Set(committed.map(lb.idOf));
    const onlyInStore = board.filter((e) => !seenRepo.has(lb.idOf(e)));
    console.log('\nrepo archive             :', committed.length, 'plays');
    console.log('  in repo but not store  :', onlyInRepo.length, onlyInRepo.slice(0, 5).map((e) => e.name + '/' + e.score).join(' '));
    console.log('  in store but not repo  :', onlyInStore.length, onlyInStore.slice(0, 5).map((e) => e.name + '/' + e.score).join(' '));
    if (verify && (onlyInRepo.length || onlyInStore.length)) process.exitCode = 1;
    if (verify) console.log(verify && !onlyInRepo.length && !onlyInStore.length ? '  ✓ archive and store agree' : '  ✗ archive and store differ');
  }

  if (write) {
    // 1) the permanent snapshot that travels with the repo
    const snapshot = lb.collapse(lb.merge(committed, union));
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(snapshot) + '\n');
    console.log('\nwrote', ARCHIVE_FILE, '(' + snapshot.length + ' plays,', fs.statSync(ARCHIVE_FILE).size, 'bytes)');

    // 2) make sure every play also sits in the day archives + hall of fame,
    //    so history that only lived in a legacy key cannot be lost
    const res = await lb.ingest(union);
    console.log('folded into day archives :', res.entries, 'plays across', res.days, 'days; hall of fame updated:', res.top);

    // 3) a compactor pass to clear any write-once records sitting around
    const stats = await lb.compact({ quietMs: 0, keepalive: 'force' });
    console.log('compaction               :', JSON.stringify(stats));
  }
})().catch((e) => { console.error('migrate failed:', e && e.message); process.exit(1); });
