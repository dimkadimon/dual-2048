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

- Name entry, local **top-10 table** (localStorage) + **global leaderboard** (server API,
  starts empty — first player claims #1; up to 10 entries per name so a solo
  player's GLOBAL board mirrors their local YOUR BEST table)
- Pause and game-over states with instant restart; score/best-tile/moves stats; global rank after submit
- Juice: eased slide animations, merge pop, particle bursts (additive blending), floating `+N`
  and COMBO text, screen shake scaled to merge size, edge-nudge on blocked moves,
  WebAudio synth SFX (no audio files), rainbow glow on apex tiles
- 60 fps canvas renderer: single `requestAnimationFrame` loop, dt-based updates, DPR-aware
  backing store (capped at 2×), particle cap — everything renders on one canvas

## Run it

```bash
node server.js          # http://localhost:8123  (PORT env to change)
```

Zero dependencies — Node 18+ only. Global scores persist in `data/scores.json`
(created empty on first run).

### Static mode (no server needed)

The client is dual-mode: it uses the same-origin Node API when available, and
automatically falls back to a free no-auth KV store (kvdb.io) for the shared
global leaderboard when it isn't. So you can also deploy `public/` to **any
static host** and everything, including the global leaderboard, still works:

```bash
npx surge ./public yourdomain.surge.sh     # or Netlify / GitHub Pages / S3 …
```

Live example: https://dual2048-game.surge.sh

## Live deployments

- **Server (Node) — Render:** https://dual-2048.onrender.com
- **Static — Surge:** https://dual2048-game.surge.sh
- **Source:** https://github.com/dimkadimon/dual-2048

All three share one global leaderboard. Set `KV_URL` to a kvdb.io bucket
(e.g. `https://kvdb.io/<bucket>/scores`) so every deployment reads/writes the
same store. On boot and on each `GET /api/scores` the server merges the local
file with the shared store and self-heals it — so entries lost to a stale
writer (e.g. the browser-side static client doing a read-modify-write) are
recovered automatically. Render's free tier has an ephemeral disk, so `KV_URL`
is what makes scores persist there.

## API (server mode)

- `GET /api/scores` — top 20 `{ name, score, maxTile, ts }`
- `POST /api/scores` — `{ name, score, maxTile }` → `{ ok, rank, total, isPB }`
  (validated, rate-limited 1 post/1.5 s per IP, max 10 entries per name, top 100 kept)

## Project layout

```
server.js          static server + leaderboard API (no deps)
public/index.html  HUD, overlays (start / pause / review / results), D-pad
public/style.css   neon-arcade theme
public/game.js     pure game logic (headless-testable) + canvas renderer/shell
test.js            36 logic tests: node test.js
data/scores.json   global leaderboard persistence
```

## Deploying

Copy the folder to any Node host (Fly, Render, Railway, a VPS…) and run `node server.js`.
Make `data/` writable so scores persist between restarts.

### Render (free tier)

The repo is already wired for Render. Create a Web Service from
`github.com/dimkadimon/dual-2048` (or use the API) with:

| Field | Value |
| --- | --- |
| Runtime | Node |
| Region | singapore (Render has no Sydney region) |
| Plan | free |
| Build command | `npm install` |
| Start command | `node server.js` |
| Health check path | `/api/scores` |
| Env var | `KV_URL=https://kvdb.io/<bucket>/scores` |

Because the free tier's disk is ephemeral, `KV_URL` is what keeps the
leaderboard alive across restarts — the local `data/scores.json` is only a
per-instance cache. Redeploy any time with:

```bash
curl -X POST https://api.render.com/v1/services/<SERVICE_ID>/deploys \
  -H "Authorization: Bearer <RENDER_API_KEY>" -H "Content-Type: application/json" -d '{}'
```
