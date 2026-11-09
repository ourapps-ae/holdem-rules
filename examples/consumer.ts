// What a turn engine does with the rules, without any game around them: deal, play every street by
// checking or calling, deal out the board and read the stacks. No clocks, no players joining.
import { createHoldem, type HandRankingLike, type LedgerOperations, type SeatedPlayer } from "../implementation/server/index.ts";

export function playCheckDown(deps: { ranking: HandRankingLike; ledger: LedgerOperations }, players: SeatedPlayer[], deck: string[], sb: number, bb: number) {
  const rules = createHoldem(deps);
  const started = rules.newHand({ no: 1, level: 1, sb, bb, players, positions: null, deck, rng: () => 0 });
  if (!started.ok) throw new Error(started.code);
  let hand = started.value.hand;
  while (!rules.isHandOver(hand)) {
    if (hand.stage === "runout") {
      const step = rules.runoutStep(hand);
      if (!step.ok) throw new Error(step.code);
      hand = step.hand;
      continue;
    }
    const actor = hand.actorId!;
    const legal = rules.legalActions(hand, actor);
    const step = rules.apply(hand, actor, legal.check ? { type: "check" } : { type: "call" });
    if (!step.ok) throw new Error(step.code);
    hand = step.hand;
  }
  return { stacks: rules.stacks(hand), result: hand.result! };
}

// The same, through the game-rules interface a turn engine calls: the engine's ledger goes in and comes
// back with every move; here a plain loop plays the engine, checking or calling until the round is over.
import type { HoldemGameRules, Ledger, RoundOutcome, RoundPlayer } from "../implementation/server/index.ts";

export function playRound(rules: HoldemGameRules, ledger: Ledger, players: RoundPlayer[], rng: () => number): { ledger: Ledger; outcome: RoundOutcome; moves: number } {
  const started = rules.newRound({ no: 1, level: 1, players, carry: null }, ledger, rng);
  let { round, ledger: chips } = { round: started.round, ledger: started.ledger };
  let moves = 0;
  for (let phase = rules.phase(round, { settleMs: 4000 }); phase.stage !== "over"; phase = rules.phase(round, { settleMs: 4000 })) {
    if (phase.stage === "auto") {
      ({ round, ledger: chips } = rules.step(round, chips));
      continue;
    }
    const legal = rules.legal(round, phase.actorId!, { paused: false });
    const moved = rules.act(round, chips, phase.actorId!, legal.check ? { type: "check" } : { type: "call" }, { auto: false });
    if (!moved.ok) throw new Error(moved.code);
    ({ round, ledger: chips } = moved);
    moves++;
  }
  return { ledger: chips, outcome: rules.outcome(round)!, moves };
}
