// Whole-number chip accounting: stacks, bets, pots and side pots, odd chips. No game rules and no card
// knowledge: callers say who won each pot. Every function returns a new ledger; none changes its input.
import { createHash } from "node:crypto";

export type OddChipRule = "clockwise-after-button" | "first-listed";

export type LedgerSettings = {
  startingStack: number;
  // Smallest chip. Bets are multiples of it unless they put the whole stack in; odd chips are handed out in this size.
  minimumUnit: number;
  oddChipRule: OddChipRule;
  // true: one pot per contribution level. false: a single pot of everything wagered.
  sidePots: boolean;
  // Seats at the table, used to count clockwise from the button; default 9.
  seats?: number;
};

export type Stake = {
  id: string;
  seat: number;
  stack: number;
  // Chips in front of the player this round, and in total this hand.
  bet: number;
  totalIn: number;
  folded: boolean;
};

export type Ledger = { settings: Required<LedgerSettings>; stakes: Stake[]; issued: number };

export type Pot = { amount: number; eligible: string[] };

export type Award = { amount: number; eligible: string[]; winners: { id: string; amount: number }[] };

export const DEFAULT_SETTINGS: Required<LedgerSettings> = { startingStack: 5000, minimumUnit: 1, oddChipRule: "clockwise-after-button", sidePots: true, seats: 9 };

const isChips = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function validateSettings(settings: Partial<LedgerSettings> = {}): Required<LedgerSettings> {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!Number.isSafeInteger(s.startingStack) || s.startingStack < 1) throw new RangeError("startingStack must be a whole number of at least 1");
  if (!Number.isSafeInteger(s.minimumUnit) || s.minimumUnit < 1) throw new RangeError("minimumUnit must be a whole number of at least 1");
  if (s.oddChipRule !== "clockwise-after-button" && s.oddChipRule !== "first-listed") throw new RangeError(`unknown oddChipRule ${String(s.oddChipRule)}`);
  if (typeof s.sidePots !== "boolean") throw new TypeError("sidePots must be true or false");
  if (!Number.isSafeInteger(s.seats) || s.seats < 2) throw new RangeError("seats must be a whole number of at least 2");
  return s;
}

export function openLedger(entries: { id: string; seat: number }[], settings: Partial<LedgerSettings> = {}): Ledger {
  const s = validateSettings(settings);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error("duplicate player id");
  const stakes = entries.map((e) => ({ id: e.id, seat: e.seat, stack: s.startingStack, bet: 0, totalIn: 0, folded: false }));
  return { settings: s, stakes, issued: s.startingStack * stakes.length };
}

export function stakeOf(ledger: Ledger, id: string): Stake {
  const stake = ledger.stakes.find((x) => x.id === id);
  if (!stake) throw new Error(`unknown player ${id}`);
  return stake;
}

export function isAllIn(stake: Stake): boolean {
  return stake.stack === 0 && stake.totalIn > 0;
}

function change(ledger: Ledger, id: string, edit: (s: Stake) => Stake): Ledger {
  stakeOf(ledger, id);
  return { ...ledger, stakes: ledger.stakes.map((s) => (s.id === id ? edit({ ...s }) : { ...s })) };
}

// Move chips from the stack into the pot. A request larger than the stack puts the whole stack in (all-in).
// Throws unless `amount` is a whole number and a multiple of the minimum unit, or empties the stack.
export function commit(ledger: Ledger, id: string, amount: number): { ledger: Ledger; committed: number } {
  if (!isChips(amount)) throw new RangeError("amount must be a whole number of chips, 0 or more");
  const stake = stakeOf(ledger, id);
  const committed = Math.min(amount, stake.stack);
  if (committed < stake.stack && committed % ledger.settings.minimumUnit !== 0) throw new RangeError(`amount must be a multiple of ${ledger.settings.minimumUnit}`);
  const next = change(ledger, id, (s) => ({ ...s, stack: s.stack - committed, bet: s.bet + committed, totalIn: s.totalIn + committed }));
  return { ledger: next, committed };
}

// Put chips in until this player's round bet equals `to` (a raise "to", as the recipe's bet action). Returns what was added.
export function commitTo(ledger: Ledger, id: string, to: number): { ledger: Ledger; committed: number } {
  const stake = stakeOf(ledger, id);
  if (!isChips(to) || to < stake.bet) throw new RangeError("to must be a whole number of chips, not below the current bet");
  return commit(ledger, id, to - stake.bet);
}

export function fold(ledger: Ledger, id: string): Ledger {
  return change(ledger, id, (s) => ({ ...s, folded: true }));
}

// A betting round ended: chips stay in the pot but the per-round bets restart from zero.
export function endRound(ledger: Ledger): Ledger {
  return { ...ledger, stakes: ledger.stakes.map((s) => ({ ...s, bet: 0 })) };
}

// The largest wager nobody matched: only the top contributor can have one.
export function uncalledExcess(stakes: Stake[]): { id: string; amount: number } | null {
  const sorted = [...stakes].sort((a, b) => b.totalIn - a.totalIn);
  if (sorted.length < 2) return sorted.length === 1 && sorted[0].totalIn > 0 ? { id: sorted[0].id, amount: sorted[0].totalIn } : null;
  const excess = sorted[0].totalIn - sorted[1].totalIn;
  return excess > 0 ? { id: sorted[0].id, amount: excess } : null;
}

// Give the uncalled excess back to its owner before building pots.
export function returnUncalled(ledger: Ledger): { ledger: Ledger; returned: { id: string; amount: number } | null } {
  const excess = uncalledExcess(ledger.stakes);
  if (!excess) return { ledger, returned: null };
  const next = change(ledger, excess.id, (s) => ({ ...s, stack: s.stack + excess.amount, totalIn: s.totalIn - excess.amount, bet: Math.max(0, s.bet - excess.amount) }));
  return { ledger: next, returned: excess };
}

// One pot per distinct contribution level among players still in; folded chips count toward each layer and
// folded players are never eligible. Folded chips above the top live level go into the last pot, so no chip is
// left out. With sidePots off, one pot holds everything. Call after returnUncalled.
export function buildPots(ledger: Ledger): Pot[] {
  const players = ledger.stakes;
  const total = players.reduce((sum, p) => sum + p.totalIn, 0);
  const live = players.filter((p) => !p.folded && p.totalIn > 0).map((p) => p.id);
  if (!ledger.settings.sidePots) return total > 0 ? [{ amount: total, eligible: live }] : [];
  const levels = [...new Set(players.filter((p) => !p.folded && p.totalIn > 0).map((p) => p.totalIn))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) amount += Math.max(0, Math.min(p.totalIn, level) - prev);
    const eligible = players.filter((p) => !p.folded && p.totalIn >= level).map((p) => p.id);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  const rest = total - pots.reduce((sum, p) => sum + p.amount, 0);
  if (rest > 0) {
    if (pots.length) pots[pots.length - 1].amount += rest;
    else pots.push({ amount: rest, eligible: players.filter((p) => !p.folded).map((p) => p.id) });
  }
  return pots;
}

// The pots as shown mid-round: chips of earlier rounds and of folded players, without the bets still in
// front of players this round (those are shown as bets, not pot).
export function displayPots(ledger: Ledger): Pot[] {
  const collected = { ...ledger, stakes: ledger.stakes.map((s) => ({ ...s, totalIn: s.folded ? s.totalIn : s.totalIn - s.bet })) };
  return buildPots(collected);
}

// Distance clockwise from the button seat; the seat right after the button is 1 and the button itself is last.
export function clockwise(seat: number, button: number, seats = 9): number {
  return (((seat - button) % seats) + seats) % seats || seats;
}

// Split `amount` evenly in whole minimum units. Odd chips go one unit at a time to the winners in priority order.
export function splitAmount(amount: number, winnerIds: string[], unit = 1): { id: string; amount: number }[] {
  if (!isChips(amount)) throw new RangeError("amount must be a whole number of chips");
  if (winnerIds.length === 0) throw new Error("a pot needs at least one winner");
  if (!Number.isSafeInteger(unit) || unit < 1) throw new RangeError("unit must be a whole number of at least 1");
  const n = winnerIds.length;
  const share = Math.floor(Math.floor(amount / unit) / n) * unit;
  const shares = winnerIds.map((id) => ({ id, amount: share }));
  let odd = amount - share * n;
  for (let i = 0; odd > 0; i++) {
    const give = Math.min(unit, odd);
    shares[i % n].amount += give;
    odd -= give;
  }
  return shares;
}

// Award one pot among `winners` (the tied best hands, chosen by the caller). Odd chips follow the oddChipRule.
export function awardPot(ledger: Ledger, pot: Pot, winners: string[], button: number): Award {
  if (winners.length === 0) throw new Error("a pot needs at least one winner");
  for (const id of winners) if (!pot.eligible.includes(id)) throw new Error(`${id} is not eligible for this pot`);
  const ordered = ledger.settings.oddChipRule === "clockwise-after-button"
    ? [...winners].sort((a, b) => clockwise(stakeOf(ledger, a).seat, button, ledger.settings.seats) - clockwise(stakeOf(ledger, b).seat, button, ledger.settings.seats))
    : [...winners];
  return { ...pot, winners: splitAmount(pot.amount, ordered, ledger.settings.minimumUnit) };
}

// Pay the awards into the stacks and clear the hand's wagers. Everything wagered must be accounted for.
export function settle(ledger: Ledger, awards: Award[]): Ledger {
  const wagered = ledger.stakes.reduce((sum, s) => sum + s.totalIn, 0);
  const paid = awards.reduce((sum, a) => sum + a.winners.reduce((t, w) => t + w.amount, 0), 0);
  if (wagered !== paid) throw new Error(`awards pay ${paid} but ${wagered} chips were wagered`);
  const gains = new Map<string, number>();
  for (const a of awards) for (const w of a.winners) gains.set(w.id, (gains.get(w.id) ?? 0) + w.amount);
  for (const id of gains.keys()) stakeOf(ledger, id);
  return { ...ledger, stakes: ledger.stakes.map((s) => ({ ...s, stack: s.stack + (gains.get(s.id) ?? 0), bet: 0, totalIn: 0 })) };
}

// Cancel the hand: every wager goes back to its owner.
export function voidHand(ledger: Ledger): Ledger {
  return { ...ledger, stakes: ledger.stakes.map((s) => ({ ...s, stack: s.stack + s.totalIn, bet: 0, totalIn: 0 })) };
}

// Clear the folded marks for the next hand.
export function nextHand(ledger: Ledger): Ledger {
  return { ...ledger, stakes: ledger.stakes.map((s) => ({ ...s, folded: false })) };
}

// Add chips from outside (a rebuy or add-on); they count as issued.
export function credit(ledger: Ledger, id: string, amount: number): Ledger {
  if (!isChips(amount)) throw new RangeError("amount must be a whole number of chips");
  const next = change(ledger, id, (s) => ({ ...s, stack: s.stack + amount }));
  return { ...next, issued: ledger.issued + amount };
}

// Chips never appear or vanish: stacks plus live wagers equal the chips ever issued.
export function audit(ledger: Ledger): { inPlay: number; issued: number; balanced: boolean } {
  const inPlay = ledger.stakes.reduce((sum, s) => sum + s.stack + s.totalIn, 0);
  return { inPlay, issued: ledger.issued, balanced: inPlay === ledger.issued };
}

// ---- a book of chips across hands (the tournament's and the game's view) ----
// Players are added as chips are issued to them, so one ledger serves a whole game: a starting stack, a rebuy, then
// many hands. `openLedger` is the same thing started with everyone present at once.

// An empty ledger with nobody in it and nothing issued; `settings` as for `openLedger`.
export function create(settings: Partial<LedgerSettings> = {}): Ledger {
  return openLedger([], settings);
}

// New chips for a player: the first time adds them (seat = their place in the order they were added, until `setSeats`
// says otherwise), after that it adds to their stack. Counted as issued either way; `amount` is a whole number of 0 or more.
export function issue(ledger: Ledger, id: string, amount: number): Ledger {
  if (typeof id !== "string" || id === "") throw new TypeError("a player needs an id");
  if (!isChips(amount)) throw new RangeError("amount must be a whole number of chips, 0 or more");
  if (ledger.stakes.some((s) => s.id === id)) return credit(ledger, id, amount);
  return { ...ledger, stakes: [...ledger.stakes.map((s) => ({ ...s })), { id, seat: ledger.stakes.length, stack: amount, bet: 0, totalIn: 0, folded: false }], issued: ledger.issued + amount };
}

// The chips a player holds behind (not in a pot); 0 for someone who was never issued any.
export function balance(ledger: Ledger, id: string): number {
  return ledger.stakes.find((s) => s.id === id)?.stack ?? 0;
}

// Every chip ever issued.
export function issued(ledger: Ledger): number {
  return ledger.issued;
}

// Tell the ledger where each player sits (the odd chip goes clockwise from the button by seat). Throws for an unknown
// player, a seat that is not a whole number from 0, or two players on one seat.
export function setSeats(ledger: Ledger, seats: { id: string; seat: number }[]): Ledger {
  for (const e of seats) {
    stakeOf(ledger, e.id);
    if (!Number.isSafeInteger(e.seat) || e.seat < 0) throw new RangeError("a seat is a whole number from 0");
  }
  const seatOf = new Map(seats.map((e) => [e.id, e.seat]));
  const stakes = ledger.stakes.map((s) => ({ ...s, seat: seatOf.get(s.id) ?? s.seat }));
  if (new Set(stakes.map((s) => s.seat)).size !== stakes.length) throw new Error("two players cannot share a seat");
  return { ...ledger, stakes };
}

// A game that kept its own stacks hands them back: each listed player's stack becomes the given number and their wagers
// clear. Chips are not made or lost here: the listed players must hold the same total (stacks plus wagers) after as
// before, or it throws and nothing changes.
export function setStacks(ledger: Ledger, stacks: { [id: string]: number }): Ledger {
  const ids = Object.keys(stacks);
  let before = 0;
  let after = 0;
  for (const id of ids) {
    const stake = stakeOf(ledger, id);
    if (!isChips(stacks[id])) throw new RangeError("a stack must be a whole number of chips, 0 or more");
    before += stake.stack + stake.totalIn;
    after += stacks[id];
  }
  if (before !== after) throw new Error(`stacks hold ${after} chips but those players held ${before}`);
  return { ...ledger, stakes: ledger.stakes.map((s) => (s.id in stacks ? { ...s, stack: stacks[s.id], bet: 0, totalIn: 0 } : { ...s })) };
}

// The operations the tournament calls, with the settings bound (`create` builds the ledger the settings describe).
export type LedgerApi = {
  settings: Required<LedgerSettings>;
  create(): Ledger;
  issue(ledger: Ledger, id: string, amount: number): Ledger;
  balance(ledger: Ledger, id: string): number;
  issued(ledger: Ledger): number;
  setSeats(ledger: Ledger, seats: { id: string; seat: number }[]): Ledger;
};

export function createLedgerApi(settings: Partial<LedgerSettings> = {}): LedgerApi {
  const bound = validateSettings(settings);
  return { settings: bound, create: () => create(bound), issue, balance, issued, setSeats };
}

// ---- portable export and import (ndjson, one record per line, sha256 of each record) ----

const digest = (record: unknown) => createHash("sha256").update(JSON.stringify(record)).digest("hex");

export function exportLedger(ledger: Ledger): string {
  const lines = [{ kind: "ledger", record: { settings: ledger.settings, issued: ledger.issued } }, ...ledger.stakes.map((s) => ({ kind: "stake", record: s }))];
  return lines.map((l) => JSON.stringify({ ...l, sha256: digest(l.record) })).join("\n") + "\n";
}

export function importLedger(text: string): Ledger {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let header: { settings: Required<LedgerSettings>; issued: number } | null = null;
  const stakes: Stake[] = [];
  for (const [index, line] of lines.entries()) {
    const row = JSON.parse(line) as { kind: string; record: unknown; sha256: string };
    if (digest(row.record) !== row.sha256) throw new Error(`line ${index + 1}: checksum does not match`);
    if (row.kind === "ledger" && index === 0) header = row.record as typeof header;
    else if (row.kind === "stake" && header) stakes.push(row.record as Stake);
    else throw new Error(`line ${index + 1}: unexpected record ${row.kind}`);
  }
  if (!header) throw new Error("no ledger record");
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (!(key in header.settings)) throw new Error(`the ledger record has no ${key}`);
  const settings = validateSettings(header.settings);
  if (new Set(stakes.map((s) => s.id)).size !== stakes.length) throw new Error("duplicate player id");
  for (const s of stakes) if (![s.stack, s.bet, s.totalIn].every(isChips)) throw new Error(`stake ${s.id} has chips that are not whole numbers`);
  const ledger = { settings, stakes, issued: header.issued };
  if (!isChips(ledger.issued)) throw new Error("issued must be a whole number of chips");
  return ledger;
}
