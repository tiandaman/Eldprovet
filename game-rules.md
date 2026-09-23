# Game rules to make authoritative server-side

Pulled from the prototype's client-side logic (`Teamtest - Vital Link flow.dc.html`,
`Component` class) — reimplement server-side so clients can't cheat.

## Life & credit
- 4 players, life 0–100, starting values randomized per run (~66–90).
- Every task belongs to the acting player. On success, the fixed partner
  (by seat, every run: `P1→P2→P3→P4→P1`) is credited; on failure, that partner is
  drained instead. Amounts: solo task +9/−13, bot stand-in tasks +7/−11.
- Continuous drain on all 4 players while `screen` is `play` or `coop`:
  `perSec = 0.42 * 1.65^max(0, minutes_elapsed - 0.5)` (the prototype used 1.5);
  apply every tick (server ticks every 100ms, drains `perSec/10` per tick).
- Run ends the instant any player's life reaches 0. Broadcast `run.ended`
  with `cause` and final standings.

## Solo task rotation
9 task kinds cycle by index: `GATE, MEMORY, DIGITS, SLIDE, ORDER, SEQUENCE,
SHELL, STROOP, COUNT`. Play alternates: a 30 s solo phase (each player at
their own pace, 4 s grace for in-flight tasks), then a 2.5 s "co-op incoming"
card naming the variant, then one co-op round. The whole team's level goes up
by one each time a co-op round finishes (won or lost) — never mid-phase. Most
boards stop getting harder at LV4; GATE, ORDER, COUNT and MEMORY keep growing.

- **MEMORY** — square grid (3×3 at LV1–2, 4×4 from LV3, 5×5 from LV6) with
  2 shapes at LV1 and one more per level (max 9), placed briefly; then pick
  which shape/colour was in a marked cell from 4 choices. Shapes fill their cells.
- **SEQUENCE** — Simon-style: watch a lit sequence (3-5 steps), repeat it on
  a 4-pad grid.
- **SHELL** — 3-cup shell game: mark one, shuffle, pick.
- **STROOP** — word names a colour rendered in a different ink colour; tap
  the ink colour, not the word.
- **COUNT** — count shapes of one colour+form in a square grid (3×3 at LV1,
  4×4 from LV2, 5×5 from LV4, 6×6 from LV6); pick the right number from 4
  choices (must equal the true count).
- **SLIDE** — drag 3-4 sliders each into a target band and release to lock;
  a difficulty-scaled drift pulls unlocked sliders away from target.
- **GATE** — drag a ball across the screen to a goal zone, avoiding moving
  horizontal bars (1 bar at LV1, one more per level, max 4 — after that the
  bars speed up); touching a bar resets the ball and costs the player life
  directly (not partner-credit).
- **DIGITS** — grid of repeated digits; tap every "odd" digit (different
  value) among a majority digit; a wrong tap costs the player life directly
  (once per cell — tapping the same wrong cell again is free).
- **ORDER** — shown numbered, coloured balls (2 at LV1–2, 3 from LV3, 4 from
  LV8); memorize; then answer one question picked at random ("which number
  was GREEN", "what colour was the highest", …) from 4 options.

Category buckets for the results screen: memory→{MEMORY, SEQUENCE, ORDER},
concentration→{STROOP, COUNT, DIGITS}, spatial→{SLIDE, GATE},
multitasking→{SHELL, all co-op}.

## Co-op tasks (all 4 players, chosen at random per co-op slot)
- **tokens** ("twelve in order") — 12 numbered tokens scattered on a shared
  board, each owned by one of the 4 players (3 each). Players must tap 1→12
  in order; a token can only be tapped by its owner, in sequence. Tapping
  early or tapping someone else's token drains that player 9 life directly.
  Clearing all 12 grants +16 life to all 4; timeout drains all 4 by 14.
- **hold** ("simultaneous hold") — each player has a press-and-hold pad that
  flickers on/off on its own cadence (3 are simulated server-side stand-ins
  for AI/other players, 1 is the real player). Charge fills while all 4 are
  held simultaneously, drains otherwise. Player's own pad has a "grip" meter
  that drains while held and recovers while released; grip hitting 0 forces
  release and costs 5 life. Reaching charge target wins (+16 all); timeout
  drains all 4 by 14.
- **relay** ("pass the charge") — a charge visits players in random order,
  each getting a shrinking time window to tap when it's their turn (12%
  chance of an AI "miss" costing that player 8 life). A shared "heat" meter
  rises each hop and can be vented (server: 1.1s cooldown) only when it's
  not your turn. Venting locks only the venter's own tap for those 1.1s —
  never the player whose turn it is — so venting right before your own turn
  risks a miss. Heat maxing out drains all 4 by 10 and resets heat to ~42.
  Player tapping early/out-of-turn costs them 6 life directly. 14 successful
  hops wins (+16 all); timeout drains all 4 by 14.

Server should own: which variant is picked, RNG seeds for task layout, all
life deltas, and win/timeout detection — never trust client-reported success.
