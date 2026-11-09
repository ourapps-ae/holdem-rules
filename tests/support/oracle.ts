// Independent reference: score every five-card subset by brute force and keep the best.
// Shares no code with the implementation, so agreement is evidence, not repetition.
const RANKS = "23456789TJQKA";

function fiveScore(cards: string[]): number[] {
  const ranks = cards.map((c) => RANKS.indexOf(c[0])).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const distinct = [...new Set(ranks)];
  let high = -1;
  if (distinct.length === 5) {
    if (ranks[0] - ranks[4] === 4) high = ranks[0];
    else if (ranks.join() === "12,3,2,1,0") high = 3;
  }
  const groups = new Map<number, number>();
  for (const r of ranks) groups.set(r, (groups.get(r) ?? 0) + 1);
  const ordered = [...groups.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = ordered.map((g) => g[1]).join("");
  const byGroup = ordered.map((g) => g[0]);
  if (high >= 0 && flush) return [8, high];
  if (shape === "41") return [7, ...byGroup];
  if (shape === "32") return [6, ...byGroup];
  if (flush) return [5, ...ranks];
  if (high >= 0) return [4, high];
  if (shape === "311") return [3, ...byGroup];
  if (shape === "221") return [2, ...byGroup];
  if (shape === "2111") return [1, ...byGroup];
  return [0, ...ranks];
}

export function oracleBest(cards: string[]): number[] {
  let best: number[] = [-1];
  const n = cards.length;
  const pick = (start: number, chosen: string[]) => {
    if (chosen.length === 5) {
      const s = fiveScore(chosen);
      for (let i = 0; i < Math.max(s.length, best.length); i++) {
        if ((s[i] ?? 0) !== (best[i] ?? 0)) {
          if ((s[i] ?? 0) > (best[i] ?? 0)) best = s;
          break;
        }
      }
      return;
    }
    for (let i = start; i < n; i++) pick(i + 1, [...chosen, cards[i]]);
  };
  pick(0, []);
  return best;
}

export function oracleCompare(a: string[], b: string[]): number {
  const x = oracleBest(a);
  const y = oracleBest(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}

// Small deterministic generator for repeatable random hands.
export function seededRandom(seed: number): () => number {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
