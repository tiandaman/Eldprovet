'use strict';
/* Stand-in players for empty seats (private rooms started short-handed,
 * queue fill timeout) and for players who dropped past the grace period.
 * Behaviour mirrors the prototype's simulated teammates.
 */

const SOLO_SUCCESS = 0.72;

/** Decide when and how a bot resolves a solo task. */
function planSolo(tk, random) {
  const b = tk.board;
  return {
    botAt: tk.assignedAt + b.showMs + (0.3 + random() * 0.6) * b.answerMs,
    botOk: random() < SOLO_SUCCESS,
  };
}

/** Twelve-in-order: when the next token belongs to a bot, it claims it (~55%/850ms). */
function tokens(room, rd, t) {
  const s = rd.st;
  if (t < s.botNextAt) return;
  s.botNextAt = t + 850;
  const tok = rd.board.tokens[s.next - 1];
  if (!tok) return;
  const m = room.memberAtSeat(tok.owner);
  if (!m || !m.bot) return;
  if (room.random() > 0.55) return;
  if (room.random() < 0.07) {
    room.penalise(m, rd.board.wrongPenalty, 'coop.out_of_order');
    return;
  }
  room.claimToken(rd, m, tok.n);
}

/** Simultaneous hold: bots are team players. They hold while any human holds (after a
 * human-ish reaction delay), let go before their grip tears, and re-grip once it has
 * recovered. With no humans in the room they all pulse together. */
function hold(room, rd, t) {
  const s = rd.st;
  s.botWant = s.botWant || [false, false, false, false];
  s.botSwitchAt = s.botSwitchAt || [0, 0, 0, 0];
  const humans = room.members.filter((m) => !m.bot);
  const humanHolding = humans.some((m) => s.holding[room.seatOf(m)]);
  for (let seat = 0; seat < 4; seat++) {
    const m = room.memberAtSeat(seat);
    if (!m || !m.bot) continue;
    const grip = s.grip[seat];
    const held = s.holding[seat];
    let want;
    if (s.broken[seat]) want = false;
    else if (held && grip < 14) want = false;                    // save the grip, don't tear it
    else if (!held && grip < 40) want = false;                   // let it refill first
    else want = humans.length ? humanHolding : grip > 90 || held; // follow the humans / pulse together
    if (want !== s.botWant[seat]) {
      s.botWant[seat] = want;
      // Human-ish: 0.2–0.55 s to grab on, the odd extra hesitation, quicker to let go.
      const hesitate = want && room.random() < 0.15 ? 400 : 0;
      s.botSwitchAt[seat] = t + (want ? 200 + room.random() * 350 + hesitate : 80 + room.random() * 150);
    }
    if (held !== want && t >= s.botSwitchAt[seat]) s.holding[seat] = want;
  }
}

/** Pass the charge: bots tap inside their window (12% miss) and vent when hot.
 * Venting only locks the venter's own tap, so a bot never vents right before its turn. */
function relay(room, rd, t) {
  const s = rd.st;
  const seat = rd.board.order[s.hop % 4];
  const nextSeat = rd.board.order[(s.hop + 1) % 4];
  const m = room.memberAtSeat(seat);
  if (s.armed && m && m.bot && t >= s.ventLock[seat]) {
    if (!s.botTapAt) {
      // A miss is modelled as never tapping; the window expiry applies the penalty.
      s.botTapAt = room.random() < 0.12 ? Infinity : t + (0.2 + room.random() * 0.6) * s.window;
    }
    if (t >= s.botTapAt) { room.relayAdvance(rd, true, m); return; }
  }
  if (s.heat > 80 && t >= s.ventUntil && t >= s.botVentAt) {
    s.botVentAt = t + 1500;
    const venters = room.members.filter((x) => x.bot && room.seatOf(x) !== seat && room.seatOf(x) !== nextSeat);
    if (venters.length && room.random() < 0.3) {
      s.ventUntil = t + rd.board.ventMs;
      s.ventLock[room.seatOf(venters[0])] = s.ventUntil;
      s.ventBy = venters[0].playerId;
    }
  }
}

module.exports = { planSolo, tokens, hold, relay };
