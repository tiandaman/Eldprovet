# The Team Test — client/server contract

The prototype already speaks this protocol. It runs in **mock mode** with no
server: every event is logged to the console and to the on-screen socket panel.
Point it at a WebSocket and the same frames go over the wire.

```js
TeamTestNet.identify('TT-4K9Q', 'p1');
TeamTestNet.connect('ws://localhost:8787');
TeamTestNet.logLevel = 'debug';        // see every frame in devtools
TeamTestNet.download('run-01');        // NDJSON of the whole session
```

## Frame shape

Every message in both directions:

```json
{
  "v": 1,
  "seq": 42,
  "t": 1726900000000,
  "roomId": "TT-4K9Q",
  "playerId": "p1",
  "type": "task.submit",
  "payload": { "choice": 2 }
}
```

`seq` is per-connection and monotonic. The server should reject out-of-order or
replayed `seq` values per player.

## Client → server

| type | payload | when |
| --- | --- | --- |
| `queue.join` | `{ region }` | player enters random matchmaking |
| `queue.leave` | `{}` | player cancels |
| `room.create` | `{ private: true }` | private room requested |
| `room.join` | `{ code }` | joining by invite link |
| `room.invite` | `{ to }` | invite sent to a friend |
| `room.ready` | `{}` | host starts the run |
| `presence.move` | `{ x, y }` | normalised 0–1 touch position, ~20 Hz |
| `presence.tap` | `{ x, y }` | discrete tap, drives the ripple |
| `task.submit` | task-specific | solo answer submitted |
| `coop.claim` | `{ n }` | player claims a numbered token |
| `slide.lock` | `{ track, value }` | a slider was released |

## Server → client

| type | payload | meaning |
| --- | --- | --- |
| `room.player_joined` | `{ slot, playerId, colour }` | roster change |
| `room.player_left` | `{ slot }` | drop; run pauses briefly |
| `room.ready` | `{ size, seed, partnerMap }` | run is starting |
| `task.assign` | `{ id, kind, seed, level, deadline }` | next task for this player |
| `round.settle` | `{ deltas: { p1: 9, p2: -11, … } }` | end-of-round life changes |
| `life.sync` | `{ life: { p1: 82, … }, decay }` | authoritative meters + drain rate |
| `coop.state` | `{ tokens, next }` | shared co-op board |
| `coop.solved` / `coop.expired` | `{ bonus }` / `{ penalty }` | co-op result |
| `presence.move` | `{ playerId, x, y }` | a teammate's finger |
| `presence.tap` | `{ playerId, x, y, ok }` | ripple + fading mark |
| `run.ended` | `{ cause, standings, teamTime }` | any meter hit zero |

## What the server owns

The client renders; it never decides who lives.

- **Matchmaking pool and room codes.** Four-player rooms, random fill or invite.
- **Task assignment.** `kind`, `level`, and a `seed` so all four clients can
  generate an identical board without the server shipping geometry.
- **Life meters.** Authoritative. Clients tween toward `life.sync` values and
  never apply deltas locally except as optimistic prediction.
- **The drain curve.** `decay` is pushed down; the prototype uses
  `0.42 × 1.5^max(0, minutes − 0.5)` points per second per player.
- **The partner map.** Who credits whom. Rotated per run.
- **Presence fan-out.** ~20 Hz, last-write-wins, no history. Drop rather than
  queue — a late cursor is worse than no cursor.

## Minimal server to start with

```js
// node server.js   ·   npm i ws
const { WebSocketServer } = require('ws');
const rooms = new Map();

new WebSocketServer({ port: 8787 }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    const f = JSON.parse(raw);
    const room = rooms.get(f.roomId) ?? rooms.set(f.roomId, new Set()).get(f.roomId);
    room.add(ws);
    ws.roomId = f.roomId;

    console.log(`[${f.roomId}] ${f.playerId} ${f.type}`, f.payload);

    // presence is pure fan-out; everything else needs real rules
    if (f.type.startsWith('presence.')) {
      for (const peer of room) {
        if (peer !== ws && peer.readyState === 1) {
          peer.send(JSON.stringify({ ...f, payload: { ...f.payload, playerId: f.playerId } }));
        }
      }
    }
  });
  ws.on('close', () => rooms.get(ws.roomId)?.delete(ws));
});
```

Start there, watch the console while you play the prototype, then move the life
meters and task assignment server-side one event at a time.

## Persistence

Only three things need a database:

- **accounts** — id, handle, friends
- **runs** — roomId, started, ended, teamTime, tasksCleared, cause, four
  `{ playerId, gave, cost, finalLife }` rows
- **leaderboard** — a view over `runs` where the room was private

Live game state is per-room memory. If the process dies, the run dies with it —
that matches the original.
