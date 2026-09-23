# Game rules to make authoritative server-side

Pulled from the prototype's client-side logic (`Teamtest - Vital Link flow.dc.html`,
`Component` class) — reimplement server-side so clients can't cheat.

## Life & credit
- 4 players, life 0–100, starting values randomized per run (~66–90).
- Every task belongs to the acting player. On success, the fixed partner
  (`you→p2→p3→p4→you` rotation) is credited; on failure, that partner is
  drained instead. Amounts: solo task ±9/13, teammate simulated tasks ±7/11.
- Continuous drain on all 4 players while `screen` is `play` or `coop`:
  `perSec = 0.42 * 1.5^max(0, minutes_elapsed - 0.5)`; apply every tick
  (prototype ticks every 100ms, drains `perSec/10` per tick).
- Run ends the instant any player's life reaches 0. Broadcast `run.ended`
  with `cause` and final standings.

## Solo task rotation
9 task kinds cycle by index, get harder every level (roughly every 4-6
tasks, 4 difficulty tiers): `GATE, MEMORY, DIGITS, SLIDE, ORDER, SEQUENCE,
SHELL, STROOP, COUNT`. Every 3rd task is a co-op task instead.

- **MEMORY** — grid of 9 cells, 3 shapes placed briefly, then asked to pick
  which shape/colour was in a marked cell from 4 choices.
- **SEQUENCE** — Simon-style: watch a lit sequence (3-5 steps), repeat it on
  a 4-pad grid.
- **SHELL** — 3-cup shell game: mark one, shuffle, pick.
- **STROOP** — word names a colour rendered in a different ink colour; tap
  the ink colour, not the word.
- **COUNT** — count shapes of one colour+form among a 20-tile grid; pick the
  right number from 4 choices (must equal the true count).
- **SLIDE** — drag 3-4 sliders each into a target band and release to lock;
  a difficulty-scaled drift pulls unlocked sliders away from target.
- **GATE** — drag a ball across the screen to a goal zone, avoiding moving
  horizontal bars; touching a bar resets the ball and costs the player life
  directly (not partner-credit).
- **DIGITS** — grid of repeated digits; tap every "odd" digit (different
  value) among a majority digit; wrong taps cost the player life directly.
- **ORDER** — shown several numbered, coloured balls; memorize; then tap
  them lowest→highest with colour hidden; on success, one follow-up
  question ("which number was GREEN" / "what colour was 42") from 4 options.

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
  not your turn; heat maxing out drains all 4 by 10 and resets heat to ~42.
  Player tapping early/out-of-turn costs them 6 life directly. 14 successful
  hops wins (+16 all); timeout drains all 4 by 14.

Server should own: which variant is picked, RNG seeds for task layout, all
life deltas, and win/timeout detection — never trust client-reported success.
