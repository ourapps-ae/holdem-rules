// The betting controls' model: what the amount chooser may offer and what its buttons mean.
// Pure functions over the `bet` range from `legalActions`; no screen code.

export type BetRange = { min: number; max: number; opening: boolean };

export type Rounding = "nearest" | "down";

// The unit a slider and quick amounts move in: the small blind, at least 1.
export function stepFor(smallBlind: number | null | undefined): number {
  return Math.max(1, smallBlind ?? 1);
}

// An amount rounded to the step and held inside the allowed range. Browsers round to the nearest
// step; the native apps round down.
export function snap(amount: number, range: BetRange, step: number, rounding: Rounding = "nearest"): number {
  const units = rounding === "nearest" ? Math.round(amount / step) : Math.floor(amount / step);
  return Math.min(range.max, Math.max(range.min, units * step));
}

export type Presets = { min: number; halfPot: number; pot: number; allIn: number };

// The quick amounts: the smallest allowed, half the pot, the pot (each after calling) and all-in.
// `pot` is every chip wagered this hand, `toCall` what calling costs, `currentBet` the bet to match.
export function presets(input: { range: BetRange; pot: number; toCall: number | null; currentBet: number; smallBlind: number | null | undefined; rounding?: Rounding }): Presets {
  const { range, pot, currentBet } = input;
  const call = input.toCall ?? 0;
  const step = stepFor(input.smallBlind);
  const round = input.rounding ?? "nearest";
  return {
    min: range.min,
    halfPot: snap((pot + call) / 2 + currentBet, range, step, round),
    pot: snap(pot + call + currentBet, range, step, round),
    allIn: range.max,
  };
}

// Move an amount by a number of chips, held inside the range and safe against overflow.
export function adjust(amount: number, by: number, range: BetRange): number {
  const next = amount + by;
  if (!Number.isSafeInteger(next)) return by > 0 ? range.max : range.min;
  return Math.min(range.max, Math.max(range.min, next));
}

// Whether a typed amount may be sent: a whole number inside the range.
export function isAllowedAmount(amount: number, range: BetRange): boolean {
  return Number.isInteger(amount) && amount >= range.min && amount <= range.max;
}

// Whether a slider has anything to slide over.
export function canSlide(range: BetRange, step: number): boolean {
  return range.max - range.min >= step;
}

export type BetKind = "allIn" | "bet" | "raise";

// What the confirm button says for a chosen total: all-in at the maximum, otherwise bet or raise.
export function betKind(to: number, range: BetRange): BetKind {
  return to === range.max ? "allIn" : range.opening ? "bet" : "raise";
}

// Whether calling puts the player all-in.
export function callIsAllIn(call: number, stack: number): boolean {
  return call >= stack;
}

// Whether a bet to this total puts the player all-in (stack and bet are what is behind and in front now).
export function betIsAllIn(to: number, stack: number, bet: number): boolean {
  return to >= stack + bet;
}
