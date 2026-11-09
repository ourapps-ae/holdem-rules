// Who wins a pot and how the main pot was won. Building pots and splitting them (layers, folded chips,
// uncalled excess, odd chips) is the chip ledger's job; this file only reads the cards.
import type { Award, Card, HandRankingLike, LedgerAward, LedgerOperations, LedgerPot, Ledger, Showdown } from "./types.ts";

type Holder = { id: string; cards: Card[] };

// Pay one pot to its best hands through the ledger's odd-chip rule. A pot with one eligible player is
// that player's (no hand name).
export function awardPot(ranking: HandRankingLike, ledgerOps: LedgerOperations, ledger: Ledger, pot: LedgerPot, holders: Holder[], board: Card[], button: number): Award {
  const byId = new Map(holders.map((p) => [p.id, p]));
  let ids: string[];
  let names: Record<string, string | null> = {};
  if (pot.eligible.length === 1) ids = [pot.eligible[0]];
  else {
    const found = ranking.winners(pot.eligible.map((id) => ({ id, cards: byId.get(id)!.cards })), board);
    ids = found.ids;
    names = Object.fromEntries(Object.entries(found.evaluations).map(([id, ev]) => [id, ev.name]));
  }
  const paid: LedgerAward = ledgerOps.awardPot(ledger, pot, ids, button);
  return { amount: paid.amount, eligible: paid.eligible, winners: paid.winners.map((w) => ({ playerId: w.id, amount: w.amount, handName: names[w.id] ?? null })) };
}

// How the main pot was won at a showdown, for showing it: on the combination, on a kicker (a
// card outside the combination), or a draw (the pot shared). `kickers` says, per hand, how many
// of its kickers to show after its combination: the winner's up to the one that decided it, a
// loser's up to where it fell behind; every kicker of a drawing hand.
export function showdownOf(ranking: HandRankingLike, main: Award | undefined, players: Holder[], board: Card[]): Showdown | null {
  if (!main || main.eligible.length < 2) return null;
  const byId = new Map(players.map((p) => [p.id, p]));
  const evs = new Map(main.eligible.map((id) => [id, ranking.evaluate([...byId.get(id)!.cards, ...board])]));
  const winners = main.winners.map((w) => w.playerId);
  const top = evs.get(winners[0])!;
  const kickers: Record<string, number> = {};
  let deciding = 0;
  for (const [id, ev] of evs) {
    if (winners.includes(id)) continue;
    const cmp = ranking.compareEvaluations(top, ev);
    if (cmp.decidedBy !== "kicker") continue; // beaten on the category or the combination itself
    kickers[id] = cmp.kickersRead;
    deciding = Math.max(deciding, cmp.kickersRead);
  }
  if (winners.length > 1) {
    for (const id of winners) kickers[id] = 5;
    return { kind: "draw", winners, kickers };
  }
  if (deciding > 0) {
    kickers[winners[0]] = deciding;
    return { kind: "kicker", winners, kickers };
  }
  return { kind: "combination", winners, kickers };
}
