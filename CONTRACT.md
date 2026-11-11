# Hold'em rules component

## Purpose and facilities
Texas hold'em as the game-rules interface a turn engine drives, over a hand state machine. `createGameRules({ranking, ledger, deck, schedule, rules?})` provides `optionNames`, `newRound`, `phase`, `parseMove`, `act`, `defaultMove`, `step`, `outcome`, `voidRound`, `observation`, `records`, `publicView`, `legal` and `prompt`, exactly as turn-engine declares them. A round is `{hand, autoSteps}`; the engine's chip ledger goes in and comes back on every call, and every chip moves through chip-ledger operations (`commit`, `fold`, `endRound`, `returnUncalled`, `buildPots`, `awardPot`, `settle`, `voidHand`), so the ledger's `sidePots`, `oddChipRule` and `minimumUnit` settings decide the pots and amounts. `newRound` draws a shuffled deck from card-deck, reads the blinds from level-schedule, moves the button from the carry it returned last time (dead button, heads-up swap), deals, posts blinds (a short stack posts what it has) and finds the first actor. `phase` says who acts (with the settle plus the time to deal cards), or that the table deals the board by itself (3 s between cards), or that the round is over. `act` checks turn, stage and amount, handles short all-in raises (a short raise reopens the betting only when short raises add up to a full one) and goes on to the next actor, street, runout or settlement. `outcome` gives how long to hold the result (6 s when nobody showed down, 22 s a showdown, 27 s when a kicker decided, 42 s for a draw) and a history entry with the winners. `observation` is poker-strategy's DecisionInput; `records` are the hole cards for private-views; `legal` is all false when paused. The hand state machine (`createHoldem`: `newHand`, `legalActions`, `apply`, `autoAction`, `runoutStep`, `settle`, `voidHand`, `view`, `stacks`, `chipsInPlay`, `parseAction`, `attachLedger`) is the lower layer. Client side, `implementation/web|apple|android` hold the betting controls' amount model (step, quick amounts, nudging, all-in detection) with no screen code.

Facilities: `game-rules` (Play hold'em rounds for a turn engine: deal, phase, act, step, outcome, observation, records, views, legal moves, prompt).

## User inputs
The installer collects three optional settings (the recipe maps its rules file to them through rules-settings; players.maximum and betting.minimum_opening_bet_big_blinds are also read from the rules file when `deps.rules` is given):

- `seats` (integer; optional; default `9`)
- `minimumOpeningBetBigBlinds` (integer; optional; default `1`)
- `revealAtRunout` (boolean; optional; default `True`)

## Artefacts and dependencies
`component.json` maps every `implementation/` source into `components/holdem-rules/`:

- `implementation/android/src/main/java/ae/holdem/Betting.kt` -> `components/holdem-rules/android/src/main/java/ae/holdem/Betting.kt`
- `implementation/apple/Sources/Betting.swift` -> `components/holdem-rules/apple/Sources/Betting.swift`
- `implementation/server/holdem.ts` -> `components/holdem-rules/server/holdem.ts`
- `implementation/server/index.ts` -> `components/holdem-rules/server/index.ts`
- `implementation/server/pots.ts` -> `components/holdem-rules/server/pots.ts`
- `implementation/server/rules.ts` -> `components/holdem-rules/server/rules.ts`
- `implementation/server/types.ts` -> `components/holdem-rules/server/types.ts`
- `implementation/web/betting.ts` -> `components/holdem-rules/web/betting.ts`

Dependencies: none.
`tools.lock.json` pins verification tools: node 26.5, python3 3.12, swiftc 6.4, kotlinc 2.2, java 26.0. Licence: `Apache-2.0` (`LICENCE`, `NOTICE`).

## Provided interfaces
- `interfaces/game-rules.json` defines `game-rules` (ae/game-rules) version 1.0.0: an OpenRPC 1.3.2 document, one method per function (a member of a created object is `<Type>.<member>`), with parameter, result and data types as JSON Schema 2020-12 (`components.schemas`) and thrown errors under `errors`.

## Required interfaces
- `card-deck` (ae/card-deck) version 1.0.0, supplied by the recipe or application.
- `chip-ledger` (ae/chip-ledger) version 1.0.0, supplied by the recipe or application.
- `level-schedule` (ae/level-schedule) version 1.0.0, supplied by the recipe or application.
- `hand-ranking` (ae/hand-ranking) version 1.0.0, supplied by the recipe or application.
- `rules-settings` (ae/rules-settings) version 1.0.0, supplied by the recipe or application.

Each `interfaces/required-<id>.json` is a byte copy of the providing component's document.

## Integration
turn-engine calls this component for everything that happens inside a round and owns the room, clocks, players, pauses, computer players and the tournament around it. Binding: `ranking` is poker-hand-ranking's operations; `ledger` is chip-ledger's operations as they are (the ledger value travels through the engine, not through this component); `deck` is card-deck's `createShuffledDeck`; `schedule` is level-schedule's `levelInfo` bound to the table's Schedule (levels with values `{sb, bb}`); `rules` (optional) is rules-settings `value(path)` bound to the loaded rules. At the start of a round the engine calls `newRound` with the players still in, the tournament's ledger and its random source, and keeps the returned `carry`. It then reads `phase`: while acting it waits its decision clock and calls `act` with a `parseMove`d move (or `defaultMove` with `auto: true`); while auto it calls `step` after `autoDelayMs`; when over it reads `outcome` (hold time, result for clients, history entry for round-history). Every call that moves chips takes and returns the ledger; the ledger must be the one last returned (chips of players outside the round may change in between, for a rebuy). Clients get `publicView`, `legal` and the hole cards from `records` through private-views; computer players get `observation`, which is poker-strategy's DecisionInput. Web, Apple and Android controls call the amount model with the `bet` range from `legal`.

## Visual definition and connected examples
`visual/definition.json` maps its ports to the provided and required interfaces. `visual/examples/connected.json` connects the component to an illustrative application consumer. Both image formats and a text description are retained under `visual/output/`.

## Infrastructure
No deployed service, account or key. Pure functions; no clocks and no storage. A hand serialises to about a few kilobytes of JSON.

## Verification
`node --test tests/server.test.ts tests/rules.test.ts tests/web.test.ts` plays scripted hands (heads-up to showdown, three-handed fold-out, dead button and heads-up positions, minimum raise sizes and refused amounts, short all-in that does not reopen betting, short raises that add up to a full raise, side pots won by different players, uncalled chips returned, split pots with the odd chip clockwise from the button, folded chips above the last live layer, runout, voluntary show, view masking, void) and 60 random games of 2 to 9 players on the lower layer; `tests/rules.test.ts` plays eight scripted rounds through the interface only (with a fake deck, a fake schedule, and both the real chip ledger and an independent fake ledger) and asserts the same public facts after every step, the same result and positions as the lower layer, the hold time and the history entry; covers each of the 14 operations (pacing, codes, observation shape, records, prompt, paused legal, void, settings from the rules file, ledger mismatch, minimum unit, `sidePots` off and `first-listed` odd chip through the ledger, ledger call order) and 40 random games through the interface with the ledger balanced after every step. Chip-ledger, card-deck and poker-hand-ranking are copies of the current provider files under `tests/support/`. `python3 tests/native.py apple` compiles and runs the Swift amount model against the same fixture the web tests read. `python3 tests/native.py android` does the same with kotlinc and java (written, not run: kotlinc is not installed on the build machine). `authoring/differential-vs-recipe.ts` (not packaged) drove the recipe's engine.ts and the lower layer (with the real chip ledger) with the same decks and the same random legal actions over 540 hands and 4409 actions (112 refused identically) and compared stacks, bets, street, actor, bet to match, pots, winners, shown cards and positions after every action: no difference except the one hand where the recipe loses chips (see SOURCE.md).

- `node --test tests/server.test.ts tests/rules.test.ts tests/web.test.ts` (web, required-local; tools: node 26.5)
- `python3 tests/native.py apple` (apple, platform; tools: python3 3.12, swiftc 6.4)
- `python3 tests/native.py android` (android, platform; tools: python3 3.12, kotlinc 2.2, java 26.0)

## Scenarios and presentation
A nine-person tournament table; a heads-up final; a short stack all-in against two deeper stacks with a side pot; a split pot on a board play; a hand voided when the tournament is cancelled; a coach who stops at the runout to explain the pots.

## Updates and removal
A round in progress can be stored as the Round value. Removing the component removes the files under components/holdem-rules/; nothing is stored.
