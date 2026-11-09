// The game-rules interface a turn engine drives (createGameRules), exercised through its own operations only,
// with fakes for the deck, the schedule and the rules file, and both a fake and the real chip ledger.
import assert from "node:assert/strict";
import test from "node:test";
import { createGameRules, createHoldem, type Action, type Ledger, type LedgerOperations, type Pacing, type Round } from "../implementation/server/index.ts";
import { cardDeck, handRanking, ledgerOperations as realLedger, mulberry, rig } from "./support/rig.ts";
import { oracleCompare } from "./support/oracle.ts";
import { playRound } from "../examples/consumer.ts";

const first = () => 0;
const ids = "ABCDEFGHI";

// ---- fakes ----

// An independent, plain implementation of the chip-ledger operations the rules call.
function fakeLedger(): LedgerOperations {
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const clockwise = (seat: number, button: number, seats: number) => (((seat - button) % seats) + seats) % seats || seats;
  const edit = (l: Ledger, f: (stakes: Ledger["stakes"]) => void): Ledger => {
    const c = clone(l);
    f(c.stakes);
    return c;
  };
  const stake = (l: Ledger, id: string) => {
    const s = l.stakes.find((x) => x.id === id);
    if (!s) throw new Error(`unknown player ${id}`);
    return s;
  };
  const buildPots = (l: Ledger) => {
    const total = l.stakes.reduce((n, s) => n + s.totalIn, 0);
    const live = l.stakes.filter((s) => !s.folded && s.totalIn > 0);
    if (!l.settings.sidePots) return total > 0 ? [{ amount: total, eligible: live.map((s) => s.id) }] : [];
    const pots: { amount: number; eligible: string[] }[] = [];
    let previous = 0;
    for (const level of [...new Set(live.map((s) => s.totalIn))].sort((a, b) => a - b)) {
      const amount = l.stakes.reduce((n, s) => n + Math.max(0, Math.min(s.totalIn, level) - previous), 0);
      pots.push({ amount, eligible: live.filter((s) => s.totalIn >= level).map((s) => s.id) });
      previous = level;
    }
    const rest = total - pots.reduce((n, p) => n + p.amount, 0);
    if (rest > 0) {
      if (pots.length) pots[pots.length - 1].amount += rest;
      else pots.push({ amount: rest, eligible: l.stakes.filter((s) => !s.folded).map((s) => s.id) });
    }
    return pots;
  };
  return {
    validateSettings: (s = {}) => ({ startingStack: 5000, minimumUnit: 1, oddChipRule: "clockwise-after-button", sidePots: true, seats: 9, ...s }),
    stakeOf: stake,
    commit(l, id, amount) {
      const committed = Math.min(amount, stake(l, id).stack);
      return { committed, ledger: edit(l, (ss) => { const s = ss.find((x) => x.id === id)!; s.stack -= committed; s.bet += committed; s.totalIn += committed; }) };
    },
    fold: (l, id) => edit(l, (ss) => { ss.find((x) => x.id === id)!.folded = true; }),
    endRound: (l) => edit(l, (ss) => ss.forEach((s) => { s.bet = 0; })),
    returnUncalled(l) {
      const sorted = [...l.stakes].sort((a, b) => b.totalIn - a.totalIn);
      const amount = sorted[0].totalIn - (sorted[1]?.totalIn ?? 0);
      if (amount <= 0) return { ledger: l, returned: null };
      return { returned: { id: sorted[0].id, amount }, ledger: edit(l, (ss) => { const s = ss.find((x) => x.id === sorted[0].id)!; s.stack += amount; s.totalIn -= amount; s.bet = Math.max(0, s.bet - amount); }) };
    },
    buildPots,
    displayPots: (l) => buildPots(edit(l, (ss) => ss.forEach((s) => { if (!s.folded) s.totalIn -= s.bet; }))),
    awardPot(l, pot, winners, button) {
      const order = l.settings.oddChipRule === "first-listed" ? winners : [...winners].sort((a, b) => clockwise(stake(l, a).seat, button, l.settings.seats) - clockwise(stake(l, b).seat, button, l.settings.seats));
      const share = Math.floor(pot.amount / order.length);
      let odd = pot.amount - share * order.length;
      return { ...pot, winners: order.map((id) => ({ id, amount: share + (odd-- > 0 ? 1 : 0) })) };
    },
    settle(l, awards) {
      const wagered = l.stakes.reduce((n, s) => n + s.totalIn, 0);
      const paid = awards.reduce((n, a) => n + a.winners.reduce((m, w) => m + w.amount, 0), 0);
      if (wagered !== paid) throw new Error(`awards pay ${paid} but ${wagered} chips were wagered`);
      return edit(l, (ss) => { for (const a of awards) for (const w of a.winners) ss.find((x) => x.id === w.id)!.stack += w.amount; ss.forEach((s) => { s.bet = 0; s.totalIn = 0; }); });
    },
    voidHand: (l) => edit(l, (ss) => ss.forEach((s) => { s.stack += s.totalIn; s.bet = 0; s.totalIn = 0; })),
    nextHand: (l) => edit(l, (ss) => ss.forEach((s) => { s.folded = false; })),
  };
}

// Records every call, then forwards it to the real ledger.
function recording(real: LedgerOperations) {
  const calls: string[] = [];
  const ops = Object.fromEntries(Object.entries(real).map(([name, f]) => [name, (...args: unknown[]) => { calls.push(name); return (f as (...a: unknown[]) => unknown)(...args); }])) as LedgerOperations;
  return { ops, calls };
}

function fakeDeck(draw: string[]) {
  const asked: { decks: number; jokers: boolean }[] = [];
  return {
    asked,
    deck: {
      createShuffledDeck(settings: { decks: number; jokers: boolean }, source: { shuffle<T>(items: readonly T[]): T[] }) {
        assert.equal(typeof source.shuffle, "function");
        asked.push(settings);
        return { draw: [...draw], burned: [] };
      },
    },
  };
}

const levels = (sb = 25, bb = 50) => ({ levelInfo: (level: number) => ({ values: { sb: sb * level, bb: bb * level } }) });

type Stakes = { id: string; seat?: number; stack: number }[];
const open = (ops: LedgerOperations, stacks: number[], settings: Parameters<LedgerOperations["validateSettings"]>[0] = {}): Ledger => {
  const settled = ops.validateSettings(settings);
  return { settings: settled, stakes: stacks.map((stack, i) => ({ id: ids[i], seat: i, stack, bet: 0, totalIn: 0, folded: false })), issued: stacks.reduce((a, b) => a + b, 0) };
};

function makeRules(ops: LedgerOperations, holes: string[], board: string[], extra: { sb?: number; bb?: number; settings?: Parameters<typeof createGameRules>[1]; pacing?: Partial<Pacing>; rules?: { value(path: string): unknown } } = {}) {
  const deck = fakeDeck(rig(holes, board));
  const rules = createGameRules({ ranking: handRanking, ledger: ops, deck: deck.deck, schedule: levels(extra.sb ?? 25, extra.bb ?? 50), rules: extra.rules }, extra.settings, extra.pacing);
  return { rules, deck };
}

const seatsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: ids[i], seat: i }));
const stacksOf = (l: Ledger) => Object.fromEntries(l.stakes.map((s) => [s.id, s.stack]));

// What the table shows, whichever interface produced it: only facts that are public.
function shown(view: { hand: Record<string, unknown>; players: { [k: string]: unknown }[] }) {
  return { hand: view.hand, players: view.players.map(({ cards: _c, ...rest }) => rest) };
}

// ---- one script, played through the lower layer's hand operations and through the game-rules interface ----

type Script = { name: string; stacks: number[]; holes: string[]; board: string[]; sb?: number; bb?: number; moves: (Action | "step" | "rest")[]; expectStacks: Record<string, number>; kind?: string; pots?: number[]; holdMs: number };

const scripts: Script[] = [
  { name: "heads-up to a showdown", stacks: [1000, 1000], holes: ["As Ks", "Qc Qd"], board: ["2c 7d 9h", "Jd", "3s"], holdMs: 22000, kind: "combination", pots: [1100],
    moves: [{ type: "call" }, { type: "check" }, { type: "check" }, { type: "bet", to: 100 }, { type: "bet", to: 300 }, { type: "call" }, { type: "check" }, { type: "check" }, { type: "bet", to: 200 }, { type: "call" }], expectStacks: { A: 450, B: 1550 } },
  { name: "three-handed fold-out", stacks: [1000, 1000, 1000], holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"], holdMs: 6000, pots: [50],
    moves: [{ type: "fold" }, { type: "fold" }], expectStacks: { A: 1000, B: 975, C: 1025 } },
  { name: "main and side pot to different winners, with the runout", stacks: [100, 300, 1000], holes: ["As Ad", "Ks Kd", "Qs Qd"], board: ["2c 7d 9h", "Jd", "3s"], holdMs: 22000, kind: "combination", pots: [300, 400],
    moves: [{ type: "bet", to: 100 }, { type: "bet", to: 300 }, { type: "call" }, "step", "step", "step"], expectStacks: { A: 300, B: 400, C: 700 } },
  { name: "uncalled chips go back", stacks: [100, 300, 1000], holes: ["As Ad", "Ks Kd", "Qs Qd"], board: ["2c 7d 9h", "Jd", "3s"], holdMs: 22000, kind: "combination", pots: [300, 400],
    moves: [{ type: "bet", to: 100 }, { type: "bet", to: 300 }, { type: "bet", to: 600 }, "step", "step", "step"], expectStacks: { A: 300, B: 400, C: 700 } },
  { name: "split pot with the odd chip clockwise from the button", stacks: [1000, 1000, 1000], holes: ["2c 3d", "9c 9d", "2h 3s"], board: ["Ac Kd Qh", "Js", "Tc"], holdMs: 42000, kind: "draw", pots: [125],
    moves: [{ type: "call" }, { type: "fold" }, { type: "check" }, "rest"], expectStacks: { A: 1012, B: 975, C: 1013 } },
  { name: "three-way split of seven chips", stacks: [1000, 1000, 1000, 1000], holes: ["2c 3d", "9c 9d", "2d 3c", "2h 3s"], board: ["Ac Kd Qh", "Js", "Tc"], sb: 1, bb: 2, holdMs: 42000, kind: "draw", pots: [7],
    moves: [{ type: "call" }, { type: "call" }, { type: "fold" }, { type: "check" }, "rest"], expectStacks: { A: 1000, B: 999, C: 1001, D: 1000 } },
  { name: "folded chips above the last live layer are awarded", stacks: [1000, 1000, 100], holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"], holdMs: 6000, pots: [700],
    moves: [{ type: "bet", to: 300 }, { type: "call" }, { type: "call" }, { type: "fold" }, { type: "fold" }], expectStacks: { A: 700, B: 700, C: 700 } },
  { name: "a kicker decides a checked-down hand", stacks: [1000, 1000], holes: ["As Kd", "Ac Qd"], board: ["Ah 7c 7d", "2s", "3h"], holdMs: 27000, kind: "kicker", pots: [100],
    moves: ["rest"], expectStacks: { A: 1050, B: 950 } },
];

type Trace = { frames: unknown[]; stacks: Record<string, number>; result: unknown; positions: unknown };

// The lower layer: the hand operations directly.
function playLower(s: Script, ops: LedgerOperations): Trace {
  const low = createHoldem({ ranking: handRanking, ledger: ops });
  const players = s.stacks.map((stack, i) => ({ id: ids[i], seat: i, stack }));
  const started = low.newHand({ no: 1, level: 1, sb: s.sb ?? 25, bb: s.bb ?? 50, players, positions: null, deck: rig(s.holes, s.board), rng: first });
  assert.ok(started.ok);
  let h = started.value.hand;
  const frames: unknown[] = [shown(low.view(h, null))];
  const moves = [...s.moves];
  while (!low.isHandOver(h)) {
    const m = moves.shift() ?? "rest";
    let r;
    if (h.stage === "runout") r = low.runoutStep(h);
    else {
      const legal = low.legalActions(h, h.actorId!);
      const action: Action = m === "rest" || m === "step" ? (legal.check ? { type: "check" } : { type: "call" }) : m;
      r = low.apply(h, h.actorId!, action);
    }
    assert.ok(r.ok);
    h = r.hand;
    frames.push(shown(low.view(h, null)));
  }
  return { frames, stacks: low.stacks(h), result: h.result, positions: { button: h.button, sbSeat: h.sbSeat, bbSeat: h.bbSeat } };
}

// The game-rules interface: only the operations a turn engine calls.
function playInterface(s: Script, ops: LedgerOperations) {
  const { rules } = makeRules(ops, s.holes, s.board, { sb: s.sb, bb: s.bb });
  let ledger = open(ops, s.stacks);
  const started = rules.newRound({ no: 1, level: 1, players: seatsOf(s.stacks.length), carry: null }, ledger, first);
  let round = started.round;
  ledger = started.ledger;
  const frames: unknown[] = [shown(rules.publicView(round, null, {}) as never)];
  const moves = [...s.moves];
  for (let guard = 0; rules.phase(round, { settleMs: 4000 }).stage !== "over"; guard++) {
    assert.ok(guard < 200);
    const ph = rules.phase(round, { settleMs: 4000 });
    const m = moves.shift() ?? "rest";
    if (ph.stage === "auto") {
      ({ round, ledger } = rules.step(round, ledger));
    } else {
      const actor = ph.actorId!;
      const legal = rules.legal(round, actor, { paused: false }) as ReturnType<typeof rules.legal>;
      const wire = m === "rest" || m === "step" ? (legal.check ? { type: "check" } : { type: "call" }) : m;
      const parsed = rules.parseMove(wire);
      assert.ok(parsed.ok);
      const moved = rules.act(round, ledger, actor, parsed.move, { auto: false });
      assert.ok(moved.ok, moved.ok ? "" : moved.code);
      round = moved.round;
      ledger = moved.ledger;
    }
    frames.push(shown(rules.publicView(round, null, {}) as never));
  }
  return { frames, stacks: stacksOf(ledger), result: round.hand.result, positions: { button: round.hand.button, sbSeat: round.hand.sbSeat, bbSeat: round.hand.bbSeat }, round, ledger, outcome: rules.outcome(round)! };
}

for (const [label, ops] of [["real chip ledger", () => realLedger as LedgerOperations], ["fake chip ledger", fakeLedger]] as const) {
  for (const s of scripts) {
    test(`scripted hand through the interface only (${label}): ${s.name}`, () => {
      const lower = playLower(s, ops());
      const next = playInterface(s, ops());
      assert.deepEqual(next.stacks, s.expectStacks);
      assert.deepEqual(lower.stacks, s.expectStacks);
      assert.deepEqual(next.frames, lower.frames, "every step shows the same public facts");
      assert.deepEqual(next.result, lower.result);
      assert.deepEqual(next.positions, lower.positions);
      const result = next.result as { pots: { amount: number }[]; showdown: { kind: string } | null; voided: boolean };
      assert.deepEqual(result.pots.map((p) => p.amount), s.pots);
      assert.equal(result.showdown?.kind, s.kind);
      // The engine's ledger holds the final chips and balances.
      assert.equal(next.ledger.stakes.reduce((n, x) => n + x.stack + x.totalIn, 0), next.ledger.issued);
      const out = next.outcome;
      assert.equal(out.holdMs, s.holdMs);
      assert.equal(out.voided, false);
      assert.deepEqual(out.result, { ...(lower.result as object), holdMs: s.holdMs });
      const paid = (lower.result as { pots: { winners: { playerId: string; amount: number }[] }[] }).pots.flatMap((p) => p.winners.map((w) => ({ playerId: w.playerId, amount: w.amount })));
      assert.deepEqual(out.historyEntry, { winners: paid });
    });
  }
}

// ---- the operations one by one ----

function started(extra: Parameters<typeof makeRules>[3] = {}, stacks = [1000, 1000, 1000], ops: LedgerOperations = realLedger) {
  const { rules, deck } = makeRules(ops, ["2c 3d", "4c 5d", "6c 8d", "7c 9d"].slice(0, stacks.length), ["As Ks Qs", "Js", "9s"], extra);
  const ledger = open(ops, stacks);
  const r = rules.newRound({ no: 7, level: 2, players: seatsOf(stacks.length), carry: null }, ledger, first);
  return { rules, deck, ledger: r.ledger, round: r.round, carry: r.carry, opened: ledger };
}

test("optionNames is an empty list: hold'em offers no switchable options", () => {
  assert.deepEqual(started().rules.optionNames, []);
});

test("newRound draws a deck from card-deck, reads the level's blinds, returns the positions as carry and posts the blinds through the ledger", () => {
  const log = recording(realLedger);
  const { rules, deck, ledger, round, carry, opened } = started({}, [1000, 1000, 1000], log.ops);
  assert.deepEqual(deck.asked, [{ decks: 1, jokers: false }]);
  // Level 2 of the fake schedule: 50 and 100.
  assert.deepEqual([round.hand.sb, round.hand.bb, round.hand.no, round.hand.level], [50, 100, 7, 2]);
  assert.deepEqual(carry, { button: 0, sbSeat: 1, bbSeat: 2 });
  assert.deepEqual(ledger.stakes.map((s) => [s.id, s.stack, s.bet, s.totalIn]), [["A", 1000, 0, 0], ["B", 950, 50, 50], ["C", 900, 100, 100]]);
  assert.equal(round.autoSteps, 0);
  assert.deepEqual(opened.stakes.map((s) => s.stack), [1000, 1000, 1000], "the ledger passed in is not changed");
  assert.deepEqual(log.calls.filter((c) => c === "commit"), ["commit", "commit"]);
  assert.ok(log.calls.includes("nextHand"));
  assert.equal(rules.pacing.runoutStepMs, 3000);
  // The next round takes the carry and moves the button; the hole cards come from the end of the drawn deck.
  const next = rules.newRound({ no: 8, level: 2, players: seatsOf(3), carry }, opened, first);
  assert.deepEqual(next.carry, { button: 1, sbSeat: 2, bbSeat: 0 });
  assert.deepEqual(rules.records(round).map((r) => r.hidden), [{ cards: ["2c", "3d"] }, { cards: ["4c", "5d"] }, { cards: ["6c", "8d"] }]);
  // A carry that is not positions is ignored.
  assert.deepEqual(rules.newRound({ no: 1, level: 1, players: seatsOf(3), carry: { button: "x" } }, opened, first).carry, { button: 0, sbSeat: 1, bbSeat: 2 });
});

test("newRound refuses what cannot be dealt", () => {
  const { rules, opened: ledger } = started();
  assert.throws(() => rules.newRound({ no: 1, level: 1, players: seatsOf(1), carry: null }, ledger, first), /notEnoughPlayers/);
  assert.throws(() => rules.newRound({ no: 1, level: 1, players: [...seatsOf(2), { id: "Z", seat: 5 }], carry: null }, ledger, first), /unknown player Z/);
  const broke = { ...ledger, stakes: ledger.stakes.map((s) => (s.id === "B" ? { ...s, stack: 0 } : s)) };
  assert.throws(() => rules.newRound({ no: 1, level: 1, players: seatsOf(3), carry: null }, broke, first), /badRequest/);
  const narrow = open(realLedger, [1000, 1000], { seats: 6 });
  const wide = makeRules(realLedger, ["2c 3d", "4c 5d"], ["As Ks Qs", "Js", "9s"], { settings: { seats: 9 } }).rules;
  assert.throws(() => wide.newRound({ no: 1, level: 1, players: seatsOf(2), carry: null }, narrow, first), /badRequest/);
});

test("phase: acting with the settle plus the time to deal, then the plain settle after a move; auto for the runout; over", () => {
  const { rules, ledger, round } = started();
  // Three players deal six cards at 340 ms each on top of the 4000 ms settle.
  assert.deepEqual(rules.phase(round, { settleMs: 4000 }), { stage: "acting", actorId: "A", settleMs: 4000 + 6 * 340, autoDelayMs: null, event: "deal", lastActorId: null });
  assert.equal(rules.phase(round, { settleMs: 0 }).settleMs, 6 * 340);
  const moved = rules.act(round, ledger, "A", { type: "call" }, { auto: false });
  assert.ok(moved.ok);
  assert.deepEqual(rules.phase(moved.round, { settleMs: 4000 }), { stage: "acting", actorId: "B", settleMs: 4000, autoDelayMs: null, event: "action", lastActorId: "A" });
});

test("phase: runout steps are paced 4000 ms after the last move, then 3000 ms apart, and the round ends over", () => {
  let { rules, ledger, round } = started({}, [100, 300, 1000]);
  const wires = [{ type: "call" }, { type: "bet", to: 300 }, { type: "call" }];
  for (const w of wires) {
    const actor = rules.phase(round, { settleMs: 4000 }).actorId!;
    const moved = rules.act(round, ledger, actor, w, { auto: false });
    assert.ok(moved.ok);
    ({ round, ledger } = moved);
  }
  assert.deepEqual(rules.phase(round, { settleMs: 4000 }), { stage: "auto", actorId: null, settleMs: 0, autoDelayMs: 4000, event: "action", lastActorId: null });
  assert.equal(rules.outcome(round), null);
  ({ round, ledger } = rules.step(round, ledger));
  assert.equal(round.autoSteps, 1);
  assert.deepEqual(rules.phase(round, { settleMs: 4000 }).autoDelayMs, 3000);
  assert.equal(rules.phase(round, { settleMs: 4000 }).event, "flop");
  ({ round, ledger } = rules.step(round, ledger));
  ({ round, ledger } = rules.step(round, ledger));
  assert.deepEqual(rules.phase(round, { settleMs: 4000 }), { stage: "over", actorId: null, settleMs: 0, autoDelayMs: null, event: null, lastActorId: null });
  assert.throws(() => rules.step(round, ledger), /runout/);
  const pacing = makeRules(realLedger, [], [], { pacing: { runoutStepMs: 1, dealCardMs: 0 } }).rules;
  assert.deepEqual([pacing.pacing.runoutStepMs, pacing.pacing.dealCardMs, pacing.pacing.handOverMs], [1, 0, 6000]);
});

test("phase: a runout straight after the deal (blinds all-in) also waits for the cards to be dealt", () => {
  const { rules } = makeRules(realLedger, ["As Ad", "Ks Kd"], ["2c 7d 9h", "Jd", "3s"], { sb: 5, bb: 10 });
  const { round } = rules.newRound({ no: 1, level: 1, players: seatsOf(2), carry: null }, open(realLedger, [5, 10]), first);
  assert.equal(round.hand.stage, "runout");
  assert.deepEqual(rules.phase(round, { settleMs: 4000 }), { stage: "auto", actorId: null, settleMs: 0, autoDelayMs: 4000 + 4 * 340, event: "deal", lastActorId: null });
});

test("parseMove: the five wire moves, needsTurn false only for show, anything else refused", () => {
  const { rules } = started();
  assert.deepEqual(rules.parseMove({ type: "fold" }), { ok: true, move: { type: "fold" }, needsTurn: true });
  assert.deepEqual(rules.parseMove({ type: "check" }), { ok: true, move: { type: "check" }, needsTurn: true });
  assert.deepEqual(rules.parseMove({ type: "call" }), { ok: true, move: { type: "call" }, needsTurn: true });
  assert.deepEqual(rules.parseMove({ type: "bet", to: 250 }), { ok: true, move: { type: "bet", to: 250 }, needsTurn: true });
  assert.deepEqual(rules.parseMove({ type: "show", cards: [0, 1] }), { ok: true, move: { type: "show", cards: [0, 1] }, needsTurn: false });
  for (const bad of [null, undefined, "fold", {}, { type: "raise" }, { type: "bet", to: "5" }, { type: "show", cards: [2] }, { type: "start" }]) assert.deepEqual(rules.parseMove(bad), { ok: false }, JSON.stringify(bad));
});

test("act: refusals use only the engine's codes, auto marks the move, the ledger passed in is not changed", () => {
  const { rules, ledger, round } = started();
  const code = (who: string, move: unknown) => { const r = rules.act(round, ledger, who, move, { auto: false }); return r.ok ? "ok" : r.code; };
  assert.equal(code("B", { type: "check" }), "notYourTurn");
  assert.equal(code("Z", { type: "check" }), "notAllowed", "someone who is not in the hand");
  assert.equal(code("A", { type: "check" }), "notAllowed");
  assert.equal(code("A", { type: "bet", to: 120 }), "badAmount");
  assert.equal(code("A", { type: "show", cards: [0] }), "wrongPhase");
  assert.equal(code("A", { type: "dance" }), "badRequest");
  assert.equal(code("A", null), "badRequest");
  const before = JSON.stringify(ledger);
  const moved = rules.act(round, ledger, "A", { type: "bet", to: 300 }, { auto: true });
  assert.ok(moved.ok);
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(moved.round.hand.players[0].lastAction?.auto, true);
  assert.deepEqual(moved.ledger.stakes.map((s) => [s.stack, s.bet]), [[700, 300], [950, 50], [900, 100]]);
  assert.equal(round.hand.players[0].stack, 1000, "the round passed in is not changed");
});

test("act refuses a ledger that does not match the round", () => {
  const { rules, ledger, round } = started();
  const tampered = { ...ledger, stakes: ledger.stakes.map((s) => (s.id === "A" ? { ...s, stack: s.stack + 1 } : s)) };
  assert.throws(() => rules.act(round, tampered, "A", { type: "call" }, { auto: false }), /does not match/);
  assert.throws(() => rules.act(round, { ...ledger, stakes: ledger.stakes.slice(1) }, "A", { type: "call" }, { auto: false }), /not in the ledger/);
  // Chips of someone outside the hand may change between calls (a rebuy), and are kept.
  const withOutsider = { ...ledger, stakes: [...ledger.stakes, { id: "Z", seat: 8, stack: 5, bet: 0, totalIn: 0, folded: false }] };
  const moved = rules.act(round, withOutsider, "A", { type: "call" }, { auto: false });
  assert.ok(moved.ok);
  assert.equal(moved.ledger.stakes.find((s) => s.id === "Z")?.stack, 5);
});

test("defaultMove is always accepted by act: fold facing a bet, check when free", () => {
  let { rules, ledger, round } = started({}, [1000, 1000]);
  assert.deepEqual(rules.defaultMove(round, "A"), { type: "fold" });
  let moved = rules.act(round, ledger, "A", { type: "call" }, { auto: false });
  assert.ok(moved.ok);
  ({ round, ledger } = moved);
  assert.deepEqual(rules.defaultMove(round, "B"), { type: "check" });
  moved = rules.act(round, ledger, "B", rules.defaultMove(round, "B"), { auto: true });
  assert.ok(moved.ok);
});

test("legal: the actor's moves, nothing for others, nothing at all when paused", () => {
  const { rules, round } = started();
  assert.deepEqual(rules.legal(round, "A", { paused: false }), { fold: true, check: false, call: 100, bet: { min: 200, max: 1000, opening: false }, show: [] });
  assert.deepEqual(rules.legal(round, "B", { paused: false }), { fold: false, check: false, call: null, bet: null, show: [] });
  assert.deepEqual(rules.legal(round, "A", { paused: true }), { fold: false, check: false, call: null, bet: null, show: [] });
  assert.deepEqual(rules.legal(round, "Z", { paused: false }), { fold: false, check: false, call: null, bet: null, show: [] });
});

test("observation is poker-strategy's DecisionInput for that player and hides everyone else's cards", () => {
  let { rules, ledger, round } = started({}, [1000, 1000, 1000, 1000]);
  const moved = rules.act(round, ledger, "D", { type: "bet", to: 300 }, { auto: false });
  assert.ok(moved.ok);
  ({ round, ledger } = moved);
  const o = rules.observation(round, "A")!;
  assert.deepEqual(Object.keys(o).sort(), ["bb", "board", "bet", "button", "currentBet", "hole", "lastFullRaiseTo", "legal", "opponents", "pot", "sb", "seat", "seats", "stack", "street"].sort());
  assert.deepEqual([o.hole, o.board, o.street, o.stack, o.bet, o.seat, o.button, o.seats], [["2c", "3d"], [], "preflop", 1000, 0, 0, 0, 9]);
  assert.deepEqual([o.sb, o.bb, o.currentBet, o.lastFullRaiseTo, o.pot], [50, 100, 300, 300, 450]);
  assert.deepEqual(o.legal, { fold: true, check: false, call: 300, bet: { min: 500, max: 1000, opening: false } });
  assert.deepEqual(o.opponents, [
    { id: "B", seat: 1, bet: 50, totalIn: 50, lastAction: "blind" },
    { id: "C", seat: 2, bet: 100, totalIn: 100, lastAction: "blind" },
    { id: "D", seat: 3, bet: 300, totalIn: 300, lastAction: "raise" },
  ]);
  assert.equal(JSON.stringify(o).includes("4c"), false);
  // Not that player's turn: fold is false, which tells the strategy to pass. A folded opponent drops out.
  assert.equal(rules.observation(round, "B")!.legal.fold, false);
  const folded = rules.act(round, ledger, "A", { type: "fold" }, { auto: false });
  assert.ok(folded.ok);
  assert.deepEqual(rules.observation(folded.round, "B")!.opponents.map((p) => p.id), ["C", "D"]);
  assert.equal(rules.observation(round, "Z"), null);
});

test("records: one per player, hole cards hidden from others, revealed by index once shown", () => {
  const { rules, ledger, round } = started({}, [1000, 1000]);
  const folded = rules.act(round, ledger, "A", { type: "fold" }, { auto: false });
  assert.ok(folded.ok);
  assert.deepEqual(rules.records(round), [
    { ownerId: "A", open: {}, hidden: { cards: ["2c", "3d"] }, revealed: { cards: [] } },
    { ownerId: "B", open: {}, hidden: { cards: ["4c", "5d"] }, revealed: { cards: [] } },
  ]);
  const shown = rules.act(folded.round, folded.ledger, "B", { type: "show", cards: [1] }, { auto: false });
  assert.ok(shown.ok, "show is allowed after the hand, out of turn");
  assert.deepEqual(rules.records(shown.round)[1].revealed, { cards: [1] });
  assert.deepEqual(rules.records(shown.round)[0].revealed, { cards: [] });
});

test("publicView carries no hole cards and no legal moves, only what a viewer is shown", () => {
  const { rules, round } = started();
  const v = rules.publicView(round, "A", { odds: true });
  assert.equal(JSON.stringify(v).includes("2c"), false);
  assert.equal("legal" in v, false);
  assert.ok(v.players.every((p) => !("cards" in p)));
  assert.deepEqual(v.hand.pots, [], "bets in front of players are not in a pot yet");
  assert.deepEqual([v.hand.no, v.hand.level, v.hand.potTotal, v.hand.actorId, v.hand.event], [7, 2, 150, "A", "deal"]);
  assert.deepEqual(v.players.map((p) => [p.id, p.stack, p.bet]), [["A", 1000, 0], ["B", 950, 50], ["C", 900, 100]]);
  assert.equal(v.result, null);
  assert.deepEqual(rules.publicView(round, null), rules.publicView(round, "B"), "no viewer-specific facts yet");
});

test("outcome and voidRound: a cancelled round returns every chip and is a voided outcome with no winners", () => {
  const { rules, ledger, round } = started();
  assert.equal(rules.outcome(round), null);
  const moved = rules.act(round, ledger, "A", { type: "bet", to: 300 }, { auto: false });
  assert.ok(moved.ok);
  const v = rules.voidRound(moved.round, moved.ledger);
  assert.deepEqual(stacksOf(v.ledger), { A: 1000, B: 1000, C: 1000 });
  assert.deepEqual(v.outcome, { holdMs: 0, voided: true, result: { ...v.round.hand.result, holdMs: 0 }, historyEntry: { winners: [] } });
  assert.equal(v.round.hand.result?.voided, true);
  assert.deepEqual(rules.phase(v.round, { settleMs: 4000 }).stage, "over");
  assert.deepEqual(rules.outcome(v.round), v.outcome);
  assert.equal(rules.legal(v.round, "A", { paused: false }).show.length, 0);
  // Voiding a round that is already over changes nothing.
  assert.deepEqual(rules.voidRound(v.round, v.ledger), { round: v.round, ledger: v.ledger, outcome: v.outcome });
});

test("prompt: poker wording for the actor, the board, the result and the winner; null when the engine's own wording fits", () => {
  const { rules } = makeRules(realLedger, ["As Ad", "Ks Kd", "Qs Qd"], ["2c 7d 9h", "Jd", "3s"]);
  let ledger = open(realLedger, [100, 300, 1000]);
  const st = rules.newRound({ no: 1, level: 1, players: seatsOf(3), carry: null }, ledger, first);
  let round = st.round;
  ledger = st.ledger;
  assert.deepEqual(rules.prompt(round, "A"), { key: "facingBet", args: [50], text: "Your turn: 50 to call." });
  assert.equal(rules.prompt(round, "B"), null);
  assert.equal(rules.prompt(round, null), null);
  for (const w of [{ type: "bet", to: 100 }, { type: "bet", to: 300 }, { type: "call" }]) {
    const moved = rules.act(round, ledger, rules.phase(round, { settleMs: 0 }).actorId!, w, { auto: false });
    assert.ok(moved.ok);
    ({ round, ledger } = moved);
  }
  assert.equal(rules.prompt(round, "A")?.key, "dealingBoard");
  for (let i = 0; i < 3; i++) ({ round, ledger } = rules.step(round, ledger));
  // A wins the main pot (300), B the side pot (400); C wins none of the pots (its uncalled chips came back).
  assert.deepEqual(rules.prompt(round, "A"), { key: "youWon", args: [300], text: "You won 300." });
  assert.deepEqual(rules.prompt(round, "B"), { key: "youWon", args: [400], text: "You won 400." });
  assert.deepEqual(rules.prompt(round, "C"), { key: "showdown", args: [], text: "Showdown." });
  assert.deepEqual(rules.prompt(round, null), { key: "showdown", args: [], text: "Showdown." });

  const quick = started();
  let r = quick.round;
  let l = quick.ledger;
  for (const who of ["A", "B"]) {
    const moved = quick.rules.act(r, l, who, { type: "fold" }, { auto: false });
    assert.ok(moved.ok);
    ({ round: r, ledger: l } = moved);
  }
  assert.deepEqual(quick.rules.prompt(r, "A"), { key: "othersFolded", args: [], text: "Everyone else folded." });
  assert.deepEqual(quick.rules.prompt(r, "C"), { key: "youWon", args: [100], text: "You won 100." });
  const cancelled = quick.rules.voidRound(quick.round, quick.ledger).round;
  assert.deepEqual(quick.rules.prompt(cancelled, "A"), { key: "handVoided", args: [], text: "The hand was cancelled." });

  const free = started({}, [1000, 1000]);
  const called = free.rules.act(free.round, free.ledger, "A", { type: "call" }, { auto: false });
  assert.ok(called.ok);
  assert.deepEqual(free.rules.prompt(called.round, "B"), { key: "checkOrBet", args: [], text: "Your turn: check or bet." });
  assert.equal(free.rules.prompt(called.round, "A"), null);
});

// ---- the chip ledger's settings decide the pots ----

test("chip-ledger sidePots false makes one pot of everything; oddChipRule first-listed hands the odd chip to the first listed winner", () => {
  for (const ops of [realLedger as LedgerOperations, fakeLedger()]) {
    const run = (settings: Parameters<LedgerOperations["validateSettings"]>[0], s: Script) => {
      const { rules } = makeRules(ops, s.holes, s.board, { sb: s.sb, bb: s.bb });
      let ledger = open(ops, s.stacks, settings);
      const st = rules.newRound({ no: 1, level: 1, players: seatsOf(s.stacks.length), carry: null }, ledger, first);
      let round = st.round;
      ledger = st.ledger;
      for (const m of s.moves) {
        const ph = rules.phase(round, { settleMs: 0 });
        if (ph.stage === "auto") ({ round, ledger } = rules.step(round, ledger));
        else {
          const move = m === "step" ? { type: "check" } : m === "rest" ? { type: "check" } : m;
          const moved = rules.act(round, ledger, ph.actorId!, move, { auto: false });
          assert.ok(moved.ok);
          ({ round, ledger } = moved);
        }
      }
      while (rules.phase(round, { settleMs: 0 }).stage !== "over") {
        const ph = rules.phase(round, { settleMs: 0 });
        if (ph.stage === "auto") ({ round, ledger } = rules.step(round, ledger));
        else {
          const legal = rules.legal(round, ph.actorId!, { paused: false });
          const moved = rules.act(round, ledger, ph.actorId!, legal.check ? { type: "check" } : { type: "call" }, { auto: false });
          assert.ok(moved.ok);
          ({ round, ledger } = moved);
        }
      }
      return { stacks: stacksOf(ledger), pots: round.hand.result!.pots };
    };
    const side = scripts[2];
    assert.deepEqual(run({}, side).stacks, { A: 300, B: 400, C: 700 });
    const single = run({ sidePots: false }, side);
    assert.deepEqual(single.stacks, { A: 700, B: 0, C: 700 });
    assert.deepEqual(single.pots.map((p) => p.amount), [700]);
    const split = scripts[4];
    assert.deepEqual(run({}, split).stacks, { A: 1012, B: 975, C: 1013 });
    const listed = run({ oddChipRule: "first-listed" }, split);
    assert.equal(listed.stacks.A + listed.stacks.C, 2025);
    assert.deepEqual(listed.pots[0].winners.map((w) => w.amount).sort(), [62, 63]);
    assert.equal(listed.pots[0].winners[0].amount, 63, "the first listed winner takes the odd chip");
    assert.equal(listed.pots[0].winners[0].playerId, listed.pots[0].eligible.find((id) => id === "A" || id === "C"));
  }
});

test("chips move through the ledger interface: every chip in and out is a ledger call, in the order of the hand", () => {
  const s = scripts[0];
  const log = recording(realLedger);
  const { rules } = makeRules(log.ops, s.holes, s.board);
  let ledger = open(log.ops, s.stacks);
  log.calls.length = 0;
  const st = rules.newRound({ no: 1, level: 1, players: seatsOf(2), carry: null }, ledger, first);
  let round = st.round;
  ledger = st.ledger;
  assert.deepEqual(log.calls.filter((c) => c !== "stakeOf"), ["nextHand", "commit", "commit"]);
  log.calls.length = 0;
  for (const m of s.moves) {
    const ph = rules.phase(round, { settleMs: 0 });
    const moved = rules.act(round, ledger, ph.actorId!, m, { auto: false });
    assert.ok(moved.ok);
    ({ round, ledger } = moved);
  }
  const calls = log.calls.filter((c) => c !== "stakeOf");
  assert.equal(calls.filter((c) => c === "commit").length, 6, "call, bet, bet, call, bet, call");
  assert.equal(calls.filter((c) => c === "endRound").length, 3, "flop, turn and river");
  assert.deepEqual(calls.slice(-5), ["commit", "returnUncalled", "buildPots", "awardPot", "settle"]);
  assert.equal(calls.filter((c) => c === "fold").length, 0);
});

test("minimumUnit: a bet that is not a multiple is refused, and a blind that is not one cannot be dealt", () => {
  const ops = realLedger;
  const { rules } = makeRules(ops, ["As Ks", "Qc Qd"], ["2c 7d 9h", "Jd", "3s"]);
  const ledger = open(ops, [1000, 1000], { minimumUnit: 5 });
  const st = rules.newRound({ no: 1, level: 1, players: seatsOf(2), carry: null }, ledger, first);
  assert.equal((rules.act(st.round, st.ledger, "A", { type: "bet", to: 102 }, { auto: false }) as { code: string }).code, "badAmount");
  assert.equal(rules.act(st.round, st.ledger, "A", { type: "bet", to: 100 }, { auto: false }).ok, true);
  assert.equal(rules.act(st.round, st.ledger, "A", { type: "bet", to: 1000 }, { auto: false }).ok, true, "all-in");
  const odd = makeRules(ops, ["As Ks", "Qc Qd"], ["2c 7d 9h", "Jd", "3s"], { sb: 12, bb: 25 }).rules;
  assert.throws(() => odd.newRound({ no: 1, level: 1, players: seatsOf(2), carry: null }, ledger, first), /badRequest/);
});

test("settings: the rules file gives seats and the minimum opening bet, explicit settings win, the defaults otherwise", () => {
  const file = { value: (path: string) => ({ "players.maximum": 6, "betting.minimum_opening_bet_big_blinds": 2 } as Record<string, unknown>)[path] };
  assert.deepEqual(makeRules(realLedger, [], [], { rules: file }).rules.settings, { seats: 6, minimumOpeningBetBigBlinds: 2, revealAtRunout: true });
  assert.deepEqual(makeRules(realLedger, [], [], { rules: file, settings: { seats: 8, revealAtRunout: false } }).rules.settings, { seats: 8, minimumOpeningBetBigBlinds: 2, revealAtRunout: false });
  assert.deepEqual(makeRules(realLedger, [], [], { rules: { value: () => undefined } }).rules.settings, { seats: 9, minimumOpeningBetBigBlinds: 1, revealAtRunout: true });
  assert.deepEqual(makeRules(realLedger, [], [], { rules: { value: () => "six" } }).rules.settings.seats, 9);
  const six = started({ rules: file }, [1000, 1000]);
  assert.equal(six.rules.observation(six.round, "A")!.seats, 6);
  assert.throws(() => makeRules(realLedger, [], [], { settings: { seats: 1 } }), RangeError);
});

test("the lower layer's hand operations are on `lower` and work on the same rounds", () => {
  const { rules, round, ledger } = started();
  assert.deepEqual(rules.lower.legalActions(round.hand, "A"), rules.legal(round, "A", { paused: false }));
  assert.deepEqual(rules.lower.stacks(round.hand), stacksOf(ledger));
  assert.equal(rules.lower.chipsInPlay(round.hand), round.hand.chips);
});

// ---- whole games through the interface with the real deck and ledger ----

test("random games through the interface: chips balance in the ledger at every step, every legal move is accepted, rounds always end", () => {
  const rng = mulberry(20261109);
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  let hands = 0, showdowns = 0, sidePots = 0, voids = 0, shows = 0;
  for (let game = 0; game < 40; game++) {
    const count = 2 + Math.floor(rng() * 8);
    const ops = game % 2 === 0 ? realLedger : fakeLedger();
    const schedule = { levelInfo: (level: number) => ({ values: { sb: 5 * level, bb: 10 * level } }) };
    const table = createGameRules({ ranking: handRanking, ledger: ops, deck: cardDeck, schedule }, { seats: 9 });
    let ledger = open(ops, Array.from({ length: count }, () => 1 + Math.floor(rng() * (rng() < 0.3 ? 300 : 3000))));
    let carry: unknown = null;
    for (let no = 1; no <= 10; no++) {
      const alive = ledger.stakes.filter((s) => s.stack > 0).map((s) => ({ id: s.id, seat: s.seat }));
      if (alive.length < 2) break;
      const level = 1 + Math.floor(no / 4);
      const st = table.newRound({ no, level, players: alive, carry }, ledger, rng);
      let round = st.round;
      ledger = st.ledger;
      carry = st.carry;
      const issued = ledger.issued;
      const check = () => assert.equal(ledger.stakes.reduce((n, s) => n + s.stack + s.totalIn, 0), issued);
      check();
      let voided = false;
      for (let steps = 0; table.phase(round, { settleMs: 4000 }).stage !== "over"; steps++) {
        assert.ok(steps < 400, "the round must end");
        const ph = table.phase(round, { settleMs: 4000 });
        if (ph.stage === "auto") {
          ({ round, ledger } = table.step(round, ledger));
        } else {
          const actor = ph.actorId!;
          if (rng() < 0.01) {
            const v = table.voidRound(round, ledger);
            ({ round, ledger } = v);
            voided = true;
            voids++;
            break;
          }
          const legal = table.legal(round, actor, { paused: false });
          const obs = table.observation(round, actor)!;
          assert.deepEqual(obs.legal, { fold: legal.fold, check: legal.check, call: legal.call, bet: legal.bet });
          const options: unknown[] = [{ type: "fold" }];
          if (legal.check) options.push({ type: "check" }, { type: "check" });
          if (legal.call !== null) options.push({ type: "call" }, { type: "call" }, { type: "call" });
          if (legal.bet) options.push({ type: "bet", to: legal.bet.min }, { type: "bet", to: legal.bet.max }, { type: "bet", to: legal.bet.min + Math.floor(rng() * (legal.bet.max - legal.bet.min + 1)) });
          const parsed = table.parseMove(pick(options));
          assert.ok(parsed.ok);
          let moved = table.act(round, ledger, actor, parsed.move, { auto: false });
          if (!moved.ok) {
            assert.equal(parsed.move.type, "bet");
            assert.equal(moved.code, "badAmount");
            moved = table.act(round, ledger, actor, table.defaultMove(round, actor), { auto: true });
          }
          assert.ok(moved.ok);
          ({ round, ledger } = moved);
        }
        check();
      }
      hands++;
      const outcome = table.outcome(round)!;
      assert.ok(outcome);
      check();
      assert.ok(ledger.stakes.every((s) => s.totalIn === 0 && s.bet === 0));
      for (const [id, stack] of Object.entries(table.lower.stacks(round.hand))) assert.equal(ledger.stakes.find((x) => x.id === id)!.stack, stack);
      if (voided) {
        assert.equal(outcome.voided, true);
        continue;
      }
      const result = round.hand.result!;
      const won = (outcome.historyEntry.winners as { amount: number }[]).reduce((n, w) => n + w.amount, 0);
      assert.equal(won, result.pots.reduce((n, p) => n + p.amount, 0));
      if (!result.uncontested) {
        showdowns++;
        if (result.pots.length > 1) sidePots++;
        for (const pot of result.pots) for (const w of pot.winners) for (const id of pot.eligible) {
          const cards = (who: string) => [...round.hand.players.find((p) => p.id === who)!.cards, ...round.hand.board];
          assert.ok(oracleCompare(cards(w.playerId), cards(id)) >= 0, "a winner holds a best hand of its pot");
        }
      }
      // Out-of-turn show after the round; the engine allows it while the result is up.
      const shower = pick(round.hand.players).id;
      const parsedShow = table.parseMove({ type: "show", cards: [0] });
      assert.ok(parsedShow.ok && !parsedShow.needsTurn);
      const showed = table.act(round, ledger, shower, parsedShow.move, { auto: false });
      assert.equal(showed.ok, true);
      if (showed.ok) {
        shows++;
        assert.deepEqual(showed.ledger, ledger);
      }
    }
  }
  assert.ok(hands > 100 && showdowns > 30 && sidePots > 2 && voids >= 1 && shows > 100, `coverage: ${hands} hands, ${showdowns} showdowns, ${sidePots} with side pots, ${voids} voids, ${shows} shows`);
});

test("consumer example: a round played through the game-rules interface with nothing around it", () => {
  const { rules } = makeRules(realLedger, ["Ac Ad", "Kc Kd", "2c 7d"], ["3h 4h 9s", "Js", "Qc"]);
  const out = playRound(rules, open(realLedger, [1000, 1000, 1000]), seatsOf(3), first);
  assert.deepEqual(stacksOf(out.ledger), { A: 1100, B: 950, C: 950 });
  assert.equal(out.outcome.holdMs, 22000);
  assert.equal(out.moves, 12);
});
