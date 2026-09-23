# The Team Test — server

Authoritative WebSocket server for the frame contract in [`../PROTOCOL.md`](../PROTOCOL.md).
Node ≥ 18, one dependency (`ws`).

```bash
npm install
npm start          # ws://localhost:8787
npm test
```

Open **http://localhost:8787/** for the mobile client — the "Vital Link" design (direction 1c) wired to
this server: title → rules → matchmaking / private room → solo tasks → co-op → run ended → leaderboard.
Each teammate is a screen edge (their life meter), their finger is the bead sliding along it
(`presence.move`), and their taps throw ripples (`presence.tap`). Full-bleed on phones, a phone-sized
frame on desktop. `?p=<id>` picks a player ID (per tab), `?room=TT-XXXX` joins a room (the invite link),
`?debug=1` logs every frame. Open more tabs with different `?p=` names to fill a room, or start short —
stand-ins fill the rest.
It loads `client/teamtest-net.js` (a copy of `../teamtest-net.js`) for transport and `shared/tasks.js` for boards, the same way a production
client should.

The design prototype only simulates locally; `TeamTestNet.connect('ws://localhost:8787')` will send its
frames here, but it doesn't render server state.

| env | default | |
| --- | --- | --- |
| `PORT` | `8787` | WebSocket + HTTP on the same port |
| `DATA_FILE` | `data/db.json` | accounts / runs store |
| `PUBLIC_URL` | `http://localhost:PORT` | base for invite links |
| `SOLO_PHASE_MS` | `30000` | how long players rotate through solo minigames before the cutoff |
| `COOP_VARIANT` | random | dev only: force `tokens`, `hold` or `relay` |
| `QUEUE_BOT_BUTTON_MS` | `10000` | how long a player waits in matchmaking before FILL WITH BOTS unlocks (`queue.fill_bots`) |
| `QUEUE_BOT_FILL_MS` | `0` | >0 auto-fills a waiting random-queue room with bots after this long; off by default |

HTTP: `GET /` (client), `/healthz`, `/stats`, `/leaderboard?limit=20`, `/join/:code` (invite-link target).

## Layout

- `shared/tasks.js` — seeded board generators + graders. **Load this in the client too** (UMD:
  `require()` or `<script>` → `window.TeamTestTasks`). `generate(kind, seed, level)` is how every
  client renders an identical board from `task.assign` without the server shipping geometry.
- `src/room.js` — the authoritative run: life meters, drain curve, rounds, partner credit, co-op, run end.
- `src/hub.js` — sockets, `seq` checks, matchmaking, private codes, invites, friends.
- `src/bots.js` — stand-ins for empty seats / dropped players (prototype teammate behaviour).
- `src/store.js` — JSON-file persistence (accounts, runs, leaderboard view). Swap for a real DB behind the same methods.

## How a run works

- **Solo phase → co-op → solo phase → …**
  - **Solo phase** (`phase.solo { cutoffAt }`): nobody waits for anyone. Each player rotates through
    `GATE, MEMORY, DIGITS, SLIDE, ORDER, SEQUENCE, SHELL, STROOP, COUNT` at their own pace. The next
    minigame's `task.assign` follows 400 ms after each `task.result`. Every resolution settles at once
    (`round.settle`): ±9/−13 to that player's partner (bots ±7/−11).
  - **Cutoff** (`phase.cutoff { graceEndsAt }`) at `SOLO_PHASE_MS`: no new minigames. A task in progress
    gets up to 4 s more (it's re-sent as `task.assign` with the same `id`, a shorter `deadline` and `cut: true`).
    Anyone who's finished gets `phase.waiting { until }`.
  - **Phase end** (`phase.solo_end { coopAt, variant }`) once everyone has finished or the 4 s run out. The
    co-op variant is picked here so clients can show a "co-op incoming" card naming it; the round starts 2.5 s later.
  - Task ids are unique across the run. Level (0-based, shared by the team) = number of co-op rounds finished so far.
    Partners are fixed by seat: P1 → P2 → P3 → P4 → P1.
- **Deadlines** are server epoch ms = assign + `showMs` + `answerMs` + 400 ms grace.
- **Drain** `0.42 × 1.5^max(0, min−0.5)` pts/s on all four, every 100 ms tick, from `startsAt`.
  `life.sync` goes out every 250 ms and after every change.
- **Run end** the instant any meter hits 0 → `run.ended { cause: "<playerId>_depleted", standings, teamTime, tasksCleared, timeline }`,
  run is persisted, room returns to lobby so the host can go again.
  - Each standing has `partner`, `fed { plus, minus }` (partner credit from that player's solo tasks — co-op
    bonuses excluded), `self` (life lost to their own slips) and the older `gave`/`cost` totals.
  - `timeline { everyMs: 2000, ids, samples: [[elapsedMs, life of ids[0..3]], …], coops: [{ start, end, ok, variant }] }`
    drives the end-screen life chart; the last sample is the moment the run ended.
- **Drops** pause the run (`room.paused`). Reconnecting with the same `playerId` resumes the seat automatically;
  after 8 s a bot takes the seat and the run resumes. The player can still reclaim it later.

## Answer payloads (what the server grades)

Clients never report success — `{ complete: true }` / `{ ok: true }` style payloads are rejected with `bad_payload`.
All may include `id` (the task id); a mismatched id is rejected as `stale_task`.

| kind | frame | payload |
| --- | --- | --- |
| MEMORY | `task.submit` | `{ choice }` index into `board.choices` |
| SHELL | `task.submit` | `{ cup }` cup id |
| STROOP | `task.submit` | `{ ink }` colour name |
| COUNT | `task.submit` | `{ count }` |
| SEQUENCE | `task.submit` | `{ pad }` per press, or `{ pads: [...] }` |
| DIGITS | `task.submit` | `{ index }` per tap — wrong tap = −6 to self (once per cell; repeat taps are free) |
| ORDER | `task.submit` | `{ answer }` for the single question |
| SLIDE | `slide.lock` | `{ track, value }` — locks if within `board.tolerance` of target |
| GATE | `task.submit` | `{ event: "goal" }`; collisions: `gate.collision {}` or `{ event: "collision" }` = −7 to self |

GATE ball physics are client-side, so the server can only sanity-check it (a goal faster than 600 ms fails).

## Co-op inputs

| variant | frame | payload |
| --- | --- | --- |
| tokens | `coop.claim` | `{ n }` — must be yours (`owner` = your slot − 1) and next in order, else −9 |
| hold | `coop.hold` | `{ down: true \| false }` |
| relay | `coop.tap` (or `coop.relay_pass`) | `{}` — on your armed turn; early = −6, +9 heat |
| relay | `coop.vent` | `{}` — not on your own armed turn; cools the coil for 1.1 s (shared cooldown) and locks only the venter's own taps meanwhile |

`coop.state` is pushed on every change (tokens) or at 5 Hz (hold/relay) with the live board.

## Frames added beyond PROTOCOL.md

Server → client: `hello`, `room.joined { code, slot, colour, host, roster }`, `room.created { code, invite }`,
`room.invited { code, invite, from }`, `room.invite_sent`, `room.host`, `room.lobby`, `room.left`, `room.paused`, `room.resumed`,
`queue.joined`, `queue.left`, `phase.solo`, `phase.cutoff`, `phase.waiting`, `phase.solo_end`, `task.result { id, ok, reason }`, `task.progress`, `life.penalty { playerId, amount, reason }`,
`coop.overheat`, `friend.list`, `friend.presence`, `account`, `leaderboard { rows }`, `pong`,
`error { code, message, ref }` (`ref` = the offending frame's `seq`).

Client → server: `queue.fill_bots` (after the wait; else `too_early` — `room.ready` in a public room that isn't full follows the same rule), `room.leave`, `room.join { friend }` (join a friend's room), `friend.add|remove { handle }`,
`friend.list`, `account.handle { handle }`, `leaderboard.get { limit }`, `ping`, plus the co-op inputs above.
Other telemetry the prototype emits (`task.start`, `order.wrong`, `coop.start`, …) is accepted and ignored.

## Known limits

- **No auth.** The first frame's `playerId` claims the account. Put a real token check in `Hub.bind` before shipping.
- **Seeds reveal answers.** A modded client can compute answers from the seed; that's the cost of not shipping geometry.
  The server still owns timing, order, ownership, and every life delta.
- Single process, in-memory rooms. If the process dies the run dies (matches the original).
