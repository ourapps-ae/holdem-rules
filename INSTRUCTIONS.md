# Hold'em rules instructions

## For the agent
Select this component for any Texas hold'em recipe. Connect hand-ranking to poker-hand-ranking, card-deck to card-deck, chip-ledger to chip-ledger, level-schedule to level-schedule (levels with values {sb, bb}) and rules-settings to rules-settings; connect the provided game-rules interface to turn-engine's game-rules input. Map the recipe's answers to `seats`, `minimumOpeningBetBigBlinds` and `revealAtRunout`; the chip ledger's `sidePots`, `oddChipRule` and `minimumUnit` settings are set on chip-ledger and decide the pots. Include the web, Apple and Android amount model files in the clients that show a bet slider.

- Select package `ourapps-ae/holdem-rules` version `0.4.1`.
- Settings to configure:
  - `seats` (integer; optional; default `9`)
  - `minimumOpeningBetBigBlinds` (integer; optional; default `1`)
  - `revealAtRunout` (boolean; optional; default `True`)
- Connect the provided `game-rules` (ae/game-rules 1.0.0) to the consumer that needs it.
- Supply `card-deck` (ae/card-deck 1.0.0) from the component that provides it.
- Supply `chip-ledger` (ae/chip-ledger 1.0.0) from the component that provides it.
- Supply `level-schedule` (ae/level-schedule 1.0.0) from the component that provides it.
- Supply `hand-ranking` (ae/hand-ranking 1.0.0) from the component that provides it.
- Supply `rules-settings` (ae/rules-settings 1.0.0) from the component that provides it.
- No accounts or keys are needed.

## For the developer
No accounts or keys. Defaults match the recipe's house rules (nine seats, minimum opening bet one big blind, hands turned up when nobody can bet). Build the object with `createGameRules({ranking, ledger, deck, schedule, rules}, settings, pacing)` from `implementation/server/index.ts`: `ledger` is the chip-ledger operations object, `deck` has `createShuffledDeck`, `schedule` has `levelInfo(level)` bound to your Schedule, `rules` (optional) has `value(path)`. Blind levels, starting stacks, timing, rebuys and the player count belong to level-schedule, chip-ledger, game-clock and the engine. Hold times and card pacing are the `pacing` argument. To add a game other than hold'em, implement the 14 `GameRules.<name>` methods of `interfaces/game-rules.json` (an OpenRPC 1.3.2 document with JSON Schema 2020-12 types).

## How to check
From the component directory:

- `node --test tests/server.test.ts tests/rules.test.ts tests/web.test.ts` (web, required-local; tools: node 26.5)
- `python3 tests/native.py apple` (apple, platform; tools: python3 3.12, swiftc 6.4)
- `python3 tests/native.py android` (android, platform; tools: python3 3.12, kotlinc 2.2, java 26.0)
- `python3 -m aepm review <digest> --store STORE --policy POLICY --trusted --allow-network` checks an archive fetched with `python3 -m aepm fetch ourapps-ae/holdem-rules@VERSION --store STORE --from https://ourapps.app` and runs its suites.
