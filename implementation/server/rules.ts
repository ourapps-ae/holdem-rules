// The game-rules interface a turn engine drives (ae/game-rules 1.0.0), for Texas hold'em: an adapter over
// the hand state machine in holdem.ts. A round is { hand, autoSteps }; chips live in the chip ledger the
// engine passes in and gets back on every call; the deck comes from card-deck, the blinds from
// level-schedule, optional table rules from rules-settings. Every operation is pure and JSON-safe.
import { createHoldem } from "./holdem.ts";
import {
  DEFAULT_SETTINGS,
  type Action, type Card, type Hand, type HandRankingLike, type HoldemSettings, type Ledger, type LedgerOperations, type Legal, type Positions,
  type PlayerHandView, type RulesError, type RulesView,
} from "./types.ts";

export type RoundPlayer = { id: string; seat: number };
export type MoveCode = "badRequest" | "notAllowed" | "badAmount" | "notYourTurn" | "wrongPhase";

export type Round = { hand: Hand; autoSteps: number };

export type RoundPhase = {
  stage: "acting" | "auto" | "over";
  actorId: string | null;
  settleMs: number;
  autoDelayMs: number | null;
  event: string | null;
  lastActorId: string | null;
};

export type RoundOutcome = {
  holdMs: number;
  voided: boolean;
  result: unknown;
  historyEntry: { winners: { playerId: string; amount: number }[] };
};

export type HiddenRecord = {
  ownerId: string | null;
  open: Record<string, unknown>;
  hidden: Record<string, unknown>;
  revealed: Record<string, true | number[]>;
};

export type Moved = { ok: true; round: Round; ledger: Ledger } | { ok: false; code: MoveCode };

// What poker-strategy's `decide` takes (ae/player-strategy 1.0.0 DecisionInput), without `style`.
export type DecisionInput = {
  hole: Card[];
  board: Card[];
  street: Hand["street"];
  stack: number;
  bet: number;
  seat: number;
  button: number;
  seats: number;
  sb: number;
  bb: number;
  currentBet: number;
  lastFullRaiseTo: number;
  pot: number;
  legal: { fold: boolean; check: boolean; call: number | null; bet: { min: number; max: number; opening: boolean } | null };
  opponents: { id: string; seat: number; bet: number; totalIn: number; lastAction: NonNullable<PlayerHandView["lastAction"]>["kind"] | null }[];
};

// The part of card-deck used: a shuffled deck whose draw pile is dealt from the end.
export type DeckOperations = {
  createShuffledDeck(settings: { decks: number; jokers: boolean }, source: { shuffle<T>(items: readonly T[]): T[] }): { draw: Card[]; burned: Card[] };
};

// level-schedule bound to a schedule: the values of a level; hold'em reads `sb` and `bb`.
export type BlindSchedule = { levelInfo(level: number): { values: Record<string, number> } };

// rules-settings bound to the loaded rules: the value at a path, or undefined.
export type RuleValues = { value(path: string): unknown };

// Milliseconds the table gives each moment of a hand. Defaults are the recipe's.
export type Pacing = {
  dealCardMs: number;
  runoutStepMs: number;
  handOverMs: number;
  showdownMs: number;
  showdownKickerMs: number;
  showdownDrawMs: number;
};

export const DEFAULT_PACING: Pacing = { dealCardMs: 340, runoutStepMs: 3000, handOverMs: 6000, showdownMs: 22000, showdownKickerMs: 27000, showdownDrawMs: 42000 };

export type GameRulesDeps = {
  ranking: HandRankingLike;
  ledger: LedgerOperations;
  deck: DeckOperations;
  schedule: BlindSchedule;
  rules?: RuleValues;
};

export type HoldemGameRules = ReturnType<typeof createGameRules>;

const NONE: Legal = { fold: false, check: false, call: null, bet: null, show: [] };
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

// Settings the house rules file gives (players.maximum, betting.minimum_opening_bet_big_blinds), when present.
function fromRules(rules: RuleValues | undefined): Partial<HoldemSettings> {
  const out: Partial<HoldemSettings> = {};
  const seats = rules?.value("players.maximum");
  const opening = rules?.value("betting.minimum_opening_bet_big_blinds");
  if (isInt(seats) && seats >= 2) out.seats = seats;
  if (isInt(opening) && opening >= 1) out.minimumOpeningBetBigBlinds = opening;
  return out;
}

export function createGameRules(deps: GameRulesDeps, partial: Partial<HoldemSettings> = {}, pacingPartial: Partial<Pacing> = {}) {
  const { ranking, ledger: L, deck, schedule } = deps;
  const settings: HoldemSettings = { ...DEFAULT_SETTINGS, ...fromRules(deps.rules), ...partial };
  const pacing: Pacing = { ...DEFAULT_PACING, ...pacingPartial };
  const lower = createHoldem({ ranking, ledger: L }, settings);

  const shuffler = (rng: () => number) => ({
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  });

  const validPositions = (x: unknown): x is Positions => {
    const p = x as Positions | null;
    return !!p && typeof p === "object" && isInt(p.button) && isInt(p.sbSeat) && isInt(p.bbSeat);
  };

  function newRound(input: { no: number; level: number; players: RoundPlayer[]; carry: unknown | null }, ledger: Ledger, rng: () => number): { round: Round; ledger: Ledger; carry: Positions } {
    const values = schedule.levelInfo(input.level).values;
    const sb = values.sb;
    const bb = values.bb;
    const players = input.players.map((p) => ({ id: p.id, seat: p.seat, stack: L.stakeOf(ledger, p.id).stack }));
    const started = lower.newHand({
      no: input.no, level: input.level, sb, bb, players, positions: validPositions(input.carry) ? input.carry : null,
      deck: deck.createShuffledDeck({ decks: 1, jokers: false }, shuffler(rng)).draw, rng, ledger,
    });
    if (!started.ok) throw new Error(`holdem-rules: cannot start round ${input.no}: ${started.code}`);
    return { round: { hand: started.value.hand, autoSteps: 0 }, ledger: started.value.hand.ledger, carry: started.value.positions };
  }

  function parseMove(input: unknown): { ok: true; move: Action; needsTurn: boolean } | { ok: false } {
    const parsed = lower.parseAction(input);
    return parsed.ok ? { ok: true, move: parsed.value, needsTurn: parsed.value.type !== "show" } : { ok: false };
  }

  const moveCode = (code: RulesError): MoveCode => (code === "unknownPlayer" || code === "notEnoughPlayers" ? "notAllowed" : code);

  function act(round: Round, ledger: Ledger, playerId: string, move: unknown, context: { auto: boolean }): Moved {
    const parsed = parseMove(move);
    if (!parsed.ok) return { ok: false, code: "badRequest" };
    const step = lower.apply(lower.attachLedger(round.hand, ledger), playerId, parsed.move, { auto: context.auto === true });
    if (!step.ok) return { ok: false, code: moveCode(step.code) };
    return { ok: true, round: { ...round, hand: step.hand }, ledger: step.hand.ledger };
  }

  const defaultMove = (round: Round, playerId: string): Action => lower.autoAction(round.hand, playerId);

  function step(round: Round, ledger: Ledger): { round: Round; ledger: Ledger } {
    const next = lower.runoutStep(lower.attachLedger(round.hand, ledger));
    if (!next.ok) throw new Error(`holdem-rules: step needs a hand in its runout (${next.code})`);
    return { round: { hand: next.hand, autoSteps: round.autoSteps + 1 }, ledger: next.hand.ledger };
  }

  // Time for the clients to deal two cards to each player; the first decision or runout card waits for it.
  const dealingMs = (h: Hand) => (h.event === "deal" ? 2 * h.players.length * pacing.dealCardMs : 0);

  function phase(round: Round, pace: { settleMs: number }): RoundPhase {
    const h = round.hand;
    if (h.stage === "over") return { stage: "over", actorId: null, settleMs: 0, autoDelayMs: null, event: null, lastActorId: null };
    if (h.stage === "runout") {
      // The first board card comes after the settle; the next ones one step apart.
      const delay = round.autoSteps === 0 ? pace.settleMs + dealingMs(h) : pacing.runoutStepMs;
      return { stage: "auto", actorId: null, settleMs: 0, autoDelayMs: delay, event: h.event, lastActorId: null };
    }
    return { stage: "acting", actorId: h.actorId, settleMs: pace.settleMs + dealingMs(h), autoDelayMs: null, event: h.event, lastActorId: h.lastActorId };
  }

  function outcome(round: Round): RoundOutcome | null {
    const h = round.hand;
    if (h.stage !== "over" || !h.result) return null;
    const r = h.result;
    const holdMs = r.voided ? 0 : r.uncontested ? pacing.handOverMs : r.showdown?.kind === "draw" ? pacing.showdownDrawMs : r.showdown?.kind === "kicker" ? pacing.showdownKickerMs : pacing.showdownMs;
    return {
      holdMs, voided: r.voided, result: { ...r, holdMs },
      historyEntry: { winners: r.pots.flatMap((a) => a.winners.map((w) => ({ playerId: w.playerId, amount: w.amount }))) },
    };
  }

  function voidRound(round: Round, ledger: Ledger): { round: Round; ledger: Ledger; outcome: RoundOutcome } {
    if (round.hand.stage === "over") return { round, ledger, outcome: outcome(round)! };
    const voided = lower.voidHand(lower.attachLedger(round.hand, ledger));
    if (!voided.ok) throw new Error(`holdem-rules: cannot void the round (${voided.code})`);
    const next: Round = { ...round, hand: voided.hand };
    return { round: next, ledger: voided.hand.ledger, outcome: outcome(next)! };
  }

  // What the player may know, shaped as poker-strategy's DecisionInput; null for someone not in the hand.
  function observation(round: Round, playerId: string): DecisionInput | null {
    const h = round.hand;
    const me = h.players.find((p) => p.id === playerId);
    if (!me) return null;
    const { show: _show, ...legal } = lower.legalActions(h, playerId);
    return {
      hole: [...me.cards], board: [...h.board], street: h.street, stack: me.stack, bet: me.bet, seat: me.seat, button: h.button, seats: settings.seats,
      sb: h.sb, bb: h.bb, currentBet: h.currentBet, lastFullRaiseTo: h.lastFullRaiseTo, pot: h.players.reduce((n, p) => n + p.totalIn, 0), legal,
      opponents: h.players.filter((p) => p.id !== playerId && !p.folded).map((p) => ({ id: p.id, seat: p.seat, bet: p.bet, totalIn: p.totalIn, lastAction: p.lastAction?.kind ?? null })),
    };
  }

  // One record per player: the two hole cards are hidden from everyone else until shown (indexes 0 and 1).
  function records(round: Round): HiddenRecord[] {
    return round.hand.players.map((p) => ({ ownerId: p.id, open: {}, hidden: { cards: [...p.cards] }, revealed: { cards: [...p.shown] } }));
  }

  // The view without the hidden cards (they come from `records`) and without `legal` (it comes from `legal`).
  function publicView(round: Round, viewerId: string | null, _options: Record<string, boolean> = {}): Omit<RulesView, "players" | "legal"> & { players: Omit<PlayerHandView, "cards">[] } {
    const v = lower.view(round.hand, viewerId);
    return { hand: v.hand, players: v.players.map(({ cards: _cards, ...rest }) => rest), result: v.result };
  }

  function legal(round: Round, viewerId: string, context: { paused: boolean }): Legal {
    return context.paused ? { ...NONE } : lower.legalActions(round.hand, viewerId);
  }

  function prompt(round: Round, viewerId: string | null): { key: string; args: (string | number)[]; text: string } | null {
    const h = round.hand;
    if (h.stage === "runout") return { key: "dealingBoard", args: [], text: "Dealing the rest of the board." };
    if (h.stage === "over" && h.result) {
      if (h.result.voided) return { key: "handVoided", args: [], text: "The hand was cancelled." };
      const won = viewerId === null ? 0 : h.result.pots.reduce((n, a) => n + a.winners.filter((w) => w.playerId === viewerId).reduce((m, w) => m + w.amount, 0), 0);
      if (won > 0) return { key: "youWon", args: [won], text: `You won ${won}.` };
      return h.result.uncontested ? { key: "othersFolded", args: [], text: "Everyone else folded." } : { key: "showdown", args: [], text: "Showdown." };
    }
    if (viewerId === null || h.actorId !== viewerId) return null;
    const toCall = lower.legalActions(h, viewerId).call;
    return toCall ? { key: "facingBet", args: [toCall], text: `Your turn: ${toCall} to call.` } : { key: "checkOrBet", args: [], text: "Your turn: check or bet." };
  }

  return {
    settings, pacing, lower,
    optionNames: [] as string[],
    newRound, phase, parseMove, act, defaultMove, step, outcome, voidRound, observation, records, publicView, legal, prompt,
  };
}
