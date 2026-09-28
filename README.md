# Dual 2048

A juicy 2048 remix with **two tile lineages** and **walls**, built as a dependency-free
browser game with a Node server for the **global leaderboard**.

## The twist

| | Warm squares | Cool hexes |
|---|---|---|
| Lineage | starts at **2** | starts at **3** |
| Sequence | 2 → 4 → 8 → 16 → … → 2048 | 3 → 6 → 12 → 24 → … → 3072 |
| Merge rule | two equal squares combine (×2) | two equal hexes combine (×2) |

- Every merge **doubles** the tile (9 + 9 → 18), but the two lineages **never mix** —
  a 2 and a 3 just block each other.
- **2 walls** spawn each game in distinct rows and columns. They never move; slides and
  merges stop against them.
- Chain **2+ merges in one move** for a COMBO bonus (×0.5 extra per additional merge).
- Win toasts at 2048 (squares) or 3072 (hexes) — then keep playing for score.

## Game flow

Start screen (name entry + rules + leaderboards) → play → on game over the **final board
stays on screen** with a review bar: **📸 SHARE SCREENSHOT** (copies a composed PNG of the final board +
score header to the clipboard on desktop, native share sheet with the PNG on mobile,
automatic fallbacks to PNG download then text) and **CONTINUE →** which takes you to the results screen with
stats, global rank, and the YOUR BEST / GLOBAL leaderboards. `R` restarts instantly from
anywhere.

## Controls

- **Desktop:** Arrow keys / WASD · `P`/`Esc` pause · `R` instant restart · `M` mute · `Enter` start/rematch
- **Mobile:** swipe anywhere on the board, or the on-screen D-pad (shown automatically on touch devices)
- Tab-blur / hidden tab auto-pauses.

## Features

- Name entry, local **top-10 table** (localStorage) + **global leaderboard** that every
  deployment shares
- Pause and game-over states with instant restart; score/best-tile/moves stats; global rank after submit
- If a score cannot be sent at the moment (offline, store throttled, tab closed), it is kept
  locally and pushed automatically the next time the game runs — a finished game is never lost
- Juice: eased slide animations, merge pop, particle bursts (additive blending), floating `+N`
  and COMBO text, screen shake scaled to merge size, edge-nudge on blocked moves,
  WebAudio synth SFX (no audio files), rainbow glow on apex tiles
- 60 fps canvas renderer: single `requestAnimationFrame` loop, dt-based updates, DPR-aware
  backing store (capped at 2×), particle cap — everything renders on one canvas

## Run it

```bash
node server.js          # http://localhost:8123  (PORT env to change)
```

Zero dependencies — Node 18+ only.

### Static mode (no server needed)

The client talks to the shared store directly, so you can also deploy `public/` to
**any static host** (GitHub Pages, Netlify, S3, surge.sh…) and the global leaderboard
keeps working:

```bash
npx surge ./public yourdomain.surge.sh     # or Netlify / GitHub Pages / S3 …
```

## How the global leaderboard works (v3)

Every older version had the same flaw: several independent writers (each open browser tab,
each server instance) read a shared JSON list, appended to it in memory and wrote the whole
list back. On a key-value store without transactions that is a lost-update race — whichever
writer landed second erased the other's score — and a retry after a timeout recorded the
same play twice. Attempts to patch it (dedupe heuristics, rebuilds, seeds, throttles,
"hub" writers) each traded one failure for another, and the 10-minute "near duplicate"
collapse deleted real back-to-back games. That is the version this repo no longer uses.

**The current design is append-only, so there is no race to lose in the first place.**

| Key | Written by | Purpose |
| --- | --- | --- |
| `q/<ts>-<rand>` | any client — **once, never rewritten** | one finished game, one immutable record |
| `lock` | whoever compacts | short lease, keeps compaction single-writer |
| `arc-YYYY-MM-DD` | compactor only | the day archive (insert-only, read-back verified) |
| `top` | compactor only | hall-of-fame view (best 2000) — a cache, never the source of truth |
| `scores` | (legacy) | v2.x leftover, still read, no longer written |

- **Writing a score** is a single PUT of a brand-new key. No read-modify-write means two
  players finishing at the same instant cannot erase each other, and because the key is
  derived from the play (its timestamp plus an id), a retry writes the *same* record —
  it can never duplicate one.
- **Compaction** (the server does it on boot and every 2 minutes; a client may do it too)
  folds the `q/` records into the day archive and the hall of fame, then deletes them —
  but only after a read-back proves the entry is really in the archive, and only while it
  holds the lease. Every write is verified and retried; a failure leaves the record in
  place for the next pass, so nothing can be lost.
- **Reading a board** unions the write-once records, the archives, the hall of fame and the
  legacy keys and de-duplicates by *play identity* (`ts + name`). Any one key can be stale,
  clobbered or missing and the history is still complete.
- **`public/archive.json`** is a permanent snapshot of every score committed to this repo
  (the store itself expires keys after ~30 days). The board reads it as a floor, and the
  `tools/archive-workflow.yml` workflow refreshes it hourly — copy it to
  `.github/workflows/archive.yml` once (the GitHub web UI is enough) to switch it on.
  `node tools/migrate.js` inspects/updates it, `--write` also folds history into the store.

A play is only ever collapsed when it is *identical* — same player, same score, same best
tile, seconds apart (the signature of the old double-write bug). Genuine repeated scores are
kept, with their timestamps; the full board shows every one of them.

### Store layout

The default store is a public kvdb.io bucket (`KV_URL` overrides it). It needs nothing more
than GET/PUT/DELETE and prefix listing; the client uses it directly, so static hosting works
with no server at all.

## API (server mode)

- `GET /api/scores` — top 50 `{ name, score, maxTile, ts }` (+ `total`, `quality`)
- `POST /api/scores` — `{ name, score, maxTile, ts? }` → `{ ok, rank, total, isPB }`
  (validated, rate-limited; the score is written straight into the append-only store)
- `GET /api/health` — store + cache status

## Project layout

```
server.js              static server + leaderboard API + compactor (no deps)
public/leaderboard.js  the leaderboard core, shared by browser and server
public/index.html      HUD, overlays (start / pause / review / results), D-pad
public/style.css       neon-arcade theme
public/game.js         pure game logic (headless-testable) + canvas renderer/shell
public/board.html      full global leaderboard (every stored score)
public/archive.json    permanent snapshot of every score (refreshed hourly)
tools/migrate.js       audit / export / verify the store against the archive
tools/archive-workflow.yml  hourly archive job (copy to .github/workflows/ to enable)
tools/mock-kv.js       kvdb look-alike used by the protocol tests
test.js                36 game-logic tests
test-leaderboard.js    16 protocol tests (concurrency, faults, compaction, duplicates)
```

```bash
npm test                 # game logic (36) + leaderboard protocol (16)
node tools/migrate.js    # what is in the store vs the archive (read-only)
node tools/migrate.js --write   # refresh public/archive.json + fold history into the store
node tools/migrate.js --verify  # fail if the archive and the store disagree
```

### Keeping the history forever

- The **store** keeps the last ~30 days alive by itself: the compactor re-writes the
  archive keys in slices (cursor kept in the store), so key expiry never eats a quiet
  month.
- **`public/archive.json`** is the belt-and-braces copy: a plain file in this repo with
  every score ever seen, served with the game (and mirrored on raw.githubusercontent.com),
  and used by the board as a floor. Refresh it by hand with `node tools/migrate.js --write`
  or switch on the hourly workflow described above.

## Live deployments

- **Static (GitHub Pages):** https://dimkadimon.github.io/dual-2048/ — `public/` served
  from the `gh-pages` branch; it needs no server because the client talks to the store
  directly. Re-publish after changing `public/` with `tools/deploy-pages.sh`.
- **Server (Node) — Render:** https://dual-2048.onrender.com — serves the same game
  static files, adds the API and runs the compactor.
- **Source:** https://github.com/dimkadimon/dual-2048

### Deploying

Copy the folder to any Node host (Fly, Render, Railway, a VPS…) and run `node server.js`.
Set `KV_URL` to a different bucket to keep a separate leaderboard; everything else works
out of the box. On Render, pushing to `main` redeploys the service.

Because the client writes to the store itself, the server is optional for players — it is
what runs the compactor, which is what keeps the archives current and re-writes them so the
store's key expiry never eats the history. Any deployment (or the hourly GitHub Action)
can do that job; whoever gets the lease does.
