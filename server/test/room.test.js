'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Tasks = require('../shared/tasks');
const { Room } = require('../src/room');

function fakeConn() {
  return {
    frames: [],
    send(type, payload) { this.frames.push({ type, payload }); },
    buffered() { return 0; },
    last(type) { for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].type === type) return this.frames[i].payload; return null; },
    all(type) { return this.frames.filter((f) => f.type === type).map((f) => f.payload); },
  };
}

function setup(config) {
  let now = 1_000_000;
  const clock = { now: () => now, advance(ms, step = 100) { for (let t = 0; t < ms; t += step) { now += step; room.tick(); } } };
  const room = new Room({ code: 'TT-TEST', private: true, now: clock.now, random: () => 0.5, config: Object.assign({ manualTick: true, allowBots: true }, config) });
  const conns = {};
  for (const id of ['p1', 'p2', 'p3', 'p4']) { conns[id] = fakeConn(); room.join(conns[id], id); }
  return { room, conns, clock };
}

test('lobby: slots, colours, host-only start', () => {
  const { room, conns } = setup();
  assert.deepStrictEqual(room.members.map((m) => m.slot), [1, 2, 3, 4]);
  assert.strictEqual(conns.p1.last('room.joined').slot, 1);
  assert.strictEqual(room.join(fakeConn(), 'p5'), 'room_full');
  assert.strictEqual(room.requestStart('p2'), 'not_host');
  assert.strictEqual(room.requestStart('p1'), null);
  const ready = conns.p3.last('room.ready');
  assert.strictEqual(ready.size, 4);
  // partner map is a single 4-cycle
  let at = 'p1'; const seen = new Set();
  for (let i = 0; i < 4; i++) { seen.add(at); at = ready.partnerMap[at]; }
  assert.strictEqual(at, 'p1'); assert.strictEqual(seen.size, 4);
  for (const v of Object.values(ready.life)) assert.ok(v >= 66 && v <= 90);
});

test('drain applies only during play and follows the curve', () => {
  const { room, clock } = setup();
  room.requestStart('p1');
  const before = room.run.life.p1;
  clock.advance(900); // countdown, no drain
  assert.strictEqual(room.run.life.p1, before);
  room.run.round = { n: 0, coop: false, tasks: {} }; // park the round flow
  room.run.nextRoundAt = Infinity;
  room.tickSolo = () => {};
  clock.advance(10000);
  assert.ok(Math.abs(before - room.run.life.p1 - 4.2) < 0.05, 'expected ~4.2 drained in 10s');
});

test('solo: each player advances immediately; partner credited per task', () => {
  const { room, conns, clock } = setup();
  room.requestStart('p1');
  clock.advance(1100);
  const a = conns.p1.last('task.assign');
  assert.strictEqual(a.kind, 'GATE');
  assert.ok(a.cutoffAt > clock.now());
  const map = room.run.partnerMap;
  const life0 = room.run.life[map.p1];
  clock.advance(Tasks.generate('GATE', a.seed, a.level).minSolveMs + 100);
  room.handle(room.member('p1'), 'task.submit', { event: 'goal' });
  const settle = conns.p1.last('round.settle');
  assert.deepStrictEqual(settle.results.p1, { ok: true, to: map.p1, amount: 9 });
  assert.ok(room.run.life[map.p1] > life0 + 8.5); // +9 minus ~0.3 drain
  assert.strictEqual(room.run.gave.p1, 9);
  // p1 gets the next minigame right away; the others are still on GATE
  clock.advance(500);
  const next = conns.p1.last('task.assign');
  assert.strictEqual(next.kind, 'MEMORY');
  assert.notStrictEqual(next.id, a.id);
  assert.strictEqual(conns.p2.last('task.assign').kind, 'GATE');
  // a wrong-case: p3 collides (−7 self) then times out (−13 to partner)
  room.handle(room.member('p3'), 'gate.collision', {});
  assert.ok(conns.p2.all('life.penalty').some((x) => x.playerId === 'p3' && x.amount === -7));
  clock.advance(room.run.round.tasks.p3.deadline - clock.now() + 100);
  assert.ok(conns.p4.all('round.settle').some((s) => s.playerId === 'p3' && s.results.p3.amount === -13));
});

test('cutoff: in-flight tasks get 4s, finished players wait, then co-op', () => {
  const { room, conns, clock } = setup({ soloPhaseMs: 5000, coopVariant: 'tokens' });
  room.requestStart('p1');
  clock.advance(1100);
  const rd = room.run.round;
  // p1 finishes GATE, gets MEMORY; nobody else acts
  clock.advance(700);
  room.handle(room.member('p1'), 'task.submit', { event: 'goal' });
  clock.advance(500);
  const mem = room.run.round.tasks.p1;
  assert.strictEqual(mem.kind, 'MEMORY');
  // reach the cutoff
  clock.advance(rd.cutoffAt - clock.now() + 50);
  assert.ok(conns.p2.last('phase.cutoff'));
  const cut = conns.p2.last('task.assign');
  assert.strictEqual(cut.cut, true);
  assert.strictEqual(cut.deadline, rd.graceEndsAt);
  assert.strictEqual(rd.graceEndsAt - rd.cutoffAt, 4000);
  // p1 answers during grace → waiting screen, no new task
  room.handle(room.member('p1'), 'task.submit', { choice: mem.board.answer });
  assert.strictEqual(conns.p1.last('phase.waiting').until, rd.graceEndsAt);
  const assigns = conns.p1.all('task.assign').length;
  clock.advance(1000);
  assert.strictEqual(conns.p1.all('task.assign').length, assigns, 'no new solo task after cutoff');
  // others time out at grace end → phase ends → co-op
  clock.advance(rd.graceEndsAt - clock.now() + 100);
  assert.ok(conns.p3.last('phase.solo_end'));
  clock.advance(1000);
  assert.strictEqual(conns.p1.last('task.assign').kind, 'COOP');
});

test('cutoff: phase ends early once everyone has finished', () => {
  const { room, conns, clock } = setup({ soloPhaseMs: 3000 });
  room.requestStart('p1');
  clock.advance(1100);
  clock.advance(room.run.round.cutoffAt - clock.now() + 50);
  const rd = room.run.round;
  clock.advance(100);
  for (const id of ['p1', 'p2', 'p3', 'p4']) room.handle(room.member(id), 'task.submit', { event: 'goal' });
  clock.advance(100);
  assert.ok(conns.p1.last('phase.solo_end'));
  assert.ok(clock.now() < rd.graceEndsAt);
});

test('after co-op, a new solo phase starts', () => {
  const { room, conns, clock } = setup({ coopVariant: 'tokens' });
  room.requestStart('p1');
  room.run.nextIsCoop = true;
  clock.advance(1100);
  const a = conns.p1.last('task.assign');
  const board = Tasks.generateCoop('tokens', a.seed, a.level);
  for (let n = 1; n <= 12; n++) room.handle(room.memberAtSeat(board.tokens[n - 1].owner), 'coop.claim', { n });
  clock.advance(2500);
  assert.ok(conns.p1.last('phase.solo'));
  assert.strictEqual(conns.p1.last('task.assign').kind, 'GATE');
});

test('co-op tokens: owner + order enforced, 12 clears = +16 all', () => {
  const { room, conns, clock } = setup({ coopVariant: 'tokens' });
  room.requestStart('p1');
  room.run.nextIsCoop = true;
  clock.advance(1100);
  const assign = conns.p1.last('task.assign');
  assert.strictEqual(assign.kind, 'COOP');
  const board = Tasks.generateCoop('tokens', assign.seed, assign.level);
  const ownerOf = (n) => room.memberAtSeat(board.tokens[n - 1].owner);
  const wrongOwner = room.members.find((m) => m !== ownerOf(1));
  const lifeW = room.run.life[wrongOwner.playerId];
  room.handle(wrongOwner, 'coop.claim', { n: 1 });
  assert.ok(room.run.life[wrongOwner.playerId] <= lifeW - 9 + 0.01);
  const lifeBefore = Object.assign({}, room.run.life);
  for (let n = 1; n <= 12; n++) assert.strictEqual(room.handle(ownerOf(n), 'coop.claim', { n }), null);
  assert.ok(conns.p2.last('coop.solved'));
  for (const id of Object.keys(lifeBefore)) assert.ok(room.run.life[id] >= Math.min(100, lifeBefore[id] + 15.9));
});

test('co-op hold: charge only builds while all four hold', () => {
  const { room, conns, clock } = setup({ coopVariant: 'hold' });
  room.requestStart('p1');
  room.run.nextIsCoop = true;
  clock.advance(1100);
  for (const id of ['p1', 'p2', 'p3']) room.handle(room.member(id), 'coop.hold', { down: true });
  clock.advance(500);
  assert.strictEqual(room.run.round.st.charge, 0);
  room.handle(room.member('p4'), 'coop.hold', { down: true });
  clock.advance(500);
  assert.ok(room.run.round.st.charge > 0);
  assert.ok(conns.p1.last('coop.state').grip[0] < 100);
});

test('co-op relay: out-of-turn tap costs 6', () => {
  const { room, clock } = setup({ coopVariant: 'relay' });
  room.requestStart('p1');
  room.run.nextIsCoop = true;
  clock.advance(1100);
  const rd = room.run.round;
  const notTurn = room.memberAtSeat(rd.board.order[(rd.st.hop + 1) % 4]);
  const l = room.run.life[notTurn.playerId];
  room.handle(notTurn, 'coop.tap', {});
  assert.ok(room.run.life[notTurn.playerId] <= l - 6 + 0.01);
  // arm, then the right player passes
  clock.advance(1000);
  assert.ok(rd.st.armed);
  const turn = room.memberAtSeat(rd.board.order[rd.st.hop % 4]);
  room.handle(turn, 'coop.tap', {});
  assert.strictEqual(rd.st.hop, 1);
});

test('run ends when a meter hits 0; standings + back to lobby', () => {
  const { room, conns, clock } = setup();
  room.requestStart('p1');
  clock.advance(1100);
  room.run.life.p2 = 0.01;
  clock.advance(200);
  const end = conns.p1.last('run.ended');
  assert.strictEqual(end.cause, 'p2_depleted');
  assert.strictEqual(end.standings.length, 4);
  assert.strictEqual(room.state, 'lobby');
});

test('drop pauses the run; bot takes the seat after grace; rejoin reclaims', () => {
  const { room, conns, clock } = setup({ pauseGraceMs: 2000 });
  room.requestStart('p1');
  clock.advance(1100);
  const life = room.run.life.p1;
  room.leave('p2', false);
  assert.ok(conns.p1.last('room.player_left'));
  assert.ok(room.run.pausedAt);
  clock.advance(1000);
  assert.strictEqual(room.run.life.p1, life, 'no drain while paused');
  clock.advance(1500);
  assert.strictEqual(room.member('p2').bot, true);
  assert.strictEqual(room.run.pausedAt, 0, 'resumed with bot');
  const c = fakeConn();
  room.join(c, 'p2');
  assert.strictEqual(room.member('p2').bot, false);
  assert.ok(c.last('room.ready').resumed);
});

test('private room short-handed start fills bots', () => {
  let now = 0;
  const room = new Room({ code: 'TT-BOTS', private: true, now: () => now, config: { manualTick: true } });
  const c = fakeConn();
  room.join(c, 'solo');
  room.requestStart('solo');
  assert.strictEqual(room.members.filter((m) => m.bot).length, 3);
  // bots resolve their own tasks and rounds keep flowing
  for (let i = 0; i < 600; i++) { now += 100; room.tick(); if (room.state !== 'play') break; }
  assert.ok(c.all('round.settle').length >= 1);
});

test('presence: fan-out to others, throttled, clamped', () => {
  const { room, conns, clock } = setup();
  const p1 = room.member('p1');
  room.handle(p1, 'presence.move', { x: 0.5, y: 2 });
  room.handle(p1, 'presence.move', { x: 0.6, y: 0.6 }); // same instant → dropped
  assert.strictEqual(conns.p1.all('presence.move').length, 0);
  assert.deepStrictEqual(conns.p2.all('presence.move'), [{ playerId: 'p1', slot: 1, x: 0.5, y: 1 }]);
  clock.advance(100);
  room.handle(p1, 'presence.tap', { x: 0.1, y: 0.1 });
  room.handle(p1, 'presence.tap', { x: 0.1, y: 0.1 }); // burst → dropped
  assert.strictEqual(conns.p4.all('presence.tap').length, 1);
  assert.strictEqual(conns.p4.last('presence.tap').ok, true);
});

test('co-op hold: bots follow a holding human and it gets solved', () => {
  let now = 5_000_000;
  const room = new Room({ code: 'TT-HOLD', private: true, now: () => now, random: () => 0.5, config: { manualTick: true, coopVariant: 'hold' } });
  const c = fakeConn();
  room.join(c, 'solo');
  room.requestStart('solo');           // 3 bots fill in
  room.run.nextIsCoop = true;
  const tick = (ms) => { for (let t = 0; t < ms; t += 100) { now += 100; room.tick(); } };
  tick(1100);
  assert.strictEqual(room.run.round.variant, 'hold');
  room.handle(room.member('solo'), 'coop.hold', { down: true });
  tick(4000);                            // well inside one grip (~5 s)
  assert.ok(c.last('coop.solved'), 'solved with bot help');
});

test('co-op relay: a tap just after the window closes still counts (latency grace)', () => {
  const { room, clock } = setup({ coopVariant: 'relay' });
  room.requestStart('p1');
  room.run.nextIsCoop = true;
  clock.advance(1100);
  const rd = room.run.round;
  clock.advance(1000);                  // armed
  assert.ok(rd.st.armed);
  const turn = room.memberAtSeat(rd.board.order[rd.st.hop % 4]);
  clock.advance(rd.st.at - clock.now() + 100); // 100 ms past the visible window
  const life = room.run.life[turn.playerId];
  room.handle(turn, 'coop.tap', {});
  assert.strictEqual(rd.st.hop, 1, 'caught');
  assert.ok(room.run.life[turn.playerId] >= life - 0.01, 'no miss penalty');
});
