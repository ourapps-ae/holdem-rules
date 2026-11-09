// Best five-card poker hand out of five to seven cards. Higher score wins; equal scores tie.
import { standardCodes, type Card, type CardCodes } from "./codes.ts";

export const CATEGORY = ["highCard", "pair", "twoPair", "threeOfAKind", "straight", "flush", "fullHouse", "fourOfAKind", "straightFlush"] as const;
export type Category = (typeof CATEGORY)[number];

// `ranks` holds the ranks that decide the hand, most important first: the combination's ranks,
// then the kickers. 0 is a two, 12 an ace; a five-high straight has ranks [3].
export type Evaluation = { score: number; category: Category; ranks: number[]; name: string };

// How a comparison was decided.
export type Comparison = {
  result: -1 | 0 | 1;
  decidedBy: "category" | "combination" | "kicker" | "tie";
  // Kickers read, counting the one that decided it (kicker only; 0 otherwise).
  kickersRead: number;
};

export type Contender = { id: string; cards: Card[] };

export type HandRanking = {
  codes: CardCodes;
  evaluate(cards: Card[]): Evaluation;
  // Positive when a beats b, negative when b beats a, zero for a tie.
  compare(a: Card[], b: Card[]): number;
  compareEvaluations(a: Evaluation, b: Evaluation): Comparison;
  // Ids holding the best hand among the contenders with the shared board; several on a tie.
  winners(contenders: Contender[], board: Card[]): { ids: string[]; evaluations: Record<string, Evaluation> };
  // Ranks that make the category's combination; the rest of `ranks` are kickers.
  combinationSize(category: Category): number;
  kickers(evaluation: Evaluation): number[];
  // The five cards an evaluation used, and the cards that are the pattern itself within them.
  bestFive(cards: Card[], evaluation: Evaluation): Card[];
  patternCards(five: Card[], evaluation: Evaluation): Card[];
  describe(category: number | Category, ranks: number[]): string;
};

const COMBINATION_RANKS: Record<Category, number> = { highCard: 1, pair: 1, twoPair: 2, threeOfAKind: 1, straight: 1, flush: 5, fullHouse: 2, fourOfAKind: 1, straightFlush: 1 };

// Score packs the category above five rank nibbles, most significant first.
function pack(category: number, ranks: number[]): number {
  let s = category;
  for (let i = 0; i < 5; i++) s = s * 16 + (ranks[i] ?? 0);
  return s;
}

// Highest rank that tops a run of five. Bit r+1 holds rank r; bit 0 holds the ace as a low card.
function straightHigh(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1);
  for (let high = 12; high >= 3; high--) {
    const run = 0b11111 << (high - 3);
    if ((m & run) === run) return high;
  }
  return -1;
}

// The n highest ranks present, skipping the excluded ones (each rank once).
function topRanks(counts: number[], n: number, exclude: number[]): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < n; r--) if (counts[r] > 0 && !exclude.includes(r)) out.push(r);
  return out;
}

export function createHandRanking(codes: CardCodes = standardCodes): HandRanking {
  const { rankOf, suitOf } = codes;

  function describe(category: number | Category, r: number[]): string {
    const c = typeof category === "number" ? category : CATEGORY.indexOf(category);
    const high = (x: number) => `${codes.rankNames[x]} high`;
    switch (c) {
      case 8:
        return r[0] === 12 ? "Royal flush" : `Straight flush, ${high(r[0])}`;
      case 7:
        return `Four of a kind, ${codes.rankPlurals[r[0]]}`;
      case 6:
        return `Full house, ${codes.rankPlurals[r[0]]} full of ${codes.rankPlurals[r[1]]}`;
      case 5:
        return `Flush, ${high(r[0])}`;
      case 4:
        return `Straight, ${high(r[0])}`;
      case 3:
        return `Three of a kind, ${codes.rankPlurals[r[0]]}`;
      case 2:
        return `Two pair, ${codes.rankPlurals[r[0]]} and ${codes.rankPlurals[r[1]]}`;
      case 1:
        return `Pair of ${codes.rankPlurals[r[0]]}`;
      default:
        return `${codes.rankNames[r[0]][0].toUpperCase()}${codes.rankNames[r[0]].slice(1)} high`;
    }
  }

  function done(category: number, ranks: number[]): Evaluation {
    return { score: pack(category, ranks), category: CATEGORY[category], ranks, name: describe(category, ranks) };
  }

  function evaluate(cards: Card[]): Evaluation {
    if (cards.length < 5 || cards.length > 7) throw new RangeError("a hand is five to seven cards");
    const counts = new Array<number>(13).fill(0);
    const suits: number[][] = [[], [], [], []];
    let mask = 0;
    for (const c of cards) {
      const r = rankOf(c);
      const s = suitOf(c);
      if (r < 0 || s < 0) throw new RangeError(`not a card code: ${c}`);
      counts[r]++;
      suits[s].push(r);
      mask |= 1 << r;
    }

    const flushRanks = suits.find((s) => s.length >= 5)?.sort((a, b) => b - a) ?? null;
    if (flushRanks) {
      let fm = 0;
      for (const r of flushRanks) fm |= 1 << r;
      const sf = straightHigh(fm);
      if (sf >= 0) return done(8, [sf]);
    }

    const byCount = (n: number) => counts.map((c, r) => (c === n ? r : -1)).filter((r) => r >= 0).sort((a, b) => b - a);
    const quads = byCount(4);
    if (quads.length) return done(7, [quads[0], ...topRanks(counts, 1, [quads[0]])]);
    const trips = byCount(3);
    const pairs = byCount(2);
    if (trips.length && (trips.length > 1 || pairs.length)) {
      const low = trips.length > 1 ? trips[1] : pairs[0];
      return done(6, [trips[0], low]);
    }
    if (flushRanks) return done(5, flushRanks.slice(0, 5));
    const st = straightHigh(mask);
    if (st >= 0) return done(4, [st]);
    if (trips.length) return done(3, [trips[0], ...topRanks(counts, 2, [trips[0]])]);
    if (pairs.length >= 2) return done(2, [pairs[0], pairs[1], ...topRanks(counts, 1, [pairs[0], pairs[1]])]);
    if (pairs.length === 1) return done(1, [pairs[0], ...topRanks(counts, 3, [pairs[0]])]);
    return done(0, topRanks(counts, 5, []));
  }

  const compare = (a: Card[], b: Card[]) => evaluate(a).score - evaluate(b).score;

  // Where two hands first differ: category, the combination itself, or a kicker.
  function compareEvaluations(a: Evaluation, b: Evaluation): Comparison {
    if (a.score === b.score) return { result: 0, decidedBy: "tie", kickersRead: 0 };
    const result = a.score > b.score ? 1 : -1;
    if (a.category !== b.category) return { result, decidedBy: "category", kickersRead: 0 };
    const core = COMBINATION_RANKS[a.category];
    let same = 0;
    while (same < a.ranks.length && a.ranks[same] === b.ranks[same]) same++;
    if (same < core) return { result, decidedBy: "combination", kickersRead: 0 };
    return { result, decidedBy: "kicker", kickersRead: same - core + 1 };
  }

  function winners(contenders: Contender[], board: Card[]) {
    const evaluations: Record<string, Evaluation> = {};
    let best = -1;
    for (const c of contenders) {
      const ev = evaluate([...c.cards, ...board]);
      evaluations[c.id] = ev;
      if (ev.score > best) best = ev.score;
    }
    return { ids: contenders.filter((c) => evaluations[c.id].score === best).map((c) => c.id), evaluations };
  }

  function straightCards(cards: Card[], high: number): Card[] {
    const out: Card[] = [];
    for (let i = 0; i < 5; i++) {
      const r = high - i < 0 ? 12 : high - i;
      const c = cards.find((x) => rankOf(x) === r);
      if (c) out.push(c);
    }
    return out;
  }

  // Flush and straight flush take the suited cards, a straight one card of each rank, the rest the
  // ranked cards then kickers.
  function bestFive(cards: Card[], ev: Evaluation): Card[] {
    const byRank = (r: number) => cards.filter((c) => rankOf(c) === r);
    if (ev.category === "flush" || ev.category === "straightFlush") {
      const suit = [0, 1, 2, 3].find((s) => cards.filter((c) => suitOf(c) === s).length >= 5)!;
      const suited = cards.filter((c) => suitOf(c) === suit);
      if (ev.category === "flush") return suited.sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 5);
      return straightCards(suited, ev.ranks[0]);
    }
    if (ev.category === "straight") return straightCards(cards, ev.ranks[0]);
    const out: Card[] = [];
    const need = ev.category === "fourOfAKind" ? [4, 1] : ev.category === "fullHouse" ? [3, 2] : ev.category === "threeOfAKind" ? [3, 1, 1] : ev.category === "twoPair" ? [2, 2, 1] : ev.category === "pair" ? [2, 1, 1, 1] : [1, 1, 1, 1, 1];
    ev.ranks.forEach((r, i) => out.push(...byRank(r).slice(0, need[i] ?? 1)));
    return out.slice(0, 5);
  }

  // The cards that are the pattern itself (the pair, the trips, the flush...), as opposed to the
  // kickers that complete the five.
  function patternCards(five: Card[], ev: Evaluation): Card[] {
    switch (ev.category) {
      case "pair":
      case "threeOfAKind":
      case "fourOfAKind":
        return five.filter((c) => rankOf(c) === ev.ranks[0]);
      case "twoPair":
        return five.filter((c) => rankOf(c) === ev.ranks[0] || rankOf(c) === ev.ranks[1]);
      case "highCard":
        return five.filter((c) => rankOf(c) === ev.ranks[0]).slice(0, 1);
      default:
        return five;
    }
  }

  return {
    codes,
    evaluate,
    compare,
    compareEvaluations,
    winners,
    combinationSize: (category) => COMBINATION_RANKS[category],
    kickers: (ev) => ev.ranks.slice(COMBINATION_RANKS[ev.category]),
    bestFive,
    patternCards,
    describe,
  };
}

// Ready to use with the standard card codes.
export const handRanking: HandRanking = createHandRanking();
