'use strict';
/* A 4-player room: roster, lobby, and the authoritative run.
 *
 * The room owns life meters, the drain curve, task assignment + grading,
 * partner credit, co-op boards, and run-end detection. Clients only send
 * inputs (answers, taps, holds); every life change originates here.
 */
const Tasks = require('../shared/tasks');
const bots = require('./bots');

const SLOT_COLOURS = { 1: '#C6C2B6', 2: '#5FC98A', 3: '#D9A24B', 4: '#4FC0D0' };
const SIZE = 4;

const DEFAULTS = {
  tickMs: 100,
  syncMs: 250,             // life.sync cadence
  coopSyncMs: 100,         // coop.state cadence for hold/relay (10 Hz)
  relayGraceMs: 250,       // a relay tap this late still counts — covers the round trip
  firstRoundDelayMs: 1000,
  soloPhaseMs: 30000,      // solo minigames rotate freely until this cutoff…
  cutoffGraceMs: 4000,     // …then in-flight tasks get this long to finish
  soloNextMs: 400,         // verdict flash before a player's next minigame
  coopIntroMs: 2500,       // "co-op incoming" card between the solo phase ending and co-op starting
  coopWinGapMs: 2000,
  coopFailGapMs: 1800,
  latencyGraceMs: 400,     // added to every deadline
  pauseGraceMs: 8000,      // how long a dropped player's slot waits before a bot takes it
  presenceMinMs: 35,       // ~20 Hz with jitter headroom; faster frames are dropped
  tapMinMs: 80,            // taps are discrete; cap at ~12/s
  presenceMaxBuffered: 32 * 1024,
  allowBots: true,
  drainGrowth: 1.65,       // passive drain ×1.65 per minute after the first 30 s (was 1.5)
};

const SOLO_CREDIT = { ok: 9, fail: -13 };
const BOT_CREDIT = { ok: 7, fail: -11 };
const COOP_BONUS = 16;
const COOP_PENALTY = 14;

/** Passive drain in points/sec/player after `ms` of play: flat for the first half
 * minute, then compounding by `growth` each minute. Prototype used growth 1.5. */
const DRAIN = { base: 0.42, growth: 1.65, graceMin: 0.5 };
function decayAt(ms, growth = DRAIN.growth) {
  const minutes = ms / 60000;
  return DRAIN.base * Math.pow(growth, Math.max(0, minutes - DRAIN.graceMin));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;

class Room {
  constructor(opts) {
    this.code = opts.code;
    this.private = !!opts.private;
    this.region = opts.region || null;
    this.store = opts.store || null;
    this.now = opts.now || Date.now;
    this.random = opts.random || Math.random;
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.onEmpty = opts.onEmpty || (() => {});
    this.log = opts.log || (() => {});
    this.members = []; // { slot, playerId, colour, bot, conn, leftAt, lastPresence }
    this.hostId = null;
    this.state = 'lobby';
    this.createdAt = this.now();
    this.run = null;
    this.timer = null;
  }

  // ── roster ──────────────────────────────────────────────
  get size() { return this.members.length; }
  get humans() { return this.members.filter((m) => !m.bot); }
  get isFull() { return this.members.length >= SIZE; }
  member(playerId) { return this.members.find((m) => m.playerId === playerId) || null; }
  seatOf(m) { return m.slot - 1; }
  memberAtSeat(seat) { return this.members.find((m) => m.slot === seat + 1) || null; }

  handleOf(playerId) {
    const acct = this.store && this.store.getAccount(playerId);
    return acct ? acct.handle : playerId.startsWith('bot-') ? 'BOT' : playerId;
  }

  rosterPayload() {
    return this.members
      .slice().sort((a, b) => a.slot - b.slot)
      .map((m) => ({ slot: m.slot, playerId: m.playerId, handle: this.handleOf(m.playerId), colour: m.colour, bot: m.bot, online: m.bot || !!m.conn, host: m.playerId === this.hostId }));
  }

  freeSlot() {
    for (let s = 1; s <= SIZE; s++) if (!this.members.some((m) => m.slot === s)) return s;
    return 0;
  }

  /** Add a player or reattach a returning one. Returns the member or an error string. */
  join(conn, playerId) {
    const existing = this.member(playerId);
    if (existing) return this.reattach(existing, conn);
    if (this.state !== 'lobby') return 'run_in_progress';
    const slot = this.freeSlot();
    if (!slot) return 'room_full';
    const m = { slot, playerId, colour: SLOT_COLOURS[slot], bot: false, conn, leftAt: 0, lastPresence: 0, synthetic: false, joinedAt: this.now() };
    this.members.push(m);
    if (!this.hostId) this.hostId = playerId;
    this.sendTo(m, 'room.joined', this.joinedPayload(m));
    this.broadcast('room.player_joined', { slot, playerId, handle: this.handleOf(m.playerId), colour: m.colour, bot: false }, { except: m });
    return m;
  }

  addBot() {
    const slot = this.freeSlot();
    if (!slot) return null;
    const m = { slot, playerId: 'bot-' + this.code + '-' + slot, colour: SLOT_COLOURS[slot], bot: true, conn: null, leftAt: 0, lastPresence: 0, synthetic: true };
    this.members.push(m);
    this.broadcast('room.player_joined', { slot, playerId: m.playerId, handle: this.handleOf(m.playerId), colour: m.colour, bot: true });
    return m;
  }

  joinedPayload(m) {
    return {
      code: this.code, private: this.private, slot: m.slot, colour: m.colour,
      host: this.hostId, state: this.state, roster: this.rosterPayload(),
    };
  }

  reattach(m, conn) {
    m.conn = conn;
    m.leftAt = 0;
    const wasBot = m.bot && !m.synthetic;
    if (m.bot && !m.synthetic) m.bot = false; // take control back from the stand-in bot
    this.sendTo(m, 'room.joined', this.joinedPayload(m));
    this.broadcast('room.player_joined', { slot: m.slot, playerId: m.playerId, handle: this.handleOf(m.playerId), colour: m.colour, bot: false, rejoined: true }, { except: m });
    if (this.state === 'play') {
      this.sendSnapshot(m);
      if (wasBot) this.log('seat.reclaimed', { room: this.code, playerId: m.playerId });
      if (this.run.pausedAt && !this.members.some((x) => !x.bot && !x.conn)) this.resume();
    }
    return m;
  }

  /** Connection dropped or player left. `voluntary` = explicit leave. */
  leave(playerId, voluntary) {
    const m = this.member(playerId);
    if (!m) return;
    if (this.state === 'play' && !voluntary) {
      m.conn = null;
      m.leftAt = this.now();
      this.broadcast('room.player_left', { slot: m.slot, playerId: m.playerId, graceMs: this.cfg.pauseGraceMs });
      if (!this.run.pausedAt) this.pause();
      return;
    }
    if (this.state === 'play') {
      // Voluntary mid-run leave: a bot takes the seat immediately.
      m.conn = null;
      m.bot = true;
      this.broadcast('room.player_left', { slot: m.slot, playerId: m.playerId, graceMs: 0 });
      this.broadcast('room.player_joined', { slot: m.slot, playerId: m.playerId, handle: this.handleOf(m.playerId), colour: m.colour, bot: true });
      this.checkAbandoned();
      return;
    }
    this.members = this.members.filter((x) => x !== m);
    this.broadcast('room.player_left', { slot: m.slot, playerId: m.playerId });
    if (this.hostId === playerId) {
      const next = this.humans[0];
      this.hostId = next ? next.playerId : null;
      if (next) this.broadcast('room.host', { playerId: next.playerId, slot: next.slot });
    }
    if (!this.humans.length) this.destroy();
  }

  checkAbandoned() {
    if (this.state === 'play' && !this.members.some((m) => !m.bot)) {
      this.endRun('abandoned');
    }
  }

  destroy() {
    this.stopTimer();
    this.state = 'closed';
    this.onEmpty(this);
  }

  // ── transport ───────────────────────────────────────────
  sendTo(m, type, payload, from) {
    if (m && m.conn) m.conn.send(type, payload, { roomId: this.code, from });
  }

  broadcast(type, payload, opts) {
    const except = opts && opts.except;
    for (const m of this.members) if (m !== except) this.sendTo(m, type, payload, opts && opts.from);
  }

  // ── lifecycle ───────────────────────────────────────────
  /** Host asks to start. Private rooms fill empty seats with bots. */
  requestStart(playerId) {
    if (this.state !== 'lobby') return 'not_in_lobby';
    if (playerId && playerId !== this.hostId) return 'not_host';
    if (!this.isFull) {
      if (!this.cfg.allowBots) return 'room_not_full';
      while (!this.isFull) this.addBot();
    }
    this.start();
    return null;
  }

  start() {
    const t = this.now();
    const seed = Math.floor(this.random() * 0x100000000) >>> 0;
    const rng = Tasks.makeRng(seed);
    const ids = this.members.slice().sort((a, b) => a.slot - b.slot).map((m) => m.playerId);
    // Partner ring (who credits whom), rotated per run.
    const ring = rng.shuffle(ids);
    const partnerMap = {};
    ring.forEach((id, i) => { partnerMap[id] = ring[(i + 1) % ring.length]; });
    const life = {}, gave = {}, cost = {}, scores = {};
    for (const id of ids) {
      life[id] = 66 + rng.int(25); // ~66–90
      gave[id] = 0; cost[id] = 0;
      scores[id] = { memory: { n: 0, ok: 0 }, concentration: { n: 0, ok: 0 }, spatial: { n: 0, ok: 0 }, multitasking: { n: 0, ok: 0 } };
    }
    this.state = 'play';
    this.run = {
      seed, partnerMap, life, gave, cost, scores,
      startedAt: t, runStart: t + this.cfg.firstRoundDelayMs,
      lastTick: t, lastSync: 0, lastCoopSync: 0,
      pausedAt: 0, pausedTotal: 0,
      phaseNo: 0, taskSeq: 0, nextIsCoop: false,
      count: Object.fromEntries(ids.map((id) => [id, 0])),
      soloIndex: Object.fromEntries(ids.map((id) => [id, 0])),
      round: null, nextRoundAt: t + this.cfg.firstRoundDelayMs,
      tasksCleared: 0,
    };
    this.broadcast('room.ready', {
      size: SIZE, seed, partnerMap, roster: this.rosterPayload(),
      life: this.lifePayload(), startsAt: this.run.runStart,
    });
    this.startTimer();
  }

  startTimer() {
    this.stopTimer();
    if (this.cfg.manualTick) return; // tests drive tick() with a fake clock
    this.timer = setInterval(() => {
      try { this.tick(); } catch (err) { console.error('[room ' + this.code + '] tick failed', err); }
    }, this.cfg.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  pause() {
    this.run.pausedAt = this.now();
    this.broadcast('room.paused', { at: this.run.pausedAt, graceMs: this.cfg.pauseGraceMs });
  }

  resume() {
    const run = this.run;
    const shift = this.now() - run.pausedAt;
    run.pausedAt = 0;
    run.pausedTotal += shift;
    run.runStart += shift;
    run.nextRoundAt += shift;
    run.lastTick = this.now();
    const rd = run.round;
    if (rd && rd.coop) {
      rd.deadline += shift;
      shiftCoop(rd, shift);
    } else if (rd) {
      rd.cutoffAt += shift;
      rd.graceEndsAt += shift;
      for (const tk of Object.values(rd.tasks)) {
        tk.assignedAt += shift; tk.deadline += shift;
        if (tk.botAt) tk.botAt += shift;
        if (tk.nextAt) tk.nextAt += shift;
      }
    }
    this.broadcast('room.resumed', { pausedMs: shift });
    for (const m of this.members) this.sendSnapshot(m);
  }

  /** Everything a (re)connecting client needs to render the current run. */
  sendSnapshot(m) {
    if (!m.conn || !this.run) return;
    const run = this.run;
    this.sendTo(m, 'room.ready', {
      size: SIZE, seed: run.seed, partnerMap: run.partnerMap, roster: this.rosterPayload(),
      life: this.lifePayload(), startsAt: run.runStart, resumed: true,
    });
    this.sendTo(m, 'life.sync', { life: this.lifePayload(), decay: r2(this.decay()) });
    const rd = run.round;
    if (!rd) {
      if (run.pendingCoop) this.sendTo(m, 'phase.solo_end', this.soloEndPayload());
      return;
    }
    if (rd.coop) {
      this.sendTo(m, 'task.assign', this.coopAssignPayload(rd));
      this.sendTo(m, 'coop.state', this.coopStatePayload(rd));
    } else {
      this.sendTo(m, 'phase.solo', this.phasePayload(rd));
      if (rd.cut) this.sendTo(m, 'phase.cutoff', this.phasePayload(rd));
      const tk = rd.tasks[m.playerId];
      if (tk && !tk.result) this.sendTo(m, 'task.assign', this.assignPayload(tk, rd));
      else if (rd.cut) this.sendTo(m, 'phase.waiting', { n: rd.n, until: rd.graceEndsAt });
    }
  }

  // ── the run ─────────────────────────────────────────────
  elapsed() { return Math.max(0, this.now() - this.run.runStart); }
  decay() { return decayAt(this.elapsed(), this.cfg.drainGrowth); }

  lifePayload() {
    const out = {};
    for (const [id, v] of Object.entries(this.run.life)) out[id] = r2(v);
    return out;
  }

  tick() {
    if (this.state !== 'play') return;
    const run = this.run;
    const t = this.now();

    if (run.pausedAt) {
      // Seats whose owner didn't come back within grace are handed to a bot.
      let changed = false;
      for (const m of this.members) {
        if (!m.bot && !m.conn && t - m.leftAt >= this.cfg.pauseGraceMs) {
          m.bot = true;
          changed = true;
          this.broadcast('room.player_joined', { slot: m.slot, playerId: m.playerId, handle: this.handleOf(m.playerId), colour: m.colour, bot: true });
        }
      }
      if (!this.members.some((m) => !m.bot)) return this.endRun('abandoned');
      if (changed && !this.members.some((m) => !m.bot && !m.conn)) this.resume();
      return;
    }

    const dt = Math.min(250, t - run.lastTick) / 1000;
    run.lastTick = t;
    if (t < run.runStart) return;

    // Continuous drain.
    const perSec = this.decay();
    for (const id of Object.keys(run.life)) run.life[id] = clamp(run.life[id] - perSec * dt, 0, 100);
    if (this.checkDeath()) return;

    // Round flow.
    if (!run.round && t >= run.nextRoundAt) this.nextRound();
    const rd = run.round;
    if (rd && !rd.coop) this.tickSolo(rd, t);
    else if (rd && rd.coop) this.tickCoop(rd, t, dt);
    if (this.state !== 'play') return;

    if (t - run.lastSync >= this.cfg.syncMs) {
      run.lastSync = t;
      this.broadcast('life.sync', { life: this.lifePayload(), decay: r2(perSec) });
    }
  }

  checkDeath() {
    const run = this.run;
    const dead = Object.keys(run.life).find((id) => run.life[id] <= 0);
    if (dead) { this.endRun(dead + '_depleted', dead); return true; }
    return false;
  }

  /** Apply `amount` to `target`'s life, attributing it to `actor` for gave/cost. */
  applyLife(target, amount, actor) {
    const run = this.run;
    run.life[target] = clamp(run.life[target] + amount, 0, 100);
    const who = actor || target;
    if (amount > 0) run.gave[who] += amount; else run.cost[who] += -amount;
  }

  /** Immediate self-penalty (wrong tap, collision…). */
  penalise(m, amount, reason) {
    this.applyLife(m.playerId, -amount, m.playerId);
    this.broadcast('life.penalty', { playerId: m.playerId, slot: m.slot, amount: -amount, reason });
    this.broadcast('life.sync', { life: this.lifePayload(), decay: r2(this.decay()) });
    this.checkDeath();
  }

  taskSeed(id, seat) {
    const mix = (this.run.seed ^ Math.imul(id, 0x9e3779b1) ^ Math.imul(seat + 1, 0x85ebca77)) >>> 0;
    return Tasks.makeRng(mix).int(0x100000000) >>> 0;
  }

  /** Solo phases and co-op rounds alternate: solo → coop → solo → … */
  nextRound() {
    if (this.run.nextIsCoop) this.startCoop();
    else this.startSolo();
  }

  // ── solo phase ──────────────────────────────────────────
  // Every player rotates through minigames at their own pace until the
  // cutoff. After it, in-flight tasks get up to `cutoffGraceMs` to finish;
  // anyone done waits. The phase ends when all are done or grace runs out.

  startSolo() {
    const run = this.run;
    const t = this.now();
    const rd = {
      coop: false, n: ++run.phaseNo, startedAt: t,
      cutoffAt: t + this.cfg.soloPhaseMs,
      graceEndsAt: t + this.cfg.soloPhaseMs + this.cfg.cutoffGraceMs,
      cut: false, tasks: {},
    };
    run.round = rd;
    this.broadcast('phase.solo', this.phasePayload(rd));
    for (const m of this.members) this.assignSolo(rd, m, t);
  }

  phasePayload(rd) {
    return { n: rd.n, startedAt: rd.startedAt, cutoffAt: rd.cutoffAt, graceEndsAt: rd.graceEndsAt, graceMs: this.cfg.cutoffGraceMs };
  }

  assignSolo(rd, m, t) {
    const run = this.run;
    const pid = m.playerId;
    const id = ++run.taskSeq;
    const count = ++run.count[pid];                 // this player's task number (solo + co-op)
    const kind = Tasks.SOLO_KINDS[run.soloIndex[pid]++ % Tasks.SOLO_KINDS.length];
    const level = Tasks.levelFor(count);
    const seed = this.taskSeed(id, this.seatOf(m));
    const board = Tasks.generate(kind, seed, level);
    const tk = {
      id, playerId: pid, kind, seed, level, board,
      progress: Tasks.createProgress(board),
      assignedAt: t,
      deadline: t + board.showMs + board.answerMs + this.cfg.latencyGraceMs,
      result: null, nextAt: 0,
    };
    rd.tasks[pid] = tk;
    this.sendTo(m, 'task.assign', this.assignPayload(tk, rd));
  }

  assignPayload(tk, rd) {
    return {
      id: tk.id, kind: tk.kind, seed: tk.seed, level: tk.level,
      deadline: tk.deadline, assignedAt: tk.assignedAt,
      showMs: tk.board.showMs, answerMs: tk.board.answerMs,
      cutoffAt: rd ? rd.cutoffAt : null, cut: !!(rd && rd.cut),
    };
  }

  coopAssignPayload(rd) {
    return {
      id: rd.id, kind: 'COOP', variant: rd.variant, seed: rd.seed, level: rd.level,
      deadline: rd.deadline, assignedAt: rd.startedAt,
    };
  }

  tickSolo(rd, t) {
    if (!rd.cut && t >= rd.cutoffAt) this.cutoff(rd);
    for (const m of this.members) {
      const tk = rd.tasks[m.playerId];
      if (tk && !tk.result) {
        if (m.bot) {
          if (!tk.botAt) Object.assign(tk, bots.planSolo(tk, this.random));
          if (t >= tk.botAt) this.resolveTask(tk, tk.botOk, 'bot');
        }
        if (!tk.result && t >= tk.deadline) this.resolveTask(tk, false, 'timeout');
        if (this.state !== 'play') return;
      }
      // Straight on to the next minigame — no waiting for the others.
      if (!rd.cut && (!tk || (tk.result && t >= tk.nextAt))) this.assignSolo(rd, m, t);
    }
    if (rd.cut && Object.values(rd.tasks).every((tk) => tk.result)) this.endSolo(rd);
  }

  cutoff(rd) {
    rd.cut = true;
    this.broadcast('phase.cutoff', this.phasePayload(rd));
    for (const m of this.members) {
      const tk = rd.tasks[m.playerId];
      if (!tk) continue;
      if (tk.result) {
        this.sendTo(m, 'phase.waiting', { n: rd.n, until: rd.graceEndsAt });
      } else if (tk.deadline > rd.graceEndsAt) {
        tk.deadline = rd.graceEndsAt;
        this.sendTo(m, 'task.assign', this.assignPayload(tk, rd)); // same id, shortened deadline
      }
    }
  }

  endSolo(rd) {
    const run = this.run;
    run.round = null;
    run.nextIsCoop = true;
    run.nextRoundAt = this.now() + this.cfg.coopIntroMs;
    run.pendingCoop = this.planCoop(); // picked now so the intro card can name it
    run.pendingCoop.n = rd.n;
    this.broadcast('phase.solo_end', this.soloEndPayload());
  }

  soloEndPayload() {
    const p = this.run.pendingCoop;
    return { n: p.n, coopAt: this.run.nextRoundAt, variant: p.variant };
  }

  /** Grade → credit the partner immediately → next task (or wait, after cutoff). */
  resolveTask(tk, ok, reason) {
    const run = this.run;
    const rd = run.round;
    const m = this.member(tk.playerId);
    const bot = !!(m && m.bot);
    tk.result = { ok, reason: reason || null, at: this.now(), bot };
    tk.nextAt = this.now() + this.cfg.soloNextMs;
    this.sendTo(m, 'task.result', { id: tk.id, kind: tk.kind, ok, reason: reason || null });
    this.broadcast('presence.tap', { playerId: tk.playerId, slot: m ? m.slot : 0, ok, system: true }, { except: m, from: tk.playerId });

    const table = bot ? BOT_CREDIT : SOLO_CREDIT;
    const amount = ok ? table.ok : table.fail;
    const target = run.partnerMap[tk.playerId];
    this.applyLife(target, amount, tk.playerId);
    const cat = Tasks.CATEGORY[tk.kind];
    run.scores[tk.playerId][cat].n += 1;
    if (ok) { run.scores[tk.playerId][cat].ok += 1; run.tasksCleared += 1; }
    this.broadcast('round.settle', {
      id: tk.id, playerId: tk.playerId, kind: tk.kind,
      deltas: { [target]: amount }, results: { [tk.playerId]: { ok, to: target, amount } },
    });
    this.broadcast('life.sync', { life: this.lifePayload(), decay: r2(this.decay()) });
    if (rd && rd.cut) this.sendTo(m, 'phase.waiting', { n: rd.n, until: rd.graceEndsAt });
    this.checkDeath();
  }

  // ── co-op round ─────────────────────────────────────────
  /** Reserve the next co-op round's id, seed and variant. */
  planCoop() {
    const id = ++this.run.taskSeq;
    const seed = this.taskSeed(id, 99);
    const variant = this.cfg.coopVariant || Tasks.COOP_VARIANTS[Tasks.makeRng(seed).int(Tasks.COOP_VARIANTS.length)];
    return { id, seed, variant };
  }

  startCoop() {
    const run = this.run;
    const t = this.now();
    const { id, seed, variant } = run.pendingCoop || this.planCoop();
    run.pendingCoop = null;
    const counts = this.members.map((m) => ++run.count[m.playerId]);
    const level = Tasks.levelFor(Math.round(counts.reduce((a, b) => a + b, 0) / counts.length));
    const board = Tasks.generateCoop(variant, seed, level);
    const rd = {
      id, n: run.phaseNo, level, coop: true, variant, seed, board,
      startedAt: t, deadline: t + board.durationMs + this.cfg.latencyGraceMs, done: false,
    };
    initCoop(rd, this, t);
    run.round = rd;
    this.broadcast('task.assign', this.coopAssignPayload(rd));
    this.broadcast('coop.state', this.coopStatePayload(rd));
  }

  // ── inputs ──────────────────────────────────────────────
  handle(m, type, payload) {
    if (type === 'presence.move' || type === 'presence.tap') return this.presence(m, type, payload);
    if (this.state !== 'play' || !this.run || this.run.pausedAt) return 'not_playing';
    const rd = this.run.round;
    if (!rd) return 'no_task';
    if (rd.coop) return this.handleCoop(rd, m, type, payload || {});

    const tk = rd.tasks[m.playerId];
    if (!tk || tk.result) return 'no_task';
    if (payload && payload.id != null && payload.id !== tk.id) return 'stale_task';
    const action = type === 'task.submit' ? 'submit'
      : type === 'slide.lock' ? 'lock'
      : type === 'gate.collision' ? 'collision'
      : null;
    if (!action) return 'unknown_action';
    const t = this.now();
    if (t > tk.deadline) { this.resolveTask(tk, false, 'timeout'); return 'too_late'; }
    const res = Tasks.step(tk.progress, action, payload, t - tk.assignedAt - tk.board.showMs);
    if (!res) return 'bad_payload';
    if (res.penalty) this.penalise(m, res.penalty, res.reason);
    if (this.state !== 'play') return null;
    if (res.progress) this.sendTo(m, 'task.progress', Object.assign({ id: tk.id }, res.progress));
    if (res.done) this.resolveTask(tk, res.ok, res.reason);
    return null;
  }

  presence(m, type, payload) {
    const p = payload || {};
    const x = Number(p.x), y = Number(p.y);
    if (!isFinite(x) || !isFinite(y)) return 'bad_payload';
    const t = this.now();
    if (type === 'presence.move') {
      if (t - m.lastPresence < this.cfg.presenceMinMs) return null; // drop, don't queue
      m.lastPresence = t;
    } else {
      if (t - (m.lastTap || 0) < this.cfg.tapMinMs) return null;
      m.lastTap = t;
    }
    const out = { playerId: m.playerId, slot: m.slot, x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    if (type === 'presence.tap') out.ok = p.ok !== false;
    for (const peer of this.members) {
      if (peer === m || !peer.conn) continue;
      if (peer.conn.buffered() > this.cfg.presenceMaxBuffered) continue; // late cursor < no cursor
      this.sendTo(peer, type, out, m.playerId);
    }
    return null;
  }

  // ── co-op ───────────────────────────────────────────────
  handleCoop(rd, m, type, p) {
    if (rd.done) return 'no_task';
    const seat = this.seatOf(m);
    const t = this.now();
    if (rd.variant === 'tokens') {
      if (type !== 'coop.claim') return 'unknown_action';
      return this.claimToken(rd, m, Number(p.n));
    }
    if (rd.variant === 'hold') {
      if (type !== 'coop.hold') return 'unknown_action';
      const s = rd.st;
      const down = p.down !== false;
      if (down && (s.broken[seat] || s.grip[seat] <= 0)) return 'grip_broken';
      s.holding[seat] = down;
      this.syncCoop(rd, true);
      return null;
    }
    if (rd.variant === 'relay') {
      const s = rd.st;
      if (type === 'coop.vent') {
        if (s.armed && rd.board.order[s.hop % 4] === seat) return 'your_turn';
        if (t < s.ventUntil) return 'cooldown';
        s.ventUntil = t + rd.board.ventMs;
        s.ventLock[seat] = s.ventUntil; // venting ties up the venter's own hands, nobody else's
        s.ventBy = m.playerId;
        this.syncCoop(rd, true);
        return null;
      }
      if (type === 'coop.tap' || type === 'coop.relay_pass') return this.relayTap(rd, m, seat, t);
      return 'unknown_action';
    }
    return 'unknown_action';
  }

  claimToken(rd, m, n) {
    const s = rd.st;
    const tok = rd.board.tokens[n - 1];
    if (!tok || s.done[n - 1]) return 'bad_token';
    const seat = this.seatOf(m);
    if (tok.owner !== seat) { this.penalise(m, rd.board.wrongPenalty, 'coop.wrong_owner'); return null; }
    if (n !== s.next) { this.penalise(m, rd.board.wrongPenalty, 'coop.out_of_order'); return null; }
    s.done[n - 1] = true;
    s.next += 1;
    this.broadcast('presence.tap', { playerId: m.playerId, slot: m.slot, ok: true, token: n, system: true }, { from: m.playerId });
    this.syncCoop(rd, true);
    if (s.next > 12) this.coopSolved(rd);
    return null;
  }

  relayTap(rd, m, seat, t) {
    const s = rd.st;
    if (t < s.ventLock[seat]) return 'venting';
    const current = rd.board.order[s.hop % 4];
    if (current !== seat || !s.armed) {
      s.heat = Math.min(100, s.heat + 9);
      this.penalise(m, rd.board.earlyPenalty, 'coop.relay_early');
      this.syncCoop(rd, true);
      return null;
    }
    this.relayAdvance(rd, true, m);
    return null;
  }

  relayAdvance(rd, caught, by) {
    const s = rd.st;
    const t = this.now();
    if (by) this.broadcast('presence.tap', { playerId: by.playerId, slot: by.slot, ok: caught, system: true }, { from: by.playerId });
    s.hop += 1;
    if (s.hop >= rd.board.hops) return this.coopSolved(rd);
    s.window = caught ? Math.max(450, s.window * 0.9) : s.window;
    const gap = caught ? Math.max(90, (300 - s.hop * 14) + this.random() * 260) : 320 + this.random() * 400;
    s.heat = Math.min(100, s.heat + (caught ? 7 : 3));
    s.armed = false;
    s.at = t + gap;
    s.botTapAt = 0;
    this.syncCoop(rd, true);
  }

  tickCoop(rd, t, dt) {
    if (rd.done) {
      if (t >= rd.nextAt) { this.run.round = null; this.run.nextRoundAt = t; }
      return;
    }
    const k = (dt * 1000) / 100; // prototype constants are per 100 ms tick
    const s = rd.st;

    if (rd.variant === 'tokens') {
      bots.tokens(this, rd, t);
    } else if (rd.variant === 'hold') {
      bots.hold(this, rd, t);
      const b = rd.board;
      for (let seat = 0; seat < SIZE; seat++) {
        const m = this.memberAtSeat(seat);
        if (s.holding[seat]) {
          s.grip[seat] -= b.gripDrain * k;
          if (s.grip[seat] <= 0) {
            s.grip[seat] = 0; s.broken[seat] = true; s.holding[seat] = false;
            if (m) this.penalise(m, b.gripPenalty, 'coop.grip_lost');
            if (this.state !== 'play') return;
          }
        } else {
          s.grip[seat] = Math.min(100, s.grip[seat] + b.gripRecover * k);
          if (s.broken[seat] && s.grip[seat] > b.gripRearm) s.broken[seat] = false;
        }
      }
      const all = s.holding.every(Boolean);
      s.charge = clamp(s.charge + (all ? b.chargeUp : -b.chargeDown) * k, 0, b.need);
      if (s.charge >= b.need) return this.coopSolved(rd);
    } else if (rd.variant === 'relay') {
      const b = rd.board;
      const venting = t < s.ventUntil;
      s.heat = clamp(s.heat + (venting ? -4.2 : 1.1 + s.hop * 0.12) * k, 0, 100);
      if (s.heat >= 100 && t >= s.overheatUntil) {
        s.heat = 42;
        s.overheatUntil = t + 900;
        for (const m of this.members) this.applyLife(m.playerId, -b.overheatPenalty, m.playerId);
        this.broadcast('coop.overheat', { penalty: b.overheatPenalty });
        this.broadcast('life.sync', { life: this.lifePayload(), decay: r2(this.decay()) });
        if (this.checkDeath()) return;
      }
      bots.relay(this, rd, t);
      if (rd.done || this.state !== 'play') return;
      if (t >= s.at + (s.armed ? this.cfg.relayGraceMs : 0)) {
        if (!s.armed) {
          s.armed = true;
          s.at = t + s.window;
          this.syncCoop(rd, true);
        } else {
          const seat = b.order[s.hop % 4];
          const m = this.memberAtSeat(seat);
          if (m) this.penalise(m, b.missPenalty, 'coop.relay_missed');
          if (this.state !== 'play') return;
          this.relayAdvance(rd, false, m);
          if (rd.done) return;
        }
      }
    }

    if (t >= rd.deadline) return this.coopExpired(rd);
    this.syncCoop(rd, false);
  }

  syncCoop(rd, force) {
    const t = this.now();
    if (!force && t - this.run.lastCoopSync < this.cfg.coopSyncMs) return;
    if (!force && rd.variant === 'tokens') return; // token board only changes on claims
    this.run.lastCoopSync = t;
    this.broadcast('coop.state', this.coopStatePayload(rd));
  }

  coopStatePayload(rd) {
    const s = rd.st;
    const base = { id: rd.id, variant: rd.variant, deadline: rd.deadline, done: rd.done };
    if (rd.variant === 'tokens') {
      return Object.assign(base, {
        tokens: rd.board.tokens.map((tk, i) => ({ n: tk.n, owner: tk.owner, done: s.done[i] })),
        next: s.next,
      });
    }
    if (rd.variant === 'hold') {
      return Object.assign(base, {
        holding: s.holding.slice(), grip: s.grip.map(Math.round), broken: s.broken.slice(),
        charge: Math.round(s.charge), need: rd.board.need,
      });
    }
    const seat = rd.board.order[s.hop % 4];
    return Object.assign(base, {
      order: rd.board.order, hop: s.hop, hops: rd.board.hops,
      turn: seat, armed: s.armed, windowMs: Math.round(s.window),
      closesAt: s.armed ? Math.round(s.at) : null,
      heat: Math.round(s.heat), venting: this.now() < s.ventUntil, ventUntil: s.ventUntil,
      ventLock: s.ventLock.slice(),
    });
  }

  coopSolved(rd) {
    this.finishCoop(rd, true);
  }

  coopExpired(rd) {
    this.finishCoop(rd, false);
  }

  finishCoop(rd, ok) {
    if (rd.done) return;
    const run = this.run;
    rd.done = true;
    const amount = ok ? COOP_BONUS : -COOP_PENALTY;
    const deltas = {};
    for (const m of this.members) {
      this.applyLife(m.playerId, amount, m.playerId);
      deltas[m.playerId] = amount;
      run.scores[m.playerId].multitasking.n += 1;
      if (ok) run.scores[m.playerId].multitasking.ok += 1;
    }
    if (ok) run.tasksCleared += 1;
    rd.nextAt = this.now() + (ok ? this.cfg.coopWinGapMs : this.cfg.coopFailGapMs);
    run.nextIsCoop = false;
    this.broadcast('coop.state', this.coopStatePayload(rd));
    if (ok) this.broadcast('coop.solved', { id: rd.id, variant: rd.variant, bonus: COOP_BONUS });
    else this.broadcast('coop.expired', { id: rd.id, variant: rd.variant, penalty: COOP_PENALTY });
    this.broadcast('round.settle', { id: rd.id, n: rd.n, kind: 'COOP', variant: rd.variant, deltas });
    this.broadcast('life.sync', { life: this.lifePayload(), decay: r2(this.decay()) });
    this.checkDeath();
  }

  // ── end ─────────────────────────────────────────────────
  endRun(cause, deadId) {
    if (this.state !== 'play') return;
    const run = this.run;
    const t = this.now();
    this.stopTimer();
    this.state = 'ended';
    const teamTime = Math.max(0, (run.pausedAt || t) - run.runStart);
    const standings = this.members
      .map((m) => ({
        slot: m.slot, playerId: m.playerId, bot: m.bot,
        gave: r2(run.gave[m.playerId]), cost: r2(run.cost[m.playerId]),
        finalLife: r2(run.life[m.playerId]), scores: run.scores[m.playerId],
      }))
      .sort((a, b) => b.finalLife - a.finalLife);
    this.broadcast('run.ended', { cause, depleted: deadId || null, standings, teamTime, tasksCleared: run.tasksCleared });
    this.log('run.ended', { room: this.code, cause, teamTime });
    if (this.store && this.members.some((m) => !m.synthetic)) {
      this.store.recordRun({
        roomId: this.code, private: this.private, seed: run.seed,
        started: run.runStart, ended: t, teamTime, tasksCleared: run.tasksCleared, cause,
        players: standings.map((s) => ({ playerId: s.playerId, bot: s.bot, gave: s.gave, cost: s.cost, finalLife: s.finalLife })),
      });
    }
    // Back to the lobby: drop bots and anyone who is gone; the host can go again.
    this.members = this.members.filter((m) => !m.synthetic && m.conn);
    for (const m of this.members) m.bot = false;
    this.state = 'lobby';
    if (!this.members.length) return this.destroy();
    if (!this.member(this.hostId)) this.hostId = this.members[0].playerId;
    this.broadcast('room.lobby', { code: this.code, host: this.hostId, roster: this.rosterPayload() });
  }
}

// ── co-op state helpers ───────────────────────────────────
function initCoop(rd, room, t) {
  if (rd.variant === 'tokens') {
    rd.st = { done: new Array(12).fill(false), next: 1, botNextAt: t + 850 };
  } else if (rd.variant === 'hold') {
    rd.st = {
      holding: [false, false, false, false], grip: [100, 100, 100, 100],
      broken: [false, false, false, false], charge: 0, botPlan: [0, 0, 0, 0],
    };
  } else {
    rd.st = {
      hop: 0, armed: false, at: t + 900, window: rd.board.windowMs,
      heat: 0, ventUntil: 0, ventLock: [0, 0, 0, 0], overheatUntil: 0, botTapAt: 0, botVentAt: 0,
    };
  }
}

function shiftCoop(rd, shift) {
  rd.startedAt += shift;
  if (rd.nextAt) rd.nextAt += shift;
  const s = rd.st;
  for (const key of ['botNextAt', 'at', 'ventUntil', 'overheatUntil', 'botTapAt', 'botVentAt']) {
    if (s[key]) s[key] += shift;
  }
  if (s.botPlan) s.botPlan = s.botPlan.map((v) => (v ? v + shift : v));
  if (s.ventLock) s.ventLock = s.ventLock.map((v) => (v ? v + shift : v));
}

module.exports = { Room, decayAt, SLOT_COLOURS, SIZE, DEFAULTS };
