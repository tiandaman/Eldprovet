'use strict';
/* Connection handling, frame validation, matchmaking, and social features.
 *
 * One Hub per process. It binds each socket to a playerId, enforces
 * monotonic `seq`, routes frames to the right Room, and owns the random
 * queue, private room codes, invites and friends.
 */
const crypto = require('crypto');
const { Room } = require('./room');

const PROTOCOL_VERSION = 1;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_FRAME_BYTES = 8 * 1024;

class Conn {
  constructor(ws, hub) {
    this.ws = ws;
    this.hub = hub;
    this.playerId = null;
    this.roomId = null;
    this.lastSeq = 0;
    this.outSeq = 0;
    this.alive = true;
  }

  buffered() { return this.ws.bufferedAmount || 0; }

  send(type, payload, opts) {
    if (this.ws.readyState !== 1) return;
    const frame = {
      v: PROTOCOL_VERSION,
      seq: ++this.outSeq,
      t: Date.now(),
      roomId: (opts && opts.roomId) || this.roomId,
      playerId: (opts && opts.from) || 'server',
      type,
      payload: payload || {},
    };
    this.ws.send(JSON.stringify(frame));
  }

  error(code, message, ref) {
    this.send('error', { code, message: message || code, ref: ref == null ? null : ref });
  }
}

class Hub {
  constructor(opts) {
    this.store = opts.store;
    this.cfg = Object.assign({
      queueBotFillMs: 0,        // >0 auto-fills a waiting random-queue room with bots after this long (off by default)
      queueBotButtonMs: 10000,  // how long a player must wait before they may ask for bots (queue.fill_bots)
      publicUrl: 'http://localhost:8787',
      room: {},
    }, opts.config || {});
    this.log = opts.log || ((...a) => console.log(...a));
    this.conns = new Map();     // playerId → Conn
    this.rooms = new Map();     // code → Room
    this.playerRoom = new Map(); // playerId → code
    this.forming = new Map();   // region → Room (random queue, still filling)
    this.queueTimer = setInterval(() => this.tickQueue(), 1000);
    if (this.queueTimer.unref) this.queueTimer.unref();
  }

  // ── sockets ─────────────────────────────────────────────
  attach(ws) {
    const conn = new Conn(ws, this);
    ws.on('message', (raw, isBinary) => this.onMessage(conn, raw, isBinary));
    ws.on('close', () => this.onClose(conn));
    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', () => {});
    return conn;
  }

  onMessage(conn, raw, isBinary) {
    if (isBinary || raw.length > MAX_FRAME_BYTES) return conn.error('bad_frame', 'text frames under 8 KiB only');
    let f;
    try { f = JSON.parse(raw.toString('utf8')); } catch (e) { return conn.error('bad_frame', 'invalid JSON'); }
    if (!f || typeof f !== 'object' || typeof f.type !== 'string') return conn.error('bad_frame', 'missing type');
    if (f.v !== PROTOCOL_VERSION) return conn.error('bad_version', 'expected v=' + PROTOCOL_VERSION, f.seq);
    if (!Number.isInteger(f.seq) || f.seq <= conn.lastSeq) return conn.error('bad_seq', 'seq must increase (last ' + conn.lastSeq + ')', f.seq);
    conn.lastSeq = f.seq;

    // Bind the connection to a player on its first frame.
    if (!conn.playerId) {
      if (typeof f.playerId !== 'string' || !PLAYER_ID_RE.test(f.playerId)) return conn.error('bad_player', 'playerId must match ' + PLAYER_ID_RE, f.seq);
      this.bind(conn, f.playerId, f.roomId);
    } else if (f.playerId !== conn.playerId) {
      return conn.error('bad_player', 'playerId is bound to ' + conn.playerId, f.seq);
    }

    const payload = f.payload && typeof f.payload === 'object' ? f.payload : {};
    let err = null;
    try {
      err = this.route(conn, f.type, payload, f);
    } catch (e) {
      console.error('[hub] handler failed', f.type, e);
      err = 'internal';
    }
    if (err) conn.error(err, f.type, f.seq);
  }

  bind(conn, playerId, roomHint) {
    const prev = this.conns.get(playerId);
    if (prev && prev !== conn) {
      prev.replaced = true;
      prev.error('replaced', 'signed in from another connection');
      prev.ws.close(4001, 'replaced');
    }
    conn.playerId = playerId;
    this.conns.set(playerId, conn);
    this.store.ensureAccount(playerId);
    const account = this.store.getAccount(playerId);
    conn.send('hello', { playerId, handle: account.handle, protocol: PROTOCOL_VERSION });

    // Resume a seat this player still holds.
    const code = this.playerRoom.get(playerId);
    const room = code && this.rooms.get(code);
    if (room && room.member(playerId)) {
      conn.roomId = room.code;
      room.join(conn, playerId);
    } else if (code) {
      this.playerRoom.delete(playerId);
    }
    this.notifyFriends(playerId);
  }

  onClose(conn) {
    if (!conn.playerId || conn.replaced) return;
    if (this.conns.get(conn.playerId) === conn) this.conns.delete(conn.playerId);
    const room = this.roomOf(conn);
    if (room) {
      room.leave(conn.playerId, false);
      if (!room.member(conn.playerId)) this.playerRoom.delete(conn.playerId);
    }
    this.notifyFriends(conn.playerId);
  }

  heartbeat() {
    for (const conn of this.conns.values()) {
      if (!conn.alive) { conn.ws.terminate(); continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch (e) { /* closing */ }
    }
  }

  roomOf(conn) {
    const code = this.playerRoom.get(conn.playerId);
    return code ? this.rooms.get(code) || null : null;
  }

  // ── routing ─────────────────────────────────────────────
  route(conn, type, p, f) {
    switch (type) {
      case 'queue.join': return this.queueJoin(conn, String(p.region || 'global').slice(0, 16));
      case 'queue.leave': return this.queueLeave(conn);
      case 'queue.fill_bots': return this.queueFillBots(conn);
      case 'room.create': return this.roomCreate(conn, p);
      case 'room.join': return this.roomJoin(conn, p);
      case 'room.leave': return this.roomLeave(conn);
      case 'room.invite': return this.roomInvite(conn, p);
      case 'room.ready': {
        const room = this.roomOf(conn);
        if (!room) return 'not_in_room';
        // Public rooms that aren't full only start with bots after the same wait as FILL WITH BOTS.
        if (!room.private && !room.isFull && room.state === 'lobby') return this.queueFillBots(conn);
        return room.requestStart(conn.playerId);
      }
      case 'friend.add': return this.friendAdd(conn, p);
      case 'friend.remove': return this.friendRemove(conn, p);
      case 'friend.list': return this.friendList(conn);
      case 'account.handle': {
        const h = String(p.handle || '').trim();
        if (!/^[A-Za-z0-9_ -]{2,20}$/.test(h)) return 'bad_handle';
        if (!this.store.setHandle(conn.playerId, h)) return 'handle_taken';
        conn.send('account', { playerId: conn.playerId, handle: h });
        const room = this.roomOf(conn);
        const m = room && room.member(conn.playerId);
        if (m) room.broadcast('room.player_joined', { slot: m.slot, playerId: m.playerId, handle: h, colour: m.colour, bot: m.bot, renamed: true });
        this.notifyFriends(conn.playerId);
        return null;
      }
      case 'leaderboard.get':
        conn.send('leaderboard', { rows: this.store.leaderboard(Math.min(100, Number(p.limit) || 20)) });
        return null;
      case 'ping':
        conn.send('pong', { t: f.t });
        return null;
    }

    // Everything else is gameplay and belongs to the room.
    const room = this.roomOf(conn);
    if (!room) return type.startsWith('presence.') ? null : 'not_in_room';
    const m = room.member(conn.playerId);
    if (!m) return 'not_in_room';
    if (isGameplay(type)) return room.handle(m, type, p);
    // Client-side telemetry the prototype emits (task.start, order.wrong, …):
    // accepted and ignored — the server computes its own verdicts.
    return null;
  }

  // ── rooms ───────────────────────────────────────────────
  newCode() {
    for (;;) {
      let s = 'TT-';
      for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(s)) return s;
    }
  }

  makeRoom(opts) {
    const code = this.newCode();
    const room = new Room(Object.assign({
      code, store: this.store, config: this.cfg.room, log: this.log,
      onEmpty: (r) => this.dropRoom(r),
    }, opts));
    this.rooms.set(code, room);
    return room;
  }

  dropRoom(room) {
    this.rooms.delete(room.code);
    for (const [region, r] of this.forming) if (r === room) this.forming.delete(region);
    for (const [pid, code] of this.playerRoom) if (code === room.code) this.playerRoom.delete(pid);
  }

  enter(conn, room) {
    const res = room.join(conn, conn.playerId);
    if (typeof res === 'string') return res;
    conn.roomId = room.code;
    this.playerRoom.set(conn.playerId, room.code);
    this.notifyFriends(conn.playerId);
    return null;
  }

  /** Leave whatever lobby this player is in before joining another. */
  exitCurrent(conn) {
    const room = this.roomOf(conn);
    if (!room) return null;
    if (room.state === 'play') return 'run_in_progress';
    room.leave(conn.playerId, true);
    this.playerRoom.delete(conn.playerId);
    conn.roomId = null;
    return null;
  }

  invite(code) { return this.cfg.publicUrl.replace(/\/$/, '') + '/join/' + code; }

  roomCreate(conn) {
    const err = this.exitCurrent(conn);
    if (err) return err;
    const room = this.makeRoom({ private: true });
    const e = this.enter(conn, room);
    if (e) return e;
    conn.send('room.created', { code: room.code, invite: this.invite(room.code) });
    return null;
  }

  roomJoin(conn, p) {
    let code = p.code ? String(p.code).toUpperCase().trim() : null;
    if (code && !code.startsWith('TT-')) code = 'TT-' + code;
    if (!code && p.friend) {
      const friend = this.store.findByHandle(p.friend);
      const me = this.store.getAccount(conn.playerId);
      if (!friend || me.friends.indexOf(friend.id) < 0) return 'not_friends';
      code = this.playerRoom.get(friend.id);
      if (!code) return 'friend_not_in_room';
    }
    if (!code) return 'bad_payload';
    const room = this.rooms.get(code);
    if (!room) return 'no_such_room';
    const seat = room.member(conn.playerId);
    if (seat) {
      if (seat.conn === conn) return null; // already seated (e.g. resumed on bind)
      conn.roomId = room.code;
      room.join(conn, conn.playerId);
      this.playerRoom.set(conn.playerId, room.code);
      return null;
    }
    const err = this.exitCurrent(conn);
    if (err) return err;
    return this.enter(conn, room);
  }

  roomLeave(conn) {
    const room = this.roomOf(conn);
    if (!room) return 'not_in_room';
    room.leave(conn.playerId, true);
    this.playerRoom.delete(conn.playerId);
    conn.roomId = null;
    this.notifyFriends(conn.playerId);
    conn.send('room.left', {});
    return null;
  }

  roomInvite(conn, p) {
    const room = this.roomOf(conn);
    if (!room) return 'not_in_room';
    const target = this.store.findByHandle(p.to);
    if (!target) return 'no_such_player';
    const tc = this.conns.get(target.id);
    if (!tc) return 'player_offline';
    const me = this.store.getAccount(conn.playerId);
    tc.send('room.invited', { code: room.code, invite: this.invite(room.code), from: conn.playerId, handle: me.handle });
    conn.send('room.invite_sent', { to: target.id });
    return null;
  }

  // ── random queue ────────────────────────────────────────
  queueJoin(conn, region) {
    const err = this.exitCurrent(conn);
    if (err) return err;
    let room = this.forming.get(region);
    if (!room || room.state !== 'lobby' || room.isFull) {
      room = this.makeRoom({ private: false, region });
      this.forming.set(region, room);
    }
    const e = this.enter(conn, room);
    if (e) return e;
    conn.send('queue.joined', { region, code: room.code, size: room.size, botsAfterMs: this.cfg.queueBotButtonMs });
    if (room.isFull) {
      this.forming.delete(region);
      room.start();
    }
    return null;
  }

  queueLeave(conn) {
    const room = this.roomOf(conn);
    if (!room || room.private) return 'not_queued';
    if (room.state !== 'lobby') return 'run_in_progress';
    room.leave(conn.playerId, true);
    this.playerRoom.delete(conn.playerId);
    conn.roomId = null;
    conn.send('queue.left', {});
    return null;
  }

  /** A waiting player asks for stand-ins. Allowed once they've waited queueBotButtonMs. */
  queueFillBots(conn) {
    const room = this.roomOf(conn);
    if (!room || room.private) return 'not_queued';
    if (room.state !== 'lobby') return 'run_in_progress';
    const m = room.member(conn.playerId);
    if (!m || Date.now() - m.joinedAt < this.cfg.queueBotButtonMs - 250) return 'too_early';
    for (const [region, r] of this.forming) if (r === room) this.forming.delete(region);
    while (!room.isFull) room.addBot();
    room.start();
    return null;
  }

  tickQueue() {
    const fill = this.cfg.queueBotFillMs;
    if (!fill) return;
    const t = Date.now();
    for (const [region, room] of this.forming) {
      if (room.state === 'lobby' && room.size > 0 && t - room.createdAt >= fill) {
        this.forming.delete(region);
        while (!room.isFull) room.addBot();
        room.start();
      }
    }
  }

  // ── friends ─────────────────────────────────────────────
  friendAdd(conn, p) {
    const other = this.store.findByHandle(p.handle || p.playerId);
    if (!other) return 'no_such_player';
    if (!this.store.addFriend(conn.playerId, other.id)) return 'bad_payload';
    this.friendList(conn);
    const oc = this.conns.get(other.id);
    if (oc) this.friendList(oc);
    return null;
  }

  friendRemove(conn, p) {
    const other = this.store.findByHandle(p.handle || p.playerId);
    if (!other) return 'no_such_player';
    this.store.removeFriend(conn.playerId, other.id);
    this.friendList(conn);
    return null;
  }

  friendList(conn) {
    const me = this.store.getAccount(conn.playerId);
    conn.send('friend.list', { friends: me.friends.map((id) => this.friendEntry(id)) });
    return null;
  }

  friendEntry(id) {
    const a = this.store.getAccount(id);
    const code = this.playerRoom.get(id) || null;
    const room = code && this.rooms.get(code);
    return {
      playerId: id, handle: a ? a.handle : id, online: this.conns.has(id),
      roomId: room && room.private ? code : null,
      joinable: !!(room && room.private && room.state === 'lobby' && !room.isFull),
    };
  }

  notifyFriends(playerId) {
    const me = this.store.getAccount(playerId);
    if (!me) return;
    const entry = this.friendEntry(playerId);
    for (const fid of me.friends) {
      const c = this.conns.get(fid);
      if (c) c.send('friend.presence', entry);
    }
  }

  // ── http helpers ────────────────────────────────────────
  roomInfo(code) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) return null;
    return { code: room.code, private: room.private, state: room.state, size: room.size, roster: room.rosterPayload() };
  }

  stats() {
    return { connections: this.conns.size, rooms: this.rooms.size, playing: [...this.rooms.values()].filter((r) => r.state === 'play').length };
  }

  close() {
    clearInterval(this.queueTimer);
    for (const room of this.rooms.values()) room.stopTimer();
  }
}

const GAMEPLAY = new Set([
  'presence.move', 'presence.tap',
  'task.submit', 'slide.lock', 'gate.collision',
  'coop.claim', 'coop.hold', 'coop.vent', 'coop.tap', 'coop.relay_pass',
]);
function isGameplay(type) { return GAMEPLAY.has(type); }

module.exports = { Hub, Conn, PROTOCOL_VERSION };
