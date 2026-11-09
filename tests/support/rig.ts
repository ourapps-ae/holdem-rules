// Test helpers: a hand-ranking bound from the pinned copy, and a deck rigged to deal known cards.
import { handRanking } from "./hand-ranking/ranking.ts";
import { standardCodes } from "./hand-ranking/codes.ts";

import * as ledgerOperations from "./chip-ledger/ledger.ts";
import * as cardDeck from "./card-deck/deck.ts";

export { handRanking, standardCodes, ledgerOperations, cardDeck };

// Dependencies of createHoldem, with the real (pinned) ranking and chip ledger.
export const deps = { ranking: handRanking, ledger: ledgerOperations };

// Cards are dealt from the end of the deck, two to each player in seat order, then flop, turn, river.
export function rig(holes: string[], board: string[]): string[] {
  const sequence = [...holes.flatMap((h) => h.split(" ")), ...board.flatMap((b) => b.split(" "))];
  if (new Set(sequence).size !== sequence.length) throw new Error("duplicate card in rig");
  const rest = standardCodes.fullDeck().filter((c) => !sequence.includes(c));
  return [...rest, ...[...sequence].reverse()];
}

export function mulberry(seed: number): () => number {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(rng: () => number): string[] {
  const deck = standardCodes.fullDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
