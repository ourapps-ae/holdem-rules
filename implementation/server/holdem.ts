// Texas hold'em hand logic: button, blinds, betting rounds, minimum raises, short all-ins,
// side pots, showdown and runout. No clocks, no seats joining or leaving, no randomness of its own:
// a turn engine calls these operations (through the adapter in rules.ts) and owns time, players and
// the tournament around the hand. Chips move through the chip-ledger operations; the hand keeps a
// ledger value and mirrors each player's stack, wagers and folded mark into its own players.
import { awardPot, showdownOf } from "./pots.ts";
import {
  DEFAULT_SETTINGS,
  type Action, type Award, type GameRules, type Hand, type HandPlayer, type HandRankingLike, type HoldemSettings, type Ledger, type LedgerOperations, type Legal,
  type NewHandArguments, type PlayerHandView, type Positions, type Result, type RulesError, type RulesView, type Step,
} from "./types.ts";

const fail = (code: RulesError): { ok: false; code: RulesError } => ({ ok: false, code });
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

export function createHoldem(deps: { ranking: HandRankingLike; ledger: LedgerOperations }, partial: Partial<HoldemSettings> = {}): GameRules {
  const settings: HoldemSettings = { ...DEFAULT_SETTINGS, ...partial };
  if (!isInt(settings.seats) || settings.seats < 2) throw new RangeError("seats is an integer of at least 2");
  if (!isInt(settings.minimumOpeningBetBigBlinds) || settings.minimumOpeningBetBigBlinds < 1) throw new RangeError("minimumOpeningBetBigBlinds is an integer of at least 1");
  const { ranking, ledger: L } = deps;
  const SEATS = settings.seats;

  const dist = (seat: number, from: number) => ((seat - from) % SEATS + SEATS) % SEATS || SEATS;
  const live = (h: Hand) => h.players.filter((p) => !p.folded);
  const find = (h: Hand, id: string) => h.players.find((p) => p.id === id);

  // Copy each player's chips and folded mark from the ledger; the ledger is the record.
  function mirror(h: Hand): void {
    for (const p of h.players) {
      const s = L.stakeOf(h.ledger, p.id);
      p.stack = s.stack;
      p.bet = s.bet;
      p.totalIn = s.totalIn;
      p.folded = s.folded;
    }
  }

  function sameChips(h: Hand, ledger: Ledger): string | null {
    for (const p of h.players) {
      const s = ledger.stakes.find((x) => x.id === p.id);
      if (!s) return `${p.id} is not in the ledger`;
      if (s.stack !== p.stack || s.bet !== p.bet || s.totalIn !== p.totalIn || s.folded !== p.folded) return `${p.id} has different chips in the ledger`;
    }
    return null;
  }

  function attachLedger(hand: Hand, ledger: Ledger): Hand {
    const problem = sameChips(hand, ledger);
    if (problem) throw new Error(`holdem-rules: the ledger does not match the hand: ${problem}`);
    return { ...hand, ledger };
  }

  function parseAction(input: unknown): Result<Action> {
    const b = input as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return fail("badRequest");
    switch (b.type) {
      case "fold": case "check": case "call":
        return { ok: true, value: { type: b.type } };
      case "bet":
        return typeof b.to === "number" ? { ok: true, value: { type: "bet", to: b.to } } : fail("badRequest");
      case "show":
        return Array.isArray(b.cards) && b.cards.every((c) => c === 0 || c === 1) ? { ok: true, value: { type: "show", cards: b.cards as number[] } } : fail("badRequest");
      default:
        return fail("badRequest");
    }
  }

  // ---- positions and the deal ----

  function nextInSeat(seatList: number[], fromSeat: number): number {
    for (let i = 1; i <= SEATS; i++) {
      const s = (fromSeat + i) % SEATS;
      if (seatList.includes(s)) return s;
    }
    return fromSeat;
  }

  function newHand(args: NewHandArguments): Result<{ hand: Hand; positions: Positions }> {
    const { players, sb, bb } = args;
    if (players.length < 2) return fail("notEnoughPlayers");
    const seatList = players.map((p) => p.seat).sort((a, b) => a - b);
    if (new Set(seatList).size !== seatList.length || new Set(players.map((p) => p.id)).size !== players.length) return fail("badRequest");
    if (!isInt(sb) || !isInt(bb) || sb < 1 || bb < sb) return fail("badRequest");
    if (!players.every((p) => isInt(p.seat) && p.seat >= 0 && p.seat < SEATS && isInt(p.stack) && p.stack > 0)) return fail("badRequest");
    if (args.deck.length < players.length * 2 + 5) return fail("badRequest");
    const ins = [...players].sort((a, b) => a.seat - b.seat);

    let ledger: Ledger;
    if (args.ledger) {
      const given = args.ledger;
      for (const p of ins) {
        const s = given.stakes.find((x) => x.id === p.id);
        if (!s || s.stack !== p.stack || s.bet !== 0 || s.totalIn !== 0) return fail("badRequest");
      }
      if (given.settings.seats < SEATS) return fail("badRequest");
      const seatOf = new Map(ins.map((p) => [p.id, p.seat]));
      ledger = L.nextHand({ ...given, stakes: given.stakes.map((s) => (seatOf.has(s.id) ? { ...s, seat: seatOf.get(s.id)! } : s)) });
    } else {
      const settings = L.validateSettings({ ...args.potRules, seats: SEATS });
      ledger = { settings, stakes: ins.map((p) => ({ id: p.id, seat: p.seat, stack: p.stack, bet: 0, totalIn: 0, folded: false })), issued: ins.reduce((n, p) => n + p.stack, 0) };
    }
    const unit = ledger.settings.minimumUnit;
    if (sb % unit !== 0 || bb % unit !== 0) return fail("badRequest");

    let button: number;
    let sbSeat: number;
    let bbSeat: number;
    if (!args.positions) {
      const b = ins[Math.floor(args.rng() * ins.length)].seat;
      if (ins.length === 2) {
        button = sbSeat = b;
        bbSeat = nextInSeat(seatList, b);
      } else {
        button = b;
        sbSeat = nextInSeat(seatList, b);
        bbSeat = nextInSeat(seatList, sbSeat);
      }
    } else if (ins.length === 2) {
      // Heads-up: the button posts the small blind and nobody takes the big blind twice running.
      bbSeat = nextInSeat(seatList, args.positions.bbSeat);
      button = sbSeat = ins.find((p) => p.seat !== bbSeat)!.seat;
    } else {
      // Dead button: the big blind moves to the next player, the other positions trail by seat.
      bbSeat = nextInSeat(seatList, args.positions.bbSeat);
      sbSeat = args.positions.bbSeat;
      button = args.positions.sbSeat;
    }

    const deck = [...args.deck];
    const hp: HandPlayer[] = ins.map((p) => ({
      id: p.id, seat: p.seat, stack: p.stack, startStack: p.stack, cards: [deck.pop()!, deck.pop()!],
      bet: 0, totalIn: 0, folded: false, allIn: false, acted: false, canRaise: true, lastAction: null, shown: [],
    }));
    const h: Hand = {
      no: args.no, level: args.level, sb, bb, button, sbSeat, bbSeat, players: hp, deck, board: [], street: "preflop", stage: "betting",
      actorId: null, event: "deal", lastActorId: null, currentBet: bb, lastFullRaise: bb, lastFullRaiseTo: bb,
      chips: hp.reduce((s, p) => s + p.stack, 0), result: null, ledger,
    };
    const sbP = hp.find((p) => p.seat === sbSeat);
    if (sbP) postBlind(h, sbP, sb);
    postBlind(h, hp.find((p) => p.seat === bbSeat)!, bb);
    afterAction(h, bbSeat);
    return { ok: true, value: { hand: h, positions: { button, sbSeat, bbSeat } } };
  }

  function commitChips(h: Hand, p: HandPlayer, amount: number): void {
    h.ledger = L.commit(h.ledger, p.id, amount).ledger;
    mirror(h);
    if (p.stack === 0) p.allIn = true;
  }

  function postBlind(h: Hand, p: HandPlayer, amount: number): void {
    const a = Math.min(amount, p.stack);
    commitChips(h, p, a);
    p.lastAction = { kind: p.allIn ? "allIn" : "blind", amount: a, auto: false };
  }

  // ---- legal actions ----

  function legalActions(h: Hand, playerId: string): Legal {
    const none: Legal = { fold: false, check: false, call: null, bet: null, show: [] };
    const me = find(h, playerId);
    if (!me) return none;
    if (h.stage === "over") return me.cards.length === 2 && !h.result?.voided ? { ...none, show: [0, 1].filter((i) => !me.shown.includes(i)) } : none;
    if (h.stage !== "betting" || h.actorId !== me.id) return none;
    const toCall = h.currentBet - me.bet;
    const max = me.bet + me.stack;
    const legal: Legal = { fold: true, check: toCall === 0, call: toCall > 0 ? Math.min(toCall, me.stack) : null, bet: null, show: [] };
    if (me.canRaise && max > h.currentBet) {
      const minFull = h.currentBet + h.lastFullRaise;
      legal.bet = { min: Math.min(minFull, max), max, opening: h.currentBet === 0 };
    }
    return legal;
  }

  // ---- applying an action ----

  function apply(hand: Hand, playerId: string, action: Action, options: { auto?: boolean } = {}): Step {
    const h = structuredClone(hand);
    const p = find(h, playerId);
    if (!p) return fail("unknownPlayer");
    if (action.type === "show") {
      if (h.stage !== "over") return fail("wrongPhase");
      if (h.result?.voided || p.cards.length !== 2) return fail("notAllowed");
      if (!Array.isArray(action.cards) || action.cards.some((c) => c !== 0 && c !== 1)) return fail("badRequest");
      p.shown = [...new Set([...p.shown, ...action.cards])].sort();
      return { ok: true, hand: h };
    }
    if (h.stage !== "betting") return fail("wrongPhase");
    if (h.actorId !== playerId) return fail("notYourTurn");
    const code = act(h, p, action, options.auto === true);
    if (code) return fail(code);
    afterAction(h, p.seat);
    return { ok: true, hand: h };
  }

  // Apply one betting action for the actor. Returns an error code or null.
  function act(h: Hand, p: HandPlayer, action: Action, auto: boolean): RulesError | null {
    const toCall = h.currentBet - p.bet;
    const others = h.players.filter((q) => q.id !== p.id && !q.folded && !q.allIn);
    switch (action.type) {
      case "fold":
        h.ledger = L.fold(h.ledger, p.id);
        p.folded = true;
        p.lastAction = { kind: "fold", amount: null, auto };
        break;
      case "check":
        if (toCall > 0) return "notAllowed";
        p.lastAction = { kind: "check", amount: null, auto };
        break;
      case "call": {
        if (toCall <= 0) return "notAllowed";
        const a = Math.min(toCall, p.stack);
        commitChips(h, p, a);
        p.lastAction = { kind: p.allIn ? "allIn" : "call", amount: a, auto };
        break;
      }
      case "bet": {
        const to = action.to;
        const max = p.bet + p.stack;
        if (!Number.isInteger(to) || to <= h.currentBet || to > max) return "badAmount";
        if (!p.canRaise) return "notAllowed";
        if (to - p.bet !== p.stack && (to - p.bet) % h.ledger.settings.minimumUnit !== 0) return "badAmount";
        const full = to - h.currentBet >= h.lastFullRaise;
        if (!full && to !== max) return "badAmount";
        const opening = h.currentBet === 0;
        commitChips(h, p, to - p.bet);
        if (full) {
          h.lastFullRaise = to - h.currentBet;
          h.lastFullRaiseTo = to;
          h.currentBet = to;
          for (const q of others) {
            q.acted = false;
            q.canRaise = true;
          }
        } else {
          // Short all-in: it reopens the betting only once the short raises add up to a full one.
          h.currentBet = to;
          if (to - h.lastFullRaiseTo >= h.lastFullRaise) {
            h.lastFullRaiseTo = to;
            for (const q of others) {
              q.acted = false;
              q.canRaise = true;
            }
          } else {
            for (const q of others) if (q.acted) q.canRaise = false;
          }
        }
        p.lastAction = { kind: p.allIn ? "allIn" : opening ? "bet" : "raise", amount: to, auto };
        break;
      }
      default:
        return "badRequest";
    }
    p.acted = true;
    p.canRaise = false;
    h.event = "action";
    h.lastActorId = p.id;
    return null;
  }

  // After any action: next player, next street, runout or settlement.
  function afterAction(h: Hand, fromSeat: number): void {
    const inHand = live(h);
    if (inHand.length === 1) {
      settleHand(h);
      return;
    }
    const active = inHand.filter((p) => !p.allIn);
    const pending = active.filter((p) => !p.acted || p.bet < h.currentBet);
    if (pending.length > 0) {
      h.actorId = [...pending].sort((a, b) => dist(a.seat, fromSeat) - dist(b.seat, fromSeat))[0].id;
      return;
    }
    if (active.length <= 1) {
      startRunout(h);
      return;
    }
    if (h.street === "river") {
      settleHand(h);
      return;
    }
    beginStreet(h);
  }

  function beginStreet(h: Hand): void {
    dealNext(h);
    h.event = h.street as "flop" | "turn" | "river";
    h.lastActorId = null;
    h.ledger = L.endRound(h.ledger);
    mirror(h);
    for (const p of h.players) {
      p.acted = false;
      p.canRaise = !p.folded && !p.allIn;
    }
    h.currentBet = 0;
    h.lastFullRaise = h.bb * settings.minimumOpeningBetBigBlinds;
    h.lastFullRaiseTo = 0;
    h.actorId = null;
    afterAction(h, h.button);
  }

  function dealNext(h: Hand): void {
    if (h.board.length === 0) {
      h.board.push(h.deck.pop()!, h.deck.pop()!, h.deck.pop()!);
      h.street = "flop";
    } else if (h.board.length < 5) {
      h.board.push(h.deck.pop()!);
      h.street = h.board.length === 4 ? "turn" : "river";
    }
  }

  // Nobody can bet any more and at least two hands are live: show them, then deal the rest.
  function startRunout(h: Hand): void {
    if (settings.revealAtRunout) for (const p of live(h)) p.shown = [0, 1];
    h.actorId = null;
    if (h.board.length === 5) {
      settleHand(h);
      return;
    }
    h.stage = "runout";
  }

  function runoutStep(hand: Hand): Step {
    if (hand.stage !== "runout") return fail("wrongPhase");
    const h = structuredClone(hand);
    dealNext(h);
    h.event = h.street as "flop" | "turn" | "river";
    if (h.board.length === 5) settleHand(h);
    return { ok: true, hand: h };
  }

  function settle(hand: Hand): Step {
    if (hand.stage === "over") return { ok: true, hand };
    if (hand.stage !== "runout") return fail("wrongPhase");
    const h = structuredClone(hand);
    while (h.board.length < 5) dealNext(h);
    h.event = "river";
    settleHand(h);
    return { ok: true, hand: h };
  }

  function settleHand(h: Hand): void {
    h.ledger = L.returnUncalled(h.ledger).ledger;
    const uncontested = h.players.filter((p) => !p.folded).length === 1;
    if (!uncontested) for (const p of h.players) if (!p.folded) p.shown = [0, 1];
    // Folded chips above the top live layer belong to the last pot (the ledger builds the pots that way).
    const awards: Award[] = L.buildPots(h.ledger).map((pot) => awardPot(ranking, L, h.ledger, pot, h.players, h.board, h.button));
    h.ledger = L.settle(h.ledger, awards.map((a) => ({ amount: a.amount, eligible: a.eligible, winners: a.winners.map((w) => ({ id: w.playerId, amount: w.amount })) })));
    mirror(h);
    const showdown = uncontested ? null : showdownOf(ranking, awards[0], h.players, h.board);
    h.result = { no: h.no, board: [...h.board], pots: awards, uncontested, voided: false, showdown };
    h.stage = "over";
    h.actorId = null;
  }

  function voidHand(hand: Hand): Step {
    if (hand.stage === "over") return fail("wrongPhase");
    const h = structuredClone(hand);
    h.ledger = L.voidHand(h.ledger);
    mirror(h);
    h.result = { no: h.no, board: [...h.board], pots: [], uncontested: false, voided: true, showdown: null };
    h.stage = "over";
    h.actorId = null;
    return { ok: true, hand: h };
  }

  function autoAction(h: Hand, playerId: string): Action {
    const p = find(h, playerId);
    return p && h.currentBet - p.bet > 0 ? { type: "fold" } : { type: "check" };
  }

  // ---- views ----

  function view(h: Hand, viewerId: string | null): RulesView {
    const pots = h.stage === "over" && h.result ? h.result.pots.map((a) => ({ amount: a.amount, eligible: a.eligible })) : L.displayPots(h.ledger);
    const players: PlayerHandView[] = h.players.map((p) => {
      const visible = p.id === viewerId;
      const allShown = p.cards.length === 2 && p.shown.length === 2;
      const ev = allShown && h.board.length >= 3 ? ranking.evaluate([...p.cards, ...h.board]) : null;
      return {
        id: p.id, seat: p.seat, stack: p.stack,
        // A folded player's chips go straight into the pot.
        bet: p.folded ? 0 : p.bet,
        totalIn: p.totalIn, folded: p.folded, allIn: p.allIn,
        cards: p.cards.map((c, i) => (visible || p.shown.includes(i) ? c : null)),
        lastAction: p.lastAction,
        hand: ev ? { category: ev.category, ranks: ev.ranks, name: ev.name } : null,
      };
    });
    return {
      hand: {
        no: h.no, level: h.level, sb: h.sb, bb: h.bb, button: h.button, sbSeat: h.sbSeat, bbSeat: h.bbSeat, street: h.street, stage: h.stage,
        board: [...h.board], pots, potTotal: h.players.reduce((s, p) => s + p.totalIn, 0), currentBet: h.currentBet, actorId: h.actorId,
        event: h.stage === "betting" ? h.event : null, lastActorId: h.stage === "betting" ? h.lastActorId : null,
      },
      players,
      legal: viewerId === null ? { fold: false, check: false, call: null, bet: null, show: [] } : legalActions(h, viewerId),
      result: h.result,
    };
  }

  return {
    settings,
    parseAction,
    newHand,
    legalActions,
    apply,
    autoAction,
    runoutStep,
    isHandOver: (h) => h.stage === "over",
    settle,
    voidHand,
    view,
    attachLedger,
    stacks: (h) => Object.fromEntries(h.players.map((p) => [p.id, p.stack])),
    chipsInPlay: (h) => h.players.reduce((s, p) => s + p.stack + p.totalIn, 0),
  };
}


// The rules createHoldem returns.
export type Holdem = ReturnType<typeof createHoldem>;
