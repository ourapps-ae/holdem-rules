// Types of the game-rules interface for Texas hold'em (ae/game-rules 1.0.0).
// A hand is plain data: serialise it, store it, clone it. Every operation returns a new hand.

// Two characters: rank 2-9, T, J, Q, K, A then suit c, d, h, s. Example "As", "Td".
export type Card = string;

export type Street = "preflop" | "flop" | "turn" | "river";

// betting: someone may act; runout: nobody can bet any more, the board is being dealt; over: settled.
export type Stage = "betting" | "runout" | "over";

// The betting action types. `bet` carries the total for the street, so it covers opening bets,
// raises and all-in raises; `show` turns your own cards face up after the hand.
export type Action =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "bet"; to: number }
  | { type: "show"; cards: number[] };

export type ActionType = Action["type"];

export const ACTION_TYPES: readonly ActionType[] = ["fold", "check", "call", "bet", "show"];

export type RulesError = "badRequest" | "wrongPhase" | "notYourTurn" | "notAllowed" | "badAmount" | "unknownPlayer" | "notEnoughPlayers";

export type Result<T> = { ok: true; value: T } | { ok: false; code: RulesError };

// An operation that returns the next state of the hand, or the reason it was refused.
export type Step = { ok: true; hand: Hand } | { ok: false; code: RulesError };

export type LastAction = {
  kind: "blind" | "fold" | "check" | "call" | "bet" | "raise" | "allIn";
  amount: number | null;
  // True when the engine acted for an absent or timed-out player.
  auto: boolean;
};

export type SeatedPlayer = { id: string; seat: number; stack: number };

export type Positions = { button: number; sbSeat: number; bbSeat: number };

export type HandPlayer = {
  id: string;
  seat: number;
  stack: number;
  startStack: number;
  cards: Card[];
  // Chips in front of the player this street, and in total this hand.
  bet: number;
  totalIn: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  canRaise: boolean;
  lastAction: LastAction | null;
  // Which of the two cards are face up.
  shown: number[];
};

export type Contributor = { id: string; seat: number; totalIn: number; folded: boolean; cards: Card[] };

export type Pot = { amount: number; eligible: string[] };

export type Award = { amount: number; eligible: string[]; winners: { playerId: string; amount: number; handName: string | null }[] };

// ---- the chip-ledger interface as hold'em uses it (ae/chip-ledger 1.0.0) ----

export type OddChipRule = "clockwise-after-button" | "first-listed";

export type LedgerSettings = { startingStack: number; minimumUnit: number; oddChipRule: OddChipRule; sidePots: boolean; seats: number };

export type Stake = { id: string; seat: number; stack: number; bet: number; totalIn: number; folded: boolean };

export type Ledger = { settings: LedgerSettings; stakes: Stake[]; issued: number };

export type LedgerPot = { amount: number; eligible: string[] };

export type LedgerAward = { amount: number; eligible: string[]; winners: { id: string; amount: number }[] };

// The operations of the chip-ledger interface that the hand calls; the ledger component provides them.
export type LedgerOperations = {
  validateSettings(settings?: Partial<LedgerSettings>): LedgerSettings;
  stakeOf(ledger: Ledger, id: string): Stake;
  commit(ledger: Ledger, id: string, amount: number): { ledger: Ledger; committed: number };
  fold(ledger: Ledger, id: string): Ledger;
  endRound(ledger: Ledger): Ledger;
  returnUncalled(ledger: Ledger): { ledger: Ledger; returned: { id: string; amount: number } | null };
  buildPots(ledger: Ledger): LedgerPot[];
  displayPots(ledger: Ledger): LedgerPot[];
  awardPot(ledger: Ledger, pot: LedgerPot, winners: string[], button: number): LedgerAward;
  settle(ledger: Ledger, awards: LedgerAward[]): Ledger;
  voidHand(ledger: Ledger): Ledger;
  nextHand(ledger: Ledger): Ledger;
};

// What a hand needs from the ledger's settings; the rest of the ledger's settings are its own.
export type PotRules = Partial<Pick<LedgerSettings, "sidePots" | "oddChipRule" | "minimumUnit">>;

// How the main pot was won when cards were shown: on the combination, on a kicker (a card outside
// the combination), or a draw (the pot shared). `kickers` per hand: how many of its kickers to show
// after its combination.
export type Showdown = { kind: "combination" | "kicker" | "draw"; winners: string[]; kickers: Record<string, number> };

export type HandOutcome = {
  no: number;
  board: Card[];
  pots: Award[];
  uncontested: boolean;
  voided: boolean;
  showdown: Showdown | null;
};

export type Hand = {
  no: number;
  level: number;
  sb: number;
  bb: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  players: HandPlayer[];
  // Cards still to deal, dealt from the end. Never sent to a client.
  deck: Card[];
  board: Card[];
  street: Street;
  stage: Stage;
  actorId: string | null;
  // What the table is settling on: the deal, a new street or the last action (by lastActorId).
  event: "deal" | "flop" | "turn" | "river" | "action" | null;
  lastActorId: string | null;
  currentBet: number;
  lastFullRaise: number;
  lastFullRaiseTo: number;
  // Total chips in the hand at the start; constant until the hand is over.
  chips: number;
  result: HandOutcome | null;
  // Where every chip is: stacks, wagers and folded marks. The fields `stack`, `bet`, `totalIn` and
  // `folded` of the players mirror it. It holds every player of the ledger it came from.
  ledger: Ledger;
};

export type NewHandArguments = {
  no: number;
  level: number;
  sb: number;
  bb: number;
  // Players with chips, any order.
  players: SeatedPlayer[];
  // Positions of the previous hand, or null for the first hand (the button is then drawn with `rng`).
  positions: Positions | null;
  // A shuffled deck from card-deck, dealt from the end.
  deck: Card[];
  rng: () => number;
  // The ledger the chips move through. Without one the hand opens its own from `players` (the ledger's
  // pot settings come from `potRules`, else the chip-ledger defaults). With one, every player's stack must
  // match the ledger and nobody may have a wager open.
  ledger?: Ledger;
  potRules?: PotRules;
};

// What the player to act may do. `bet` is the allowed range of the street total; max is all-in.
export type Legal = {
  fold: boolean;
  check: boolean;
  call: number | null;
  bet: { min: number; max: number; opening: boolean } | null;
  // Cards that may still be turned face up after the hand (indexes 0 and 1).
  show: number[];
};

export type PotView = { amount: number; eligible: string[] };

export type HandView = {
  no: number;
  level: number;
  sb: number;
  bb: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  street: Street;
  stage: Stage;
  board: Card[];
  pots: PotView[];
  // Chips wagered this hand that are not yet in a pot, for display as the live pot.
  potTotal: number;
  currentBet: number;
  actorId: string | null;
  event: Hand["event"];
  lastActorId: string | null;
};

export type PlayerHandView = {
  id: string;
  seat: number;
  stack: number;
  bet: number;
  totalIn: number;
  folded: boolean;
  allIn: boolean;
  // null entries are face down; your own cards and shown cards carry the card.
  cards: (Card | null)[];
  lastAction: LastAction | null;
  // Best five-card hand once both cards are shown and the board has three or more cards.
  hand: { category: string; ranks: number[]; name: string } | null;
};

export type RulesView = {
  hand: HandView;
  players: PlayerHandView[];
  legal: Legal;
  result: HandOutcome | null;
};

export type HoldemSettings = {
  // Seats at the table: the odd chip of a split pot goes clockwise from the button around this many.
  seats: number;
  // Minimum opening bet and minimum raise at the start of a street, in big blinds.
  minimumOpeningBetBigBlinds: number;
  // Turn every live hand face up as soon as nobody can bet any more.
  revealAtRunout: boolean;
};

export const DEFAULT_SETTINGS: HoldemSettings = { seats: 9, minimumOpeningBetBigBlinds: 1, revealAtRunout: true };

// The rules interface a turn engine drives.
export type GameRules = {
  settings: HoldemSettings;
  // The wire message of a player's action, checked and typed. Not for lifecycle messages.
  parseAction(input: unknown): Result<Action>;
  // Deal, post the blinds and find who acts first. Needs at least two players with chips.
  newHand(args: NewHandArguments): Result<{ hand: Hand; positions: Positions }>;
  legalActions(hand: Hand, playerId: string): Legal;
  // One player's action: a betting action on their turn, or a voluntary show after the hand.
  // May end the street, start the runout or settle the hand.
  apply(hand: Hand, playerId: string, action: Action, options?: { auto?: boolean }): Step;
  // What the engine plays for a player who timed out: check if free, otherwise fold.
  autoAction(hand: Hand, playerId: string): Action;
  // Stage runout: deal the next board cards (flop, turn or river); settles after the river.
  runoutStep(hand: Hand): Step;
  isHandOver(hand: Hand): boolean;
  // Finish a runout at once: deal what is left of the board and settle. Idempotent once over.
  settle(hand: Hand): Step;
  // End the hand without a winner and give every contribution back (a cancelled game).
  voidHand(hand: Hand): Step;
  // What a viewer may see: the hand, each player's state, the viewer's legal actions, the result.
  // `viewerId` null is a display that shows only what is face up.
  view(hand: Hand, viewerId: string | null): RulesView;
  // Chips each player holds behind after the hand (the same as the ledger's stacks).
  stacks(hand: Hand): Record<string, number>;
  // The hand with this ledger as its chip record. Throws unless every player of the hand has the same
  // stack, wager and folded mark in it.
  attachLedger(hand: Hand, ledger: Ledger): Hand;
  // Stacks plus wagers; equals `hand.chips` at every point of a hand.
  chipsInPlay(hand: Hand): number;
};

// The part of the hand-ranking interface that hold'em reads (ae/hand-ranking 1.0.0).
export type HandRankingLike = {
  evaluate(cards: Card[]): { score: number; category: string; ranks: number[]; name: string };
  compareEvaluations(a: { score: number; category: string; ranks: number[]; name: string }, b: { score: number; category: string; ranks: number[]; name: string }): { result: -1 | 0 | 1; decidedBy: string; kickersRead: number };
  winners(contenders: { id: string; cards: Card[] }[], board: Card[]): { ids: string[]; evaluations: Record<string, { score: number; category: string; ranks: number[]; name: string }> };
};
