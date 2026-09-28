# Leaderboard fix — what was wrong, what changed, what to do

## The symptom

Scores either never reached the full board, or the board showed the same play twice.

## The cause

Every version up to v2.9.10 stored the board as **shared JSON lists** and let every
writer read-modify-write them:

- a shared hall-of-fame key (`top`, ~125 KB) rewritten by **every browser tab** on
  every submit, plus by the server, plus by a 10-minute "rebuild" job;
- a day key (`arc-YYYY-MM-DD`) appended to by browsers *and* the server;
- a "hub" fallback chain (same-origin API → hub API → direct writes) where a timeout
  could make two paths write the same play;
- dedupe heuristics on top (a 10-minute "same name + same score" collapse).

On a key-value store with no transactions, concurrent read-modify-write means
**lost updates**: the writer that lands second erases the other's score. And the
10-minute collapse threw away real back-to-back games — a player who ended two games
on the same score inside ten minutes lost one, which is exactly the "my score never
appeared" report.

## What the store actually contained (audited 2026-09-28)

The bucket had 18 keys — including two `arc-<timestamp>` snapshot keys that **no
reader in the app ever looked at** (the code only ever requested hard-coded key
names). All of it was read and merged:

| | |
| --- | --- |
| rows stored across all keys | **8,145** |
| distinct plays after identity dedupe (`ts + name`) | **2,268** |
| plays that only existed in the two never-read snapshot keys | **114** ← recovered |
| genuine double-writes of one play (identical name + score + tile, seconds apart) | **64** ← collapsed |
| final board | **2,204 plays**, 2,204 unique, 0 duplicates |

The 114 recovered plays included whole players (Zylo, cooldude, Hedgehog, waffle,
baptiste, Skowi, Shuvo, Pandora, CG) who were invisible on the board.

## The new approach (v3.0)

No read-modify-write anywhere in the write path — there is no race to lose:

```
q/<ts>-<rand>    one finished game = one immutable record (any client, write-once)
lock             short lease — exactly one compactor at a time
arc-YYYY-MM-DD   day archive — compactor only, insert-only, read-back verified
top              hall-of-fame view — compactor only, a cache, never the truth
scores           v2.x leftover — still read, no longer written
```

- **Submitting** is a single PUT of a brand-new key. Two players finishing at the
  same instant cannot erase each other, and because the key comes from the play
  itself (timestamp + id), a retry rewrites the same record instead of adding a
  second one. The client keeps undeliverable scores locally and retries them later.
- **Compaction** (server, on boot + every 2 min; any client may help) folds records
  into the day archive and hall of fame, then deletes them — but only after a
  read-back proves the entry is in the archive, and only while holding the lease.
  Failures leave the record in place for the next pass.
- **Reading** unions live records + hall of fame + day archives + legacy keys + the
  in-repo snapshot, deduped by play identity. Any one key can go stale or missing
  and the history is still complete.
- **`public/archive.json`** is a permanent snapshot in the repo (the store expires
  keys after ~30 days): 2,204 plays. The board reads it as a floor;
  `tools/archive-workflow.yml` refreshes it hourly when enabled. The compactor also
  re-writes the archive keys in slices so key expiry can't eat a quiet month.

A play is only ever collapsed when it is **identical** — same player, same score,
same best tile, seconds apart. Genuine repeated scores stay, with timestamps.

## Tests

`npm test` → 36 game-logic + 16 protocol + 6 server end-to-end, all green.

The protocol suite runs against a kvdb.io look-alike with injectable faults and
covers exactly the failures that broke v2.x: 12 writers submitting simultaneously,
reads/writes/lists failing mid-compaction, two compactors racing, a stale copy of an
archive, double-writes, and a lost archive key.

## Migration commands

```bash
node tools/migrate.js           # audit: what is in the store vs the archive
node tools/migrate.js --write   # refresh public/archive.json + fold history into the store
node tools/migrate.js --verify  # fail if the archive and the store disagree
```

## Environment quirk found while doing this: kvdb throttles Render's IP

`/api/health?probe=1` on the deployed service reports every store key as
`ERR 429`: the shared store rate-limits by IP, and the Render instance's egress
IP is out of quota (or shared with busy neighbours). That is the real reason the
old "hub" answered with a blank board — and why the client used to distrust it.

The v3 client does not depend on the server at all: each browser talks to the
store from its own IP. The server API is a mirror that now:

- retries 429/5xx with Retry-After aware backoff,
- backs off exponentially (5 → 10 → 20 → 40 → 60 min) while the store refuses
  that host, instead of burning a shared quota,
- keeps serving its last good board (memory + `data/board.json`), unioned with
  `public/archive.json`, so it is never emptier than a file, and
- labels what it is serving (`quality: ok | partial | snapshot | cached`).

## Still to do (needs your GitHub/Render access)

1. **Redeploy the Render service** (`node server.js`) so the server side runs v3.0
   and its compactor replaces the old one. A push to `main` did **not** trigger a
   deploy — the site still serves v2.9.10 — so either click *Manual Deploy → Deploy
   latest commit*, hand over a deploy hook / API key, or stop using that URL: the
   static site below is already fixed.
2. **Enable the hourly archive job** (optional): copy `tools/archive-workflow.yml`
   to `.github/workflows/archive.yml` via the GitHub web UI. Pushing workflow files
   needs the `workflow` token scope, which is why it ships as a normal file.
