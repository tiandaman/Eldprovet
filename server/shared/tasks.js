/* The Team Test — deterministic task boards.
 *
 * Shared between server and clients. The server sends `task.assign
 * { id, kind, seed, level }`; both sides call `generate(kind, seed, level)`
 * and get byte-identical boards, so the server never ships geometry.
 *
 * The server grades answers against the same board — clients never report
 * their own success. Everything here must stay pure and deterministic: no
 * Math.random, no Date.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeamTestTasks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── rng ─────────────────────────────────────────────────
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    const next = mulberry32(seed);
    const rng = {
      next,
      int: (n) => Math.floor(next() * n),
      range: (lo, hi) => lo + next() * (hi - lo),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      shuffle: (arr) => {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
      },
      chance: (p) => next() < p,
    };
    return rng;
  }

  // ── constants ───────────────────────────────────────────
  // Colour names, not hex — clients map to their own palette. Plain names on purpose
  // (the hues are unchanged): GREEN #5FC98A, YELLOW #D9A24B, BLUE #4FC0D0, WHITE #C6C2B6.
  const COLOURS = ['GREEN', 'YELLOW', 'BLUE', 'WHITE'];
  const SHAPES = ['square', 'circle', 'diamond'];
  const SOLO_KINDS = ['GATE', 'MEMORY', 'DIGITS', 'SLIDE', 'ORDER', 'SEQUENCE', 'SHELL', 'STROOP', 'COUNT'];
  const COOP_VARIANTS = ['tokens', 'hold', 'relay'];
  const CATEGORY = {
    MEMORY: 'memory', SEQUENCE: 'memory', ORDER: 'memory',
    STROOP: 'concentration', COUNT: 'concentration', DIGITS: 'concentration',
    SLIDE: 'spatial', GATE: 'spatial',
    SHELL: 'multitasking', COOP: 'multitasking',
  };

  /** Level (0-based, uncapped) for a player's 1-based task number: +1 every 4 tasks.
   *  Most boards top out at their L4 table (tier 3); ORDER keeps growing (see below). */
  function levelFor(n) { return Math.floor((n - 1) / 4); }
  const tierOf = (level) => Math.min(3, Math.max(0, level));

  /** What task index n (1-based) is: every 3rd is co-op. */
  function scheduleFor(n) {
    if (n % 3 === 0) return { coop: true };
    const solo = n - Math.floor(n / 3);
    return { coop: false, kind: SOLO_KINDS[(solo - 1) % SOLO_KINDS.length] };
  }

  // ── solo generators ─────────────────────────────────────
  // Every board carries `answerMs` (time allowed after any show phase) and,
  // where relevant, `showMs`. Deadline = assign time + showMs + answerMs.

  // Pace: how long players get. answer = time to respond (flat across levels — pressure
  // comes from the drain curve instead); show = watch/memorise phases.
  const PACE = { answer: 1.4, show: 1.25 };
  const ans = (ms) => Math.round(ms * PACE.answer);
  const shw = (ms) => Math.round(ms * PACE.show);

  // Difficulty by level (index 0 = L1). L1 is deliberately gentle; the ramp starts at L2.
  const GEN = {
    GATE(rng, lv) {
      const count = [1, 2, 3, 4][lv];
      const bars = [];
      for (let i = 0; i < count; i++) {
        bars.push({
          i,
          top: count === 1 ? 52 : 24 + i * (56 / (count - 1)),
          w: Math.round(30 + rng.next() * 12),
          speed: +((lv === 0 ? 0.35 : 0.55 + lv * 0.28) + rng.next() * (lv === 0 ? 0.2 : 0.4)).toFixed(2),
          phase: +(rng.next() * 6.2).toFixed(2),
          span: 58,
        });
      }
      return {
        bars, start: { x: 12, y: 89 }, goal: { x: 79, y: 17 },
        collisionPenalty: 7, minSolveMs: 600,
        showMs: 0, answerMs: ans(20000),
      };
    },

    DIGITS(rng, lv) {
      const cols = [5, 6, 7, 8][lv];
      const rows = [3, 4, 4, 5][lv];
      const total = cols * rows;
      const odds = [2, 3, 4, 6][lv];
      const base = rng.int(10);
      let other = rng.int(10);
      while (other === base) other = rng.int(10);
      const marks = new Set();
      while (marks.size < odds) marks.add(rng.int(total));
      const digits = [];
      for (let i = 0; i < total; i++) digits.push(marks.has(i) ? other : base);
      return {
        cols, rows, digits, base, odd: other,
        answer: Array.from(marks).sort((a, b) => a - b),
        wrongPenalty: 6,
        showMs: 0, answerMs: ans(16000),
      };
    },

    ORDER(rng, lv) {
      // Numbered, coloured balls in a row. Memorise them, then answer two questions about
      // what you saw, drawn from a pool so no two runs feel alike.
      // Grows with you: 2 balls at LV1–2, 3 from LV3, 4 from LV8 (lv is 0-based, uncapped).
      const count = lv >= 7 ? 4 : lv >= 2 ? 3 : 2;
      const pool = [];
      while (pool.length < count) {
        const v = rng.int(90) + 10;
        if (pool.indexOf(v) < 0) pool.push(v);
      }
      const colours = count === 2 ? rng.shuffle(COLOURS).slice(0, 2) : null; // two balls → two colours
      const balls = pool.map((v, i) => ({ v, c: colours ? colours[i] : rng.pick(COLOURS) }));
      if (new Set(balls.map((b) => b.c)).size < 2) {
        balls[0].c = COLOURS[(COLOURS.indexOf(balls[0].c) + 1) % 4];
      }
      const n = balls.length;
      const nums = balls.map((b) => b.v);
      const ORD = n === 2 ? ['FIRST', 'LAST'] : n === 3 ? ['FIRST', 'IN THE MIDDLE', 'LAST'] : ['FIRST', 'SECOND', 'THIRD', 'LAST'];
      const taken = new Set(nums);
      const decoy = () => { // a number that wasn't shown and isn't one-off from one that was
        let d;
        do d = rng.int(90) + 10; while ([...taken].some((v) => Math.abs(v - d) < 2));
        taken.add(d);
        return d;
      };
      const colourOpts = (ans) => rng.shuffle(COLOURS).filter((c) => c !== ans).slice(0, 3).concat([ans]);
      const numberOpts = (ans) => { const o = nums.filter((v) => v !== ans); while (o.length < 3) o.push(decoy()); return o.concat([ans]); };
      const q = (kind, text, answer, options, swatch) => ({ kind, text, answer: String(answer), options: rng.shuffle(options).map(String), swatch: swatch || null });
      const once = COLOURS.filter((c) => balls.filter((b) => b.c === c).length === 1);
      const byV = balls.slice().sort((x, y) => x.v - y.v);
      const QUESTIONS = [
        () => { const b = rng.pick(balls); return q('colourOf', 'WHAT COLOUR WAS ' + b.v + '?', b.c, colourOpts(b.c)); },
        () => { if (!once.length) return null; const c = rng.pick(once); const b = balls.find((x) => x.c === c); return q('numberOf', 'WHICH NUMBER WAS ' + c + '?', b.v, numberOpts(b.v), c); },
        () => q('highestColour', 'WHAT COLOUR WAS THE HIGHEST NUMBER?', byV[n - 1].c, colourOpts(byV[n - 1].c)),
        () => q('lowestColour', 'WHAT COLOUR WAS THE LOWEST NUMBER?', byV[0].c, colourOpts(byV[0].c)),
        () => { const i = rng.int(n); return q('numberAt', 'WHICH NUMBER WAS ' + ORD[i] + '?', balls[i].v, numberOpts(balls[i].v)); },
        () => { const i = rng.int(n); return q('colourAt', 'WHAT COLOUR WAS ' + ORD[i] + '?', balls[i].c, colourOpts(balls[i].c)); },
        () => { const c = rng.pick(COLOURS); const k = balls.filter((b) => b.c === c).length; return q('countColour', 'HOW MANY WERE ' + c + '?', k, [0, 1, 2, 3], c); },
        () => { const d = decoy(); return q('missing', 'WHICH NUMBER WAS NOT THERE?', d, nums.slice(0, 3).concat([d])); },
        () => { if (n < 3) return null; const i = rng.int(n - 1); return q('rightOf', 'WHAT CAME RIGHT AFTER ' + balls[i].v + '?', balls[i + 1].v, numberOpts(balls[i + 1].v)); },
        () => { if (n < 3) return null; const i = 1 + rng.int(n - 1); return q('leftOf', 'WHAT CAME RIGHT BEFORE ' + balls[i].v + '?', balls[i - 1].v, numberOpts(balls[i - 1].v)); },
      ];
      // Two questions, never the same kind twice.
      const want = 2;
      const questions = [];
      const used = new Set();
      for (const make of rng.shuffle(QUESTIONS)) {
        if (questions.length >= want) break;
        const x = make();
        if (!x || used.has(x.kind) || new Set(x.options).size < x.options.length) continue;
        used.add(x.kind);
        questions.push(x);
      }
      return {
        balls, questions,
        showMs: shw(3600), // no level ramp
        answerMs: ans(7500) * questions.length,
      };
    },

    SLIDE(rng, lv) {
      const count = [2, 3, 4, 4][lv];
      const names = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'];
      const tracks = [];
      for (let i = 0; i < count; i++) {
        tracks.push({
          label: names[i],
          start: rng.chance(0.5) ? 4 : 96,
          target: +(18 + rng.next() * 64).toFixed(2),
        });
      }
      return {
        tracks, tolerance: [15, 10, 7, 5][lv],
        drift: lv >= 2 ? +(0.16 + lv * 0.08).toFixed(2) : 0,
        showMs: 0, answerMs: ans(16000),
      };
    },

    SHELL(rng, lv) {
      const mark = rng.int(3);
      const moves = [3, 6, 9, 12][lv];
      const swaps = [];
      for (let k = 0; k < moves; k++) {
        const a = rng.int(3);
        let b = rng.int(3);
        while (b === a) b = rng.int(3);
        swaps.push([a, b]);
      }
      const leadMs = shw([1700, 1400, 1240, 1080][lv]);
      const swapMs = shw([560, 400, 340, 280][lv]);
      // Cups are identified by id; swaps exchange the positions of cup ids a,b.
      // The marked cup id never changes, so the answer is simply `mark`.
      return {
        cups: 3, mark, swaps, leadMs, swapMs,
        answer: mark,
        showMs: leadMs + moves * swapMs, answerMs: ans(7000),
      };
    },

    STROOP(rng, lv) {
      const word = rng.pick(COLOURS);
      let ink = rng.pick(COLOURS);
      while (ink === word) ink = rng.pick(COLOURS);
      return {
        word, ink, options: rng.shuffle(COLOURS), answer: ink,
        showMs: 0, answerMs: ans(7000),
      };
    },

    COUNT(rng, lv) {
      const cols = COLOURS.slice(0, [2, 3, 3, 4][lv]);
      const total = [12, 20, 25, 30][lv];
      const tiles = [];
      for (let i = 0; i < total; i++) tiles.push({ c: rng.pick(cols), sh: rng.pick(SHAPES) });
      const target = { c: rng.pick(cols), sh: rng.pick(SHAPES) };
      const count = tiles.filter((t) => t.c === target.c && t.sh === target.sh).length;
      const set = new Set([count]);
      const spread = 2 + lv;
      // Distractors near the true count. Bounded: near 0 the window can hold fewer than 4
      // distinct values (count 0, spread 2 → only 0..2), so fall back to counting upward.
      for (let tries = 0; set.size < 4 && tries < 40; tries++) set.add(Math.max(0, count + rng.int(spread * 2 + 1) - spread));
      for (let k = 1; set.size < 4; k++) set.add(count + k);
      return {
        tiles, gridCols: [4, 5, 5, 6][lv], target,
        options: Array.from(set).sort((a, b) => a - b), answer: count,
        showMs: 0, answerMs: ans(11000),
      };
    },

    MEMORY(rng, lv) {
      const cols = COLOURS.slice(0, [2, 3, 4, 4][lv]);
      const count = [2, 3, 5, 6][lv];
      const idx = rng.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).slice(0, count);
      const placed = idx.map((i) => ({ i, c: rng.pick(cols), sh: rng.pick(SHAPES) }));
      const tgt = rng.pick(placed);
      const opts = [{ c: tgt.c, sh: tgt.sh }];
      let guard = 0;
      while (opts.length < 4 && guard++ < 80) {
        const o = { c: rng.pick(cols), sh: rng.pick(SHAPES) };
        if (!opts.some((x) => x.c === o.c && x.sh === o.sh)) opts.push(o);
      }
      for (const c of cols) for (const sh of SHAPES) if (opts.length < 4 && !opts.some((x) => x.c === c && x.sh === sh)) opts.push({ c, sh });
      const choices = rng.shuffle(opts);
      const answer = choices.findIndex((o) => o.c === tgt.c && o.sh === tgt.sh);
      return {
        grid: 9, placed, askCell: tgt.i, choices, answer,
        showMs: shw(Math.max(1500, 2800 - lv * 420)),
        answerMs: ans(9000),
      };
    },

    SEQUENCE(rng, lv) {
      const len = 2 + lv; // Simon: 2 at L1, +1 each level
      const seq = [];
      for (let i = 0; i < len; i++) seq.push(rng.int(4));
      const gapMs = shw(Math.max(420, 760 - lv * 110));
      return {
        pads: 4, seq, gapMs, leadMs: 600,
        answer: seq,
        showMs: 700 + len * gapMs,
        answerMs: ans(8000),
      };
    },
  };

  // ── co-op token scatter ─────────────────────────────────
  // Positions are % of the co-op board (a 9:16 portrait phone board). Tokens
  // are drawn `size`% of the board width wide, so spacing is measured in real
  // proportions: centres at least `size + gap` widths apart never overlap.
  const TOKEN_LAYOUT = { aspect: 9 / 16, size: 16, gap: 3, xMin: 10, xMax: 90, yMin: 7, yMax: 93 };

  function scatter(rng, count, L) {
    const minDist = L.size + L.gap;          // in % of board width
    const yScale = 1 / L.aspect;             // 1% of height = (4/3)% of width
    const pts = [];
    for (let tries = 0; pts.length < count; tries++) {
      if (tries > 4000) return null;
      const x = +(L.xMin + rng.next() * (L.xMax - L.xMin)).toFixed(1);
      const y = +(L.yMin + rng.next() * (L.yMax - L.yMin)).toFixed(1);
      if (pts.every((p) => Math.hypot(p.x - x, (p.y - y) * yScale) >= minDist)) pts.push({ x, y });
    }
    return pts;
  }

  // ── co-op generators ────────────────────────────────────
  const COOP_GEN = {
    tokens(rng, lv) {
      const owners = rng.shuffle([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
      const layout = TOKEN_LAYOUT;
      let pts = null;
      // Rejection-sample scattered positions; restart the layout on the rare dead end.
      while (!pts) pts = scatter(rng, 12, layout);
      const tokens = pts.map((p, i) => ({ n: i + 1, owner: owners[i], x: p.x, y: p.y }));
      return { tokens, layout, wrongPenalty: 9, durationMs: 48000 };
    },
    hold(rng, lv) {
      return {
        // ~1.6 s of all-four holding at L1 (up to ~2.8 s at L4). Letting go only bleeds
        // the charge slowly, and grip lasts ~5 s and refills in ~3 s.
        need: 1600 + lv * 400, gripDrain: 2.0, gripRecover: 3.0, gripRearm: 25,
        chargeUp: 100, chargeDown: 25, gripPenalty: 5,
        durationMs: 36000,
      };
    },
    relay(rng, lv) {
      return {
        order: rng.shuffle([0, 1, 2, 3]), hops: 14,
        windowMs: Math.max(700, 1500 - lv * 200),
        missPenalty: 8, earlyPenalty: 6, overheatPenalty: 10, ventMs: 1100,
        durationMs: 34000,
      };
    },
  };

  function generate(kind, seed, level) {
    const g = GEN[kind];
    if (!g) throw new Error('unknown task kind ' + kind);
    return Object.assign({ kind, seed, level }, g(makeRng(seed), kind === 'ORDER' ? level : tierOf(level)));
  }

  function generateCoop(variant, seed, level) {
    const g = COOP_GEN[variant];
    if (!g) throw new Error('unknown coop variant ' + variant);
    return Object.assign({ variant, seed, level }, g(makeRng(seed), tierOf(level)));
  }

  // ── grading ─────────────────────────────────────────────
  // A task progress object is created per assignment; `step()` consumes one
  // client action and returns { done, ok, penalty? , progress? }.
  //   done:false          → keep going (penalty may still apply)
  //   done:true, ok:bool  → task resolved

  function createProgress(board) {
    return { board, state: {}, resolved: false };
  }

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : NaN);

  function step(progress, action, payload, elapsedMs) {
    const b = progress.board;
    const st = progress.state;
    const p = payload || {};
    switch (b.kind) {
      case 'MEMORY':
        if (action !== 'submit' || !('choice' in p)) return null;
        return { done: true, ok: num(p.choice) === b.answer };
      case 'SHELL':
        if (action !== 'submit' || !('cup' in p)) return null;
        return { done: true, ok: num(p.cup) === b.answer };
      case 'STROOP':
        if (action !== 'submit' || !('ink' in p)) return null;
        return { done: true, ok: String(p.ink).toUpperCase() === b.answer };
      case 'COUNT':
        if (action !== 'submit' || !('count' in p)) return null;
        return { done: true, ok: num(p.count) === b.answer };

      case 'SEQUENCE': {
        if (action !== 'submit') return null;
        st.input = st.input || [];
        const pads = Array.isArray(p.pads) ? p.pads : ('pad' in p ? [p.pad] : null);
        if (!pads) return null;
        for (const pad of pads) {
          const i = st.input.length;
          if (num(pad) !== b.seq[i]) return { done: true, ok: false };
          st.input.push(pad);
          if (st.input.length === b.seq.length) return { done: true, ok: true };
        }
        return { done: false, progress: { entered: st.input.length } };
      }

      case 'DIGITS': {
        if (action !== 'submit' || !('index' in p)) return null;
        st.found = st.found || [];
        const i = num(p.index);
        if (st.found.indexOf(i) >= 0) return { done: false };
        if (b.answer.indexOf(i) < 0) return { done: false, penalty: b.wrongPenalty, reason: 'digits.wrong' };
        st.found.push(i);
        if (st.found.length === b.answer.length) return { done: true, ok: true };
        return { done: false, progress: { found: st.found.length, of: b.answer.length } };
      }

      case 'ORDER': {
        // One answer per question, in order. Any wrong answer fails the task.
        if (action !== 'submit' || !('answer' in p)) return null;
        st.q = st.q || 0;
        const cur = b.questions[st.q];
        if (!cur) return null;
        if (String(p.answer).toUpperCase() !== cur.answer.toUpperCase()) return { done: true, ok: false };
        st.q += 1;
        if (st.q >= b.questions.length) return { done: true, ok: true };
        return { done: false, progress: { question: st.q, of: b.questions.length } };
      }

      case 'SLIDE': {
        if (action !== 'lock') return null;
        st.locked = st.locked || [];
        const track = num(p.track);
        const value = num(p.value);
        const t = b.tracks[track];
        if (!t || isNaN(value) || st.locked.indexOf(track) >= 0) return null;
        const hit = Math.abs(value - t.target) <= b.tolerance;
        if (!hit) return { done: false, progress: { track, locked: false } };
        st.locked.push(track);
        if (st.locked.length === b.tracks.length) return { done: true, ok: true };
        return { done: false, progress: { track, locked: true } };
      }

      case 'GATE': {
        // Ball physics run on the client; the server can only sanity-check.
        if (action === 'collision') return { done: false, penalty: b.collisionPenalty, reason: 'gate.collision' };
        if (action !== 'submit') return null;
        if (p.event === 'collision') return { done: false, penalty: b.collisionPenalty, reason: 'gate.collision' };
        if (p.event === 'goal' || p.goal === true) {
          if (elapsedMs < b.minSolveMs) return { done: true, ok: false, reason: 'too_fast' };
          return { done: true, ok: true };
        }
        return null;
      }
    }
    return null;
  }

  return {
    COLOURS, SHAPES, SOLO_KINDS, COOP_VARIANTS, CATEGORY,
    makeRng, levelFor, scheduleFor, generate, generateCoop, createProgress, step,
  };
});
