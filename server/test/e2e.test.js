'use strict';
/* End-to-end over real sockets: 4 clients queue, play a solo round by
 * regenerating boards from the shared seed, and see presence fan-out. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Tasks = require('../shared/tasks');
const { createServer } = require('../src/index');

class Client {
  constructor(url, playerId) {
    this.playerId = playerId;
    this.roomId = null;
    this.seq = 0;
    this.inbox = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw);
      if (f.type === 'room.joined') this.roomId = f.payload.code;
      this.inbox.push(f);
      this.waiters = this.waiters.filter((w) => !w(f));
    });
  }
  open() { return new Promise((r) => this.ws.once('open', r)); }
  send(type, payload, seq) {
    this.ws.send(JSON.stringify({ v: 1, seq: seq || ++this.seq, t: Date.now(), roomId: this.roomId, playerId: this.playerId, type, payload: payload || {} }));
  }
  wait(type, pred, ms = 3000) {
    const hit = this.inbox.find((f) => f.type === type && (!pred || pred(f.payload)));
    if (hit) return Promise.resolve(hit.payload);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(this.playerId + ' timed out waiting for ' + type)), ms);
      this.waiters.push((f) => {
        if (f.type === type && (!pred || pred(f.payload))) { clearTimeout(to); resolve(f.payload); return true; }
        return false;
      });
    });
  }
  close() { this.ws.close(); }
}

test('queue → room.ready → graded round → presence', async (t) => {
  const app = createServer({
    port: 0, quiet: true, queueBotFillMs: 0,
    dataFile: path.join(os.tmpdir(), 'tt-e2e-' + process.pid + '.json'),
  });
  const port = await app.listen();
  t.after(() => app.close());
  const url = 'ws://127.0.0.1:' + port;

  const cs = ['ana', 'bo', 'cy', 'di'].map((id) => new Client(url, id));
  await Promise.all(cs.map((c) => c.open()));
  for (const c of cs) { c.send('queue.join', { region: 'eu' }); await c.wait('queue.joined'); }

  const ready = await cs[0].wait('room.ready');
  assert.strictEqual(ready.size, 4);
  assert.ok(cs.every((c) => c.roomId === cs[0].roomId));

  // Replayed seq is rejected.
  cs[0].send('ping', {}, 1);
  assert.strictEqual((await cs[0].wait('error', (p) => p.code === 'bad_seq')).code, 'bad_seq');

  // Round 1 is GATE; everyone regenerates the board from the seed.
  const assigns = await Promise.all(cs.map((c) => c.wait('task.assign')));
  for (const a of assigns) {
    assert.strictEqual(a.kind, 'GATE');
    const board = Tasks.generate(a.kind, a.seed, a.level);
    assert.strictEqual(board.bars.length, 1); // L1: one slow bar
  }
  await new Promise((r) => setTimeout(r, 700)); // beat minSolveMs
  cs[0].send('task.submit', { id: assigns[0].id, event: 'goal' });
  cs[1].send('task.submit', { id: assigns[1].id, event: 'goal' });
  cs[2].send('task.submit', { id: assigns[2].id, complete: true }); // client verdicts are refused
  assert.strictEqual((await cs[2].wait('error')).code, 'bad_payload');
  cs[2].send('task.submit', { id: assigns[2].id, event: 'goal' });
  cs[3].send('gate.collision', { id: assigns[3].id, bar: 0 });
  await cs[0].wait('life.penalty', (p) => p.playerId === 'di');
  cs[3].send('task.submit', { id: assigns[3].id, event: 'goal' });

  // Each resolution settles on its own: four +9 credits.
  for (const c of cs) {
    const settle = await c.wait('round.settle', (p) => p.playerId === c.playerId);
    assert.strictEqual(settle.results[c.playerId].amount, 9);
  }
  const sync = await cs[1].wait('life.sync');
  assert.strictEqual(Object.keys(sync.life).length, 4);

  // Presence reaches the other three, not the sender.
  cs[0].send('presence.move', { x: 0.25, y: 0.75 });
  const moves = await Promise.all(cs.slice(1).map((c) => c.wait('presence.move')));
  for (const m of moves) assert.deepStrictEqual(m, { playerId: 'ana', slot: 1, x: 0.25, y: 0.75 });

  // ana's next minigame (MEMORY) arrives straight away — answer from the regenerated board.
  const m2 = await cs[0].wait('task.assign', (p) => p.kind === 'MEMORY', 2000);
  const board = Tasks.generate(m2.kind, m2.seed, m2.level);
  cs[0].send('task.submit', { id: m2.id, choice: board.answer });
  assert.strictEqual((await cs[0].wait('task.result', (p) => p.id === m2.id)).ok, true);

  cs.forEach((c) => c.close());
});

test('private room, invite, friends, short-handed start', async (t) => {
  const app = createServer({ port: 0, quiet: true, dataFile: path.join(os.tmpdir(), 'tt-e2e2-' + process.pid + '.json') });
  const port = await app.listen();
  t.after(() => app.close());
  const url = 'ws://127.0.0.1:' + port;
  const host = new Client(url, 'host1');
  const pal = new Client(url, 'pal1');
  await Promise.all([host.open(), pal.open()]);

  host.send('room.create', { private: true });
  const created = await host.wait('room.created');
  assert.match(created.code, /^TT-[A-Z2-9]{4}$/);
  assert.ok(created.invite.endsWith('/join/' + created.code));

  pal.send('ping');
  await pal.wait('pong');
  host.send('friend.add', { handle: 'pal1' });
  await host.wait('friend.list', (p) => p.friends.length === 1);
  host.send('room.invite', { to: 'pal1' });
  const inv = await pal.wait('room.invited');
  assert.strictEqual(inv.code, created.code);

  pal.send('room.join', { friend: 'host1' });
  await pal.wait('room.joined');
  await host.wait('room.player_joined', (p) => p.playerId === 'pal1');

  const res = await fetch('http://127.0.0.1:' + port + '/join/' + created.code).then((r) => r.json());
  assert.strictEqual(res.size, 2);

  pal.send('room.ready');
  assert.strictEqual((await pal.wait('error')).code, 'not_host');
  host.send('room.ready');
  const ready = await pal.wait('room.ready');
  assert.strictEqual(ready.roster.filter((r) => r.bot).length, 2);

  host.close(); pal.close();
});

test('queue: no auto-fill; fill_bots only after the wait', async (t) => {
  const app = createServer({
    port: 0, quiet: true, queueBotButtonMs: 600,
    dataFile: path.join(os.tmpdir(), 'tt-e2e3-' + process.pid + '.json'),
  });
  const port = await app.listen();
  t.after(() => app.close());
  const c = new Client('ws://127.0.0.1:' + port, 'solo1');
  await c.open();
  c.send('queue.join', { region: 'na' });
  const joined = await c.wait('queue.joined');
  assert.strictEqual(joined.botsAfterMs, 600);
  c.send('queue.fill_bots');
  assert.strictEqual((await c.wait('error', (p) => p.code === 'too_early')).code, 'too_early');
  await new Promise((r) => setTimeout(r, 1300)); // well past the old auto-fill tick: still nobody added
  assert.ok(!c.inbox.some((f) => f.type === 'room.ready'), 'no auto-fill');
  c.send('queue.fill_bots');
  const ready = await c.wait('room.ready');
  assert.strictEqual(ready.roster.filter((r) => r.bot).length, 3);
  c.close();
});

test('rename: saved, shown in the room roster, clashes refused', async (t) => {
  const app = createServer({ port: 0, quiet: true, dataFile: path.join(os.tmpdir(), 'tt-e2e4-' + process.pid + '.json') });
  const port = await app.listen();
  t.after(() => app.close());
  const url = 'ws://127.0.0.1:' + port;
  const a = new Client(url, 'pa1'), b = new Client(url, 'pb1');
  await Promise.all([a.open(), b.open()]);
  a.send('room.create', { private: true });
  const { code } = await a.wait('room.created');
  b.send('room.join', { code });
  await a.wait('room.player_joined', (p) => p.playerId === 'pb1');
  b.send('account.handle', { handle: 'Bea Smith' });
  assert.strictEqual((await b.wait('account')).handle, 'Bea Smith');
  const seen = await a.wait('room.player_joined', (p) => p.renamed);
  assert.strictEqual(seen.handle, 'Bea Smith');
  a.send('account.handle', { handle: 'bea smith' });
  assert.strictEqual((await a.wait('error', (p) => p.code === 'handle_taken')).code, 'handle_taken');
  a.send('account.handle', { handle: 'x' });
  assert.strictEqual((await a.wait('error', (p) => p.code === 'bad_handle')).code, 'bad_handle');
  a.close(); b.close();
});
