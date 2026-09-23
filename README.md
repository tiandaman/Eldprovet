# Handoff: The Team Test — server & networking

## Overview
"The Team Test" is a 4-player mobile mini-game prototype (memory, sequence,
counting, sliding, co-op tasks). The client is fully built as an HTML/JS
design prototype and already speaks a defined WebSocket protocol in **mock
mode** (no server — everything is logged locally). This handoff is to build
the real server: matchmaking, rooms, authoritative life meters, task
assignment, and presence fan-out (the "see everyone's cursor" feature).

## About the design files
`Teamtest - Vital Link flow.dc.html` is a **design reference**, not
production code — it's a single-file HTML/React-like prototype meant to show
exact layout, motion, and game feel. Do not ship this file. Recreate the
client in whatever stack you choose (React Native, Flutter, native iOS/
Android, or a plain web client) and reuse `teamtest-net.js` as the reference
for the wire protocol, not as a dependency.

## Fidelity
High-fidelity for interaction and rules (life-drain curve, task types,
co-op mechanics, protocol). Visual styling (dark terminal aesthetic, IBM Plex
Mono/Sans, colour palette) is final — see Design Tokens below — but is
secondary to correctness of the network/game logic, which is the actual ask.

## What to build
1. **WebSocket server** (Node + `ws`, or your stack of choice) implementing
   the frame contract in `PROTOCOL.md`.
2. **Room/matchmaking layer**: 4-player rooms, random-queue fill, private
   room codes + invite links, friend list join.
3. **Authoritative game state**: life meters (not the client), task
   assignment with shared seeds so all 4 clients render identical task
   geometry without the server shipping full layouts, partner-credit
   rotation, life-drain curve (`0.42 × 1.5^max(0, minutes−0.5)` pts/sec,
   see PROTOCOL.md), and run-end detection (any meter hits 0).
4. **Presence fan-out**: ~20Hz relay of `presence.move` / `presence.tap`
   frames to the other 3 players in a room. Last-write-wins, no history,
   drop late frames rather than queue them.
5. **Persistence** (see PROTOCOL.md → Persistence): accounts, runs,
   leaderboard view.

## Files in this bundle
- `PROTOCOL.md` — the full frame contract (client→server and server→client
  event tables), the life-drain formula, and a minimal starter Node server.
- `teamtest-net.js` — the client transport the prototype already calls.
  Reference for exact frame shape (`{v, seq, t, roomId, playerId, type,
  payload}`); reimplement equivalent logic in your target client stack.
- `game-rules.md` — task types, co-op variants, and scoring/category logic
  pulled directly out of the prototype's game logic, so the server-side
  authoritative versions match.

## Design tokens
- Colours: background `#0A0C0B`, ink `#C6C2B6`, player colours — you
  `#C6C2B6`, P2 `#5FC98A`, P3 `#D9A24B`, P4 `#4FC0D0`, danger `#D6452B`.
- Type: IBM Plex Mono (numerics/UI labels), IBM Plex Sans (body copy).
- These only matter if you're also rebuilding the client UI; the networking
  work itself is stack-agnostic.

## Assets
None — no images. All visuals are inline shapes/CSS in the prototype.
