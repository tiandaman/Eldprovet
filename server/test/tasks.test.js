'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Tasks = require('../shared/tasks');
const { decayAt } = require('../src/room');

test('boards are deterministic per seed', () => {
  for (const kind of Tasks.SOLO_KINDS) {
    for (let lv = 0; lv < 4; lv++) {
      const a = Tasks.generate(kind, 12345 + lv, lv);
      const b = Tasks.generate(kind, 12345 + lv, lv);
      assert.deepStrictEqual(a, b, kind + ' L' + lv);
    }
  }
  for (const v of Tasks.COOP_VARIANTS) {
    assert.deepStrictEqual(Tasks.generateCoop(v, 7, 2), Tasks.generateCoop(v, 7, 2));
  }
  assert.notDeepStrictEqual(Tasks.generate('COUNT', 1, 0), Tasks.generate('COUNT', 2, 0));
});

test('schedule: every 3rd task is co-op, kinds cycle, 4 level tiers', () => {
  assert.deepStrictEqual(Tasks.scheduleFor(1), { coop: false, kind: 'GATE' });
  assert.deepStrictEqual(Tasks.scheduleFor(2), { coop: false, kind: 'MEMORY' });
  assert.deepStrictEqual(Tasks.scheduleFor(3), { coop: true });
  assert.deepStrictEqual(Tasks.scheduleFor(4), { coop: false, kind: 'DIGITS' });
  assert.strictEqual(Tasks.levelFor(1), 0);
  assert.strictEqual(Tasks.levelFor(5), 1);
  assert.strictEqual(Tasks.levelFor(100), 24); // uncapped; boards clamp to their own tables
});

test('drain curve: 0.42 flat for 30s, then x1.65 per minute', () => {
  assert.strictEqual(decayAt(0), 0.42);
  assert.strictEqual(decayAt(30000), 0.42);
  assert.ok(Math.abs(decayAt(90000) - 0.42 * 1.65) < 1e-9);
  assert.ok(Math.abs(decayAt(150000) - 0.42 * 1.65 * 1.65) < 1e-9);
  assert.ok(Math.abs(decayAt(90000, 1.5) - 0.63) < 1e-9); // prototype curve still available
});

test('answer time is flat across levels', () => {
  for (const k of Tasks.SOLO_KINDS) {
    if (k === 'ORDER') continue; // grows with question count, not level
    assert.strictEqual(Tasks.generate(k, 3, 0).answerMs, Tasks.generate(k, 3, 3).answerMs, k);
  }
});

const run = (board, actions) => {
  const pr = Tasks.createProgress(board);
  let last;
  for (const [action, payload] of actions) {
    last = Tasks.step(pr, action, payload, 5000);
    if (last && last.done) return last;
  }
  return last;
};

test('grading: single-answer kinds', () => {
  for (let seed = 1; seed < 40; seed++) {
    const lv = seed % 4;
    const mem = Tasks.generate('MEMORY', seed, lv);
    assert.strictEqual(run(mem, [['submit', { choice: mem.answer }]]).ok, true);
    assert.strictEqual(run(mem, [['submit', { choice: (mem.answer + 1) % 4 }]]).ok, false);
    const cnt = Tasks.generate('COUNT', seed, lv);
    assert.ok(cnt.options.includes(cnt.answer));
    assert.strictEqual(cnt.answer, cnt.tiles.filter((t) => t.c === cnt.target.c && t.sh === cnt.target.sh).length);
    assert.strictEqual(run(cnt, [['submit', { count: cnt.answer }]]).ok, true);
    const st = Tasks.generate('STROOP', seed, lv);
    assert.notStrictEqual(st.word, st.ink);
    assert.strictEqual(run(st, [['submit', { ink: st.ink.toLowerCase() }]]).ok, true);
    assert.strictEqual(run(st, [['submit', { ink: st.word }]]).ok, false);
    const sh = Tasks.generate('SHELL', seed, lv);
    assert.strictEqual(run(sh, [['submit', { cup: sh.mark }]]).ok, true);
  }
});

test('grading: multi-step kinds', () => {
  const seq = Tasks.generate('SEQUENCE', 9, 2);
  assert.deepStrictEqual([0, 1, 2, 3].map((lv) => Tasks.generate('SEQUENCE', 9, lv).seq.length), [2, 3, 4, 5]); // Simon: 2, then +1
  assert.strictEqual(seq.seq.length, 4);
  assert.strictEqual(run(seq, seq.seq.map((p) => ['submit', { pad: p }])).ok, true);
  assert.strictEqual(run(seq, [['submit', { pads: seq.seq }]]).ok, true);
  assert.strictEqual(run(seq, [['submit', { pad: (seq.seq[0] + 1) % 4 }]]).ok, false);

  const dg = Tasks.generate('DIGITS', 3, 1);
  const wrong = dg.digits.findIndex((d) => d === dg.base);
  const pr = Tasks.createProgress(dg);
  assert.strictEqual(Tasks.step(pr, 'submit', { index: wrong }).penalty, 6);
  assert.strictEqual(Tasks.step(pr, 'submit', { index: wrong }).penalty, undefined, 'double-tapping the same wrong cell costs once');
  let r;
  for (const i of dg.answer) r = Tasks.step(pr, 'submit', { index: i });
  assert.deepStrictEqual(r, { done: true, ok: true });

  const od = Tasks.generate('ORDER', 11, 0);
  assert.strictEqual(od.balls.length, 2);
  assert.strictEqual(od.questions.length, 1);
  assert.strictEqual(run(od, od.questions.map((q) => ['submit', { answer: q.answer }])).ok, true);
  const wrongFirst = od.questions[0].options.find((o) => o !== od.questions[0].answer);
  assert.strictEqual(run(od, [['submit', { answer: wrongFirst }]]).ok, false);
  assert.strictEqual(Tasks.step(Tasks.createProgress(od), 'submit', { pick: 12 }), null); // old sort input is gone

  const sl = Tasks.generate('SLIDE', 5, 3);
  const miss = run(sl, [['lock', { track: 0, value: sl.tracks[0].target + sl.tolerance + 1 }]]);
  assert.strictEqual(miss.done, false);
  assert.strictEqual(run(sl, sl.tracks.map((t, i) => ['lock', { track: i, value: t.target + sl.tolerance - 0.5 }])).ok, true);

  const gt = Tasks.generate('GATE', 5, 0);
  const gp = Tasks.createProgress(gt);
  assert.strictEqual(Tasks.step(gp, 'collision', {}, 100).penalty, 7);
  assert.strictEqual(Tasks.step(gp, 'submit', { event: 'goal' }, 100).ok, false); // implausibly fast
  assert.strictEqual(Tasks.step(Tasks.createProgress(gt), 'submit', { event: 'goal' }, 4000).ok, true);
});

test('grading ignores client-reported verdicts', () => {
  const seq = Tasks.generate('SEQUENCE', 1, 0);
  assert.strictEqual(Tasks.step(Tasks.createProgress(seq), 'submit', { complete: true }), null);
});

test('co-op tokens: 3 per seat', () => {
  const b = Tasks.generateCoop('tokens', 42, 0);
  assert.strictEqual(b.tokens.length, 12);
  for (let s = 0; s < 4; s++) assert.strictEqual(b.tokens.filter((t) => t.owner === s).length, 3);
});

test('co-op tokens: scattered, in bounds, never overlapping', () => {
  const xs = new Set();
  for (let seed = 1; seed <= 500; seed++) {
    const { tokens, layout: L } = Tasks.generateCoop('tokens', seed, seed % 4);
    for (const t of tokens) {
      assert.ok(t.x >= L.xMin && t.x <= L.xMax && t.y >= L.yMin && t.y <= L.yMax, 'in bounds');
      xs.add(Math.round(t.x));
    }
    for (let i = 0; i < 12; i++) {
      for (let j = i + 1; j < 12; j++) {
        const d = Math.hypot(tokens[i].x - tokens[j].x, (tokens[i].y - tokens[j].y) / L.aspect);
        assert.ok(d >= L.size + L.gap - 1e-9, 'seed ' + seed + ': tokens ' + (i + 1) + '/' + (j + 1) + ' overlap');
      }
    }
  }
  assert.ok(xs.size > 60, 'positions spread across the board, not a grid');
});


test('ORDER: 2 balls at LV1-2, 3 from LV3, 4 from LV8; one random, well-formed question', () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 600; seed++) {
    const lv = seed % 12;
    const b = Tasks.generate('ORDER', seed, lv);
    assert.strictEqual(b.balls.length, lv >= 7 ? 4 : lv >= 2 ? 3 : 2, 'LV' + (lv + 1));
    if (b.balls.length === 2) assert.notStrictEqual(b.balls[0].c, b.balls[1].c, 'two colours');
    assert.strictEqual(b.questions.length, 1, 'one question only');
    assert.strictEqual(b.showMs, Tasks.generate('ORDER', seed, 0).showMs, 'no level ramp');
    for (const q of b.questions) {
      kinds.add(q.kind);
      assert.ok(q.options.includes(q.answer), q.text);
      assert.strictEqual(new Set(q.options).size, q.options.length, 'unique options');
    }
  }
  assert.ok(kinds.size >= 9, 'uses the whole pool: ' + [...kinds].join(','));
});

test('GATE: one bar at LV1, one more per level, four at most', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 7].map((lv) => Tasks.generate('GATE', 3, lv).bars.length), [1, 2, 3, 4, 4, 4]);
  // Past four bars the speed keeps climbing a little.
  const avg = (lv) => { let s = 0; for (let seed = 1; seed <= 200; seed++) s += Tasks.generate('GATE', seed, lv).bars[0].speed; return s / 200; };
  assert.ok(avg(5) > avg(3));
});

test('COUNT: square board 3×3 at LV1, 4×4 from LV2, 5×5 from LV4, 6×6 from LV6', () => {
  const sides = [0, 1, 2, 3, 4, 5, 9].map((lv) => Tasks.generate('COUNT', 8, lv));
  assert.deepStrictEqual(sides.map((b) => b.gridCols), [3, 4, 4, 5, 5, 6, 6]);
  for (const b of sides) assert.strictEqual(b.tiles.length, b.gridCols * b.gridCols);
});

test('MEMORY: 3×3 at LV1-2, 4×4 from LV3, 5×5 from LV6; shapes stay on the board', () => {
  assert.deepStrictEqual([0, 1, 2, 4, 5, 9].map((lv) => Tasks.generate('MEMORY', 4, lv).side), [3, 3, 4, 4, 5, 5]);
  for (let seed = 1; seed <= 300; seed++) {
    const lv = seed % 10;
    const b = Tasks.generate('MEMORY', seed, lv);
    assert.strictEqual(b.grid, b.side * b.side);
    assert.strictEqual(b.placed.length, Math.min(9, 2 + lv));
    assert.strictEqual(new Set(b.placed.map((p) => p.i)).size, b.placed.length, 'one shape per cell');
    for (const p of b.placed) assert.ok(p.i >= 0 && p.i < b.grid);
    assert.strictEqual(b.choices[b.answer].c + b.choices[b.answer].sh, b.placed.find((p) => p.i === b.askCell).c + b.placed.find((p) => p.i === b.askCell).sh);
  }
});

test('every generator terminates and COUNT always offers 4 distinct options', () => {
  // Regression: COUNT used to spin forever when the true count was 0 at level 1.
  for (const k of Tasks.SOLO_KINDS) {
    for (let lv = 0; lv < 8; lv++) {
      for (let seed = 1; seed <= 1500; seed++) {
        const b = Tasks.generate(k, seed, lv);
        if (k === 'COUNT') {
          assert.strictEqual(new Set(b.options).size, 4);
          assert.ok(b.options.includes(b.answer));
        }
      }
    }
  }
});


test('colour names are plain words', () => {
  assert.deepStrictEqual(Tasks.COLOURS.slice().sort(), ['BLUE', 'GREEN', 'WHITE', 'YELLOW']);
});
