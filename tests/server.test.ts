import assert from "node:assert/strict";
import test from "node:test";
import { createHoldem, type Action, type Hand, type SeatedPlayer } from "../implementation/server/index.ts";
import { deps, mulberry, rig, shuffled } from "./support/rig.ts";
import { oracleCompare } from "./support/oracle.ts";
import { playCheckDown } from "../examples/consumer.ts";

const rules = createHoldem(deps);
const first = () => 0; // the lowest seat takes the first button

type Setup = { players: SeatedPlayer[]; holes: string[]; board: string[]; sb?: number; bb?: number; positions?: { button: number; sbSeat: number; bbSeat: number } | null; settings?: Parameters<typeof createHoldem>[1] };

function start(s: Setup): Hand {
  const r = (s.settings ? createHoldem(deps, s.settings) : rules).newHand({
    no: 1, level: 1, sb: s.sb ?? 25, bb: s.bb ?? 50, players: s.players, positions: s.positions ?? null, deck: rig(s.holes, s.board), rng: first,
  });
  assert.ok(r.ok, r.ok ? "" : r.code);
  return r.value.hand;
}
const players = (...stacks: number[]): SeatedPlayer[] => stacks.map((stack, i) => ({ id: "ABCDEFGHI"[i], seat: i, stack }));

function play(hand: Hand, id: string, action: Action, r = rules): Hand {
  const step = r.apply(hand, id, action);
  assert.ok(step.ok, `${id} ${JSON.stringify(action)}: ${step.ok ? "" : step.code}`);
  assert.equal(r.chipsInPlay(step.hand), step.hand.chips, "chips are conserved");
  return step.hand;
}
function refused(hand: Hand, id: string, action: Action) {
  const step = rules.apply(hand, id, action);
  assert.equal(step.ok, false, `${id} ${JSON.stringify(action)} should be refused`);
  return step.ok ? null : step.code;
}
const finish = (hand: Hand): Hand => {
  const step = rules.settle(hand);
  assert.ok(step.ok);
  return step.hand;
};

test("heads-up hand played by script: blinds, order, minimum raise, showdown, stacks", () => {
  let h = start({ players: players(1000, 1000), holes: ["As Ks", "Qc Qd"], board: ["2c 7d 9h", "Jd", "3s"] });
  // The button is the small blind heads-up and acts first before the flop.
  assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [0, 0, 1]);
  assert.equal(h.actorId, "A");
  assert.deepEqual(h.players.map((p) => [p.stack, p.bet]), [[975, 25], [950, 50]]);
  assert.deepEqual(h.players.map((p) => p.lastAction?.kind), ["blind", "blind"]);
  assert.deepEqual(rules.legalActions(h, "A"), { fold: true, check: false, call: 25, bet: { min: 100, max: 1000, opening: false }, show: [] });
  assert.deepEqual(rules.legalActions(h, "B"), { fold: false, check: false, call: null, bet: null, show: [] });
  h = play(h, "A", { type: "call" });
  assert.equal(h.actorId, "B");
  assert.equal(rules.legalActions(h, "B").check, true);
  h = play(h, "B", { type: "check" });
  // Flop: the other player acts first after the button.
  assert.deepEqual([h.street, h.board, h.event, h.actorId, h.currentBet], ["flop", ["2c", "7d", "9h"], "flop", "B", 0]);
  assert.deepEqual(rules.legalActions(h, "B").bet, { min: 50, max: 950, opening: true });
  h = play(h, "B", { type: "check" });
  h = play(h, "A", { type: "bet", to: 100 });
  assert.equal(h.players[0].lastAction?.kind, "bet");
  assert.deepEqual(rules.legalActions(h, "B"), { fold: true, check: false, call: 100, bet: { min: 200, max: 950, opening: false }, show: [] });
  h = play(h, "B", { type: "bet", to: 300 });
  assert.equal(h.players[1].lastAction?.kind, "raise");
  assert.deepEqual(rules.legalActions(h, "A").bet, { min: 500, max: 950, opening: false });
  h = play(h, "A", { type: "call" });
  assert.deepEqual([h.street, h.board.length, h.actorId], ["turn", 4, "B"]);
  h = play(h, "B", { type: "check" });
  h = play(h, "A", { type: "check" });
  assert.deepEqual([h.street, h.board.length], ["river", 5]);
  h = play(h, "B", { type: "bet", to: 200 });
  assert.equal(rules.isHandOver(h), false);
  h = play(h, "A", { type: "call" });
  assert.equal(rules.isHandOver(h), true);
  assert.equal(h.stage, "over");
  assert.equal(h.result!.uncontested, false);
  assert.deepEqual(h.result!.pots.map((p) => [p.amount, p.winners.map((w) => [w.playerId, w.amount, w.handName])]), [[1100, [["B", 1100, "Pair of queens"]]]]);
  assert.equal(h.result!.showdown?.kind, "combination");
  assert.deepEqual(rules.stacks(h), { A: 450, B: 1550 });
  assert.deepEqual(h.players.map((p) => p.shown), [[0, 1], [0, 1]]);
  assert.equal(refused(h, "A", { type: "check" }), "wrongPhase");
});

test("three-handed: positions, first actor, fold to the big blind, uncalled chips return", () => {
  let h = start({ players: players(1000, 1000, 1000), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  assert.deepEqual([h.button, h.sbSeat, h.bbSeat, h.actorId], [0, 1, 2, "A"]);
  assert.equal(refused(h, "C", { type: "check" }), "notYourTurn");
  h = play(h, "A", { type: "fold" });
  assert.equal(h.actorId, "B");
  h = play(h, "B", { type: "fold" });
  assert.equal(h.stage, "over");
  assert.equal(h.result!.uncontested, true);
  assert.equal(h.result!.showdown, null);
  assert.deepEqual(rules.stacks(h), { A: 1000, B: 975, C: 1025 });
  assert.deepEqual(h.players.map((p) => p.shown), [[], [], []]);
});

test("the button moves one seat each hand, heads-up swaps blinds, and a missing blind is dead", () => {
  const three = players(1000, 1000, 1000);
  const second = start({ players: three, holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"], positions: { button: 0, sbSeat: 1, bbSeat: 2 } });
  assert.deepEqual([second.button, second.sbSeat, second.bbSeat], [1, 2, 0]);
  assert.equal(second.actorId, "B");
  // Seat 2 left: heads-up, the player who was not big blind last time posts the small blind on the button.
  const headsUp = start({ players: [three[0], three[1]].map((p, i) => ({ ...p, seat: [0, 2][i] })), holes: ["2c 3d", "4c 5d"], board: ["As Ks Qs", "Js", "9s"], positions: { button: 0, sbSeat: 1, bbSeat: 2 } });
  assert.deepEqual([headsUp.button, headsUp.sbSeat, headsUp.bbSeat], [2, 2, 0]);
  // Seat 2 busted: the small blind seat is empty (dead), the big blind passes to the next seat.
  const dead = start({ players: [0, 1, 3].map((s) => ({ id: "ABCDE"[s], seat: s, stack: 1000 })), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"], positions: { button: 0, sbSeat: 1, bbSeat: 2 } });
  assert.deepEqual([dead.button, dead.sbSeat, dead.bbSeat], [1, 2, 3]);
  assert.deepEqual(dead.players.map((p) => p.bet), [0, 0, 50]);
  assert.equal(dead.players.every((p) => p.lastAction?.kind !== "blind" || p.seat === 3), true);
});

test("minimum bet and raise sizes, refused amounts and turn order", () => {
  let h = start({ players: players(1000, 1000, 1000), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  assert.equal(refused(h, "A", { type: "bet", to: 70 }), "badAmount");
  assert.equal(refused(h, "A", { type: "bet", to: 50 }), "badAmount");
  assert.equal(refused(h, "A", { type: "bet", to: 1001 }), "badAmount");
  assert.equal(refused(h, "A", { type: "bet", to: 100.5 }), "badAmount");
  assert.equal(refused(h, "A", { type: "check" }), "notAllowed");
  h = play(h, "A", { type: "bet", to: 100 });
  assert.deepEqual(rules.legalActions(h, "B").bet, { min: 150, max: 1000, opening: false });
  h = play(h, "B", { type: "bet", to: 300 });
  assert.deepEqual(rules.legalActions(h, "C").bet, { min: 500, max: 1000, opening: false });
  assert.equal(refused(h, "C", { type: "bet", to: 499 }), "badAmount");
  h = play(h, "C", { type: "fold" });
  assert.deepEqual(rules.legalActions(h, "A"), { fold: true, check: false, call: 200, bet: { min: 500, max: 1000, opening: false }, show: [] });
  assert.equal(refused(h, "B", { type: "call" }), "notYourTurn");
});

test("a short all-in raise does not reopen the betting for players who already acted", () => {
  let h = start({ players: players(1000, 1000, 130), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  h = play(h, "A", { type: "bet", to: 100 });
  h = play(h, "B", { type: "call" });
  // The big blind has 80 behind: all-in to 130 raises by 30, less than the 50 of the last full raise.
  assert.deepEqual(rules.legalActions(h, "C").bet, { min: 130, max: 130, opening: false });
  h = play(h, "C", { type: "bet", to: 130 });
  assert.equal(h.players[2].lastAction?.kind, "allIn");
  assert.equal(h.currentBet, 130);
  assert.equal(h.actorId, "A");
  assert.deepEqual(rules.legalActions(h, "A"), { fold: true, check: false, call: 30, bet: null, show: [] });
  assert.equal(refused(h, "A", { type: "bet", to: 400 }), "notAllowed");
  h = play(h, "A", { type: "call" });
  assert.deepEqual(rules.legalActions(h, "B"), { fold: true, check: false, call: 30, bet: null, show: [] });
  h = play(h, "B", { type: "call" });
  assert.deepEqual([h.street, h.board.length], ["flop", 3]);
});

test("a short all-in that is not a full raise is refused unless it is all the player has", () => {
  let h = start({ players: players(1000, 1000, 1000), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  h = play(h, "A", { type: "bet", to: 400 });
  assert.equal(refused(h, "B", { type: "bet", to: 500 }), "badAmount");
  assert.equal(refused(h, "B", { type: "bet", to: 700 }), "badAmount");
  h = play(h, "B", { type: "bet", to: 750 });
  assert.equal(h.lastFullRaiseTo, 750);
});

test("short all-in raises that add up to a full raise reopen the betting", () => {
  const stacks = [140, 190, 1000, 1000];
  const setup = (second: number): Hand => {
    // Seats 0..3: button A, small blind B, big blind C, first to act D.
    let h = start({ players: players(140, second, 1000, 1000), holes: ["2c 3d", "4c 5d", "6c 8d", "7c 9d"], board: ["As Ks Qs", "Js", "9s"] });
    assert.equal(h.actorId, "D");
    h = play(h, "D", { type: "bet", to: 100 });
    h = play(h, "A", { type: "bet", to: 140 });
    return h;
  };
  assert.equal(stacks.length, 4);
  // First short raise (40 on top of 100) alone: the player who already raised cannot raise again.
  let h = setup(1000);
  assert.deepEqual(h.players.map((p) => p.canRaise), [false, true, true, false]);
  h = play(h, "B", { type: "call" });
  h = play(h, "C", { type: "call" });
  assert.deepEqual(rules.legalActions(h, "D"), { fold: true, check: false, call: 40, bet: null, show: [] });
  // A second short all-in (to 180, 40 more): 80 over the last full raise point, so everyone may raise again.
  h = setup(180);
  h = play(h, "B", { type: "bet", to: 180 });
  assert.equal(h.players[1].lastAction?.kind, "allIn");
  assert.deepEqual(h.players.map((p) => p.canRaise), [false, false, true, true]);
  h = play(h, "C", { type: "call" });
  assert.deepEqual(rules.legalActions(h, "D"), { fold: true, check: false, call: 80, bet: { min: 230, max: 1000, opening: false }, show: [] });
});

test("side pots: main and side pot go to different winners, nothing is lost", () => {
  let h = start({ players: players(100, 300, 1000), holes: ["As Ad", "Ks Kd", "Qs Qd"], board: ["2c 7d 9h", "Jd", "3s"] });
  h = play(h, "A", { type: "bet", to: 100 });
  h = play(h, "B", { type: "bet", to: 300 });
  h = play(h, "C", { type: "call" });
  assert.equal(h.stage, "runout");
  assert.deepEqual(h.players.map((p) => p.shown), [[0, 1], [0, 1], [0, 1]]);
  assert.equal(rules.legalActions(h, "A").fold, false);
  assert.equal(h.board.length, 0);
  assert.equal(refused(h, "C", { type: "check" }), "wrongPhase");
  const flop = rules.runoutStep(h);
  assert.ok(flop.ok);
  assert.deepEqual([flop.hand.board.length, flop.hand.street, flop.hand.stage], [3, "flop", "runout"]);
  const turn = rules.runoutStep(flop.hand);
  assert.ok(turn.ok);
  const river = rules.runoutStep(turn.hand);
  assert.ok(river.ok);
  h = river.hand;
  assert.equal(h.stage, "over");
  assert.deepEqual(h.result!.pots.map((p) => [p.amount, p.eligible, p.winners.map((w) => w.playerId)]), [[300, ["A", "B", "C"], ["A"]], [400, ["B", "C"], ["B"]]]);
  assert.deepEqual(rules.stacks(h), { A: 300, B: 400, C: 700 });
  assert.equal(rules.runoutStep(h).ok, false);
});

test("uncalled chips go back before the pots are built", () => {
  let h = start({ players: players(100, 300, 1000), holes: ["As Ad", "Ks Kd", "Qs Qd"], board: ["2c 7d 9h", "Jd", "3s"] });
  h = play(h, "A", { type: "bet", to: 100 });
  h = play(h, "B", { type: "bet", to: 300 });
  h = play(h, "C", { type: "bet", to: 600 });
  assert.equal(h.stage, "runout");
  h = finish(h);
  assert.deepEqual(h.result!.pots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(rules.stacks(h), { A: 300, B: 400, C: 700 + 0 });
  assert.equal(rules.chipsInPlay(h), 1400);
});

test("the shortest stack can win a side pot too when it holds the best hand against only itself", () => {
  let h = start({ players: players(100, 300, 1000), holes: ["Qs Qd", "As Ad", "Ks Kd"], board: ["2c 7d 9h", "Jd", "3s"] });
  h = play(h, "A", { type: "bet", to: 100 });
  h = play(h, "B", { type: "bet", to: 300 });
  h = play(h, "C", { type: "call" });
  h = finish(h);
  assert.deepEqual(rules.stacks(h), { A: 0, B: 700, C: 700 });
});

test("a split pot divides evenly, and the odd chip goes clockwise from the button", () => {
  let h = start({ players: players(1000, 1000, 1000), holes: ["2c 3d", "9c 9d", "2h 3s"], board: ["Ac Kd Qh", "Js", "Tc"] });
  h = play(h, "A", { type: "call" });
  h = play(h, "B", { type: "fold" });
  h = play(h, "C", { type: "check" });
  while (!rules.isHandOver(h)) h = play(h, h.actorId!, { type: "check" });
  // 50 + 50 + the folded small blind's 25 = 125, split between the button (seat 0) and the big blind.
  assert.deepEqual(h.result!.pots.map((p) => p.amount), [125]);
  assert.deepEqual(h.result!.pots[0].winners.map((w) => [w.playerId, w.amount]), [["C", 63], ["A", 62]]);
  assert.equal(h.result!.showdown?.kind, "draw");
  assert.deepEqual(rules.stacks(h), { A: 1012, B: 975, C: 1013 });
});

test("a three-way split of seven chips gives the odd chip to the first seat clockwise from the button", () => {
  // Four players, button A (seat 0). D calls, A calls, B folds its small blind, C checks: 2 + 2 + 2 + 1 = 7.
  let h = start({ players: players(1000, 1000, 1000, 1000), holes: ["2c 3d", "9c 9d", "2d 3c", "2h 3s"], board: ["Ac Kd Qh", "Js", "Tc"], sb: 1, bb: 2 });
  assert.equal(h.actorId, "D");
  h = play(h, "D", { type: "call" });
  h = play(h, "A", { type: "call" });
  h = play(h, "B", { type: "fold" });
  h = play(h, "C", { type: "check" });
  while (!rules.isHandOver(h)) h = play(h, h.actorId!, { type: "check" });
  assert.deepEqual(h.result!.pots.map((p) => p.amount), [7]);
  assert.deepEqual(h.result!.pots[0].winners.map((w) => [w.playerId, w.amount]), [["C", 3], ["D", 2], ["A", 2]]);
  assert.deepEqual(rules.stacks(h), { A: 1000, B: 999, C: 1001, D: 1000 });
});

test("chips of folded players above the last live layer are not lost", () => {
  // The button and the small blind each put in 300 and then fold on the flop to the short big blind.
  let h = start({ players: players(1000, 1000, 100), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  h = play(h, "A", { type: "bet", to: 300 });
  h = play(h, "B", { type: "call" });
  h = play(h, "C", { type: "call" });
  assert.equal(h.players[2].allIn, true);
  assert.deepEqual([h.street, h.actorId], ["flop", "B"]);
  h = play(h, "B", { type: "fold" });
  h = play(h, "A", { type: "fold" });
  assert.equal(h.stage, "over");
  assert.equal(h.result!.uncontested, true);
  assert.deepEqual(h.result!.pots.map((p) => [p.amount, p.winners.map((w) => w.playerId)]), [[700, ["C"]]]);
  assert.deepEqual(rules.stacks(h), { A: 700, B: 700, C: 700 });
  assert.equal(rules.chipsInPlay(h), 2100);
});

test("when the only active player is not matched, the uncalled chips go back and the rest is a runout", () => {
  let h = start({ players: players(1000, 1000, 250), holes: ["2c 3d", "4c 5d", "Ac 8d"], board: ["As Kd Qh", "Jd", "9c"] });
  h = play(h, "A", { type: "bet", to: 300 });
  h = play(h, "B", { type: "fold" });
  h = play(h, "C", { type: "call" });
  assert.equal(h.players[2].allIn, true);
  assert.equal(h.stage, "runout");
  h = finish(h);
  assert.deepEqual(h.result!.pots.map((p) => [p.amount, p.eligible]), [[525, ["A", "C"]]]);
  assert.deepEqual(rules.stacks(h), { A: 750, B: 975, C: 525 });
  assert.equal(rules.chipsInPlay(h), 2250);
});

test("all-in before the flop: the runout reveals the hands, and settle deals what is left", () => {
  let h = start({ players: players(500, 500), holes: ["As Ad", "Ks Kc"], board: ["2c 7d 9h", "Jd", "3s"] });
  h = play(h, "A", { type: "bet", to: 500 });
  assert.equal(h.stage, "betting");
  h = play(h, "B", { type: "call" });
  assert.deepEqual([h.stage, h.board.length, h.actorId], ["runout", 0, null]);
  const step = rules.runoutStep(h);
  assert.ok(step.ok && step.hand.board.length === 3);
  const done = rules.settle(step.hand);
  assert.ok(done.ok);
  assert.deepEqual([done.hand.stage, done.hand.board.length, done.hand.street], ["over", 5, "river"]);
  assert.deepEqual(rules.stacks(done.hand), { A: 1000, B: 0 });
  assert.equal(rules.settle(done.hand).ok, true);
  const betting = start({ players: players(500, 500), holes: ["As Ad", "Ks Kc"], board: ["2c 7d 9h", "Jd", "3s"] });
  assert.equal(rules.settle(betting).ok, false);
  assert.equal(rules.runoutStep(betting).ok, false);
});

test("revealAtRunout false keeps the hands down until the hand ends", () => {
  const quiet = createHoldem(deps, { revealAtRunout: false });
  let h = start({ players: players(500, 500), holes: ["As Ad", "Ks Kc"], board: ["2c 7d 9h", "Jd", "3s"], settings: { revealAtRunout: false } });
  h = play(h, "A", { type: "bet", to: 500 }, quiet);
  h = play(h, "B", { type: "call" }, quiet);
  assert.deepEqual(h.players.map((p) => p.shown), [[], []]);
  assert.deepEqual(quiet.view(h, null).players.map((p) => p.cards), [[null, null], [null, null]]);
  const over = quiet.settle(h);
  assert.ok(over.ok);
  assert.deepEqual(over.hand.players.map((p) => p.shown), [[0, 1], [0, 1]]);
});

test("a hand checked to showdown with a kicker deciding names the kicker", () => {
  const h = playCheckDown(deps, players(1000, 1000), rig(["As Kd", "Ac Qd"], ["Ah 7c 7d", "2s", "3h"]), 25, 50);
  assert.equal(h.result.showdown?.kind, "kicker");
  assert.deepEqual(h.result.showdown?.winners, ["A"]);
  assert.deepEqual(h.result.showdown?.kickers, { B: 1, A: 1 });
  assert.deepEqual(h.stacks, { A: 1050, B: 950 });
  assert.equal(h.result.pots[0].winners[0].handName, "Two pair, aces and sevens");
});

test("voluntary show after the hand, and views mask hidden cards", () => {
  let h = start({ players: players(1000, 1000, 1000), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  const mid = rules.view(h, "A");
  assert.deepEqual(mid.players.map((p) => p.cards), [["2c", "3d"], [null, null], [null, null]]);
  assert.deepEqual(rules.view(h, null).players.map((p) => p.cards), [[null, null], [null, null], [null, null]]);
  assert.equal(mid.hand.potTotal, 75);
  assert.equal(mid.legal.fold, true);
  assert.equal(rules.view(h, "B").legal.fold, false);
  assert.equal(rules.view(h, null).legal.fold, false);
  assert.equal(refused(h, "A", { type: "show", cards: [0] }), "wrongPhase");
  h = play(h, "A", { type: "fold" });
  h = play(h, "B", { type: "fold" });
  assert.deepEqual(rules.legalActions(h, "C").show, [0, 1]);
  assert.equal(refused(h, "C", { type: "show", cards: [2] as unknown as number[] }), "badRequest");
  h = play(h, "C", { type: "show", cards: [1] });
  assert.deepEqual(rules.legalActions(h, "C").show, [0]);
  const seen = rules.view(h, "A");
  assert.deepEqual(seen.players.map((p) => p.cards), [["2c", "3d"], [null, null], [null, "8d"]]);
  assert.equal(seen.players[2].hand, null);
  assert.equal(seen.result?.uncontested, true);
  h = play(h, "C", { type: "show", cards: [0, 1] });
  assert.deepEqual(rules.view(h, null).players[2].cards, ["6c", "8d"]);
  assert.equal(rules.legalActions(h, "C").show.length, 0);
});

test("a showdown view names each shown hand once three board cards are out", () => {
  const h = playCheckDown(deps, players(1000, 1000), rig(["As Ks", "Qc Qd"], ["2c 7d 9h", "Jd", "3s"]), 25, 50);
  assert.ok(h.result);
  let hand = start({ players: players(1000, 1000), holes: ["As Ks", "Qc Qd"], board: ["2c 7d 9h", "Jd", "3s"] });
  hand = play(hand, "A", { type: "bet", to: 1000 });
  hand = play(hand, "B", { type: "call" });
  hand = finish(hand);
  const v = rules.view(hand, null);
  assert.deepEqual(v.players.map((p) => p.hand?.name), ["Ace high", "Pair of queens"]);
  assert.deepEqual(v.hand.pots.map((p) => p.amount), [2000]);
  assert.equal(v.result?.pots[0].winners[0].playerId, "B");
});

test("voiding a hand gives every contribution back, blinds included", () => {
  let h = start({ players: players(1000, 1000, 1000), holes: ["2c 3d", "4c 5d", "6c 8d"], board: ["As Ks Qs", "Js", "9s"] });
  h = play(h, "A", { type: "bet", to: 300 });
  const v = rules.voidHand(h);
  assert.ok(v.ok);
  assert.deepEqual(rules.stacks(v.hand), { A: 1000, B: 1000, C: 1000 });
  assert.deepEqual([v.hand.stage, v.hand.result?.voided, v.hand.actorId], ["over", true, null]);
  assert.equal(rules.voidHand(v.hand).ok, false);
  assert.equal(rules.apply(v.hand, "A", { type: "show", cards: [0] }).ok, false);
  assert.deepEqual(rules.legalActions(v.hand, "A").show, []);
});

test("autoAction checks when free and folds otherwise", () => {
  let h = start({ players: players(1000, 1000), holes: ["As Ks", "Qc Qd"], board: ["2c 7d 9h", "Jd", "3s"] });
  assert.deepEqual(rules.autoAction(h, "A"), { type: "fold" });
  h = play(h, "A", { type: "call" }, rules);
  assert.deepEqual(rules.autoAction(h, "B"), { type: "check" });
  const auto = rules.apply(h, "B", rules.autoAction(h, "B"), { auto: true });
  assert.ok(auto.ok);
  assert.equal(auto.hand.players[1].lastAction?.auto, true);
});

test("wire actions are parsed and refused when malformed", () => {
  assert.deepEqual(rules.parseAction({ type: "fold" }), { ok: true, value: { type: "fold" } });
  assert.deepEqual(rules.parseAction({ type: "check", extra: 1 }), { ok: true, value: { type: "check" } });
  assert.deepEqual(rules.parseAction({ type: "bet", to: 250 }), { ok: true, value: { type: "bet", to: 250 } });
  assert.deepEqual(rules.parseAction({ type: "show", cards: [0, 1] }), { ok: true, value: { type: "show", cards: [0, 1] } });
  for (const bad of [null, undefined, "fold", {}, { type: "raise" }, { type: "bet" }, { type: "bet", to: "5" }, { type: "show", cards: [2] }, { type: "show", cards: "01" }, { type: "start" }]) {
    assert.deepEqual(rules.parseAction(bad), { ok: false, code: "badRequest" }, JSON.stringify(bad));
  }
});

test("new hands are refused for bad input", () => {
  const base = { no: 1, level: 1, sb: 25, bb: 50, positions: null, deck: rig(["As Ks", "Qc Qd"], ["2c 7d 9h", "Jd", "3s"]), rng: first };
  const code = (over: Record<string, unknown>) => { const r = rules.newHand({ ...base, players: players(1000, 1000), ...over } as never); return r.ok ? "ok" : r.code; };
  assert.equal(code({}), "ok");
  assert.equal(code({ players: players(1000) }), "notEnoughPlayers");
  assert.equal(code({ players: players(1000, 0) }), "badRequest");
  assert.equal(code({ players: [{ id: "A", seat: 0, stack: 5 }, { id: "B", seat: 0, stack: 5 }] }), "badRequest");
  assert.equal(code({ players: [{ id: "A", seat: 0, stack: 5 }, { id: "A", seat: 1, stack: 5 }] }), "badRequest");
  assert.equal(code({ players: [{ id: "A", seat: 0, stack: 5 }, { id: "B", seat: 9, stack: 5 }] }), "badRequest");
  assert.equal(code({ sb: 0 }), "badRequest");
  assert.equal(code({ sb: 60 }), "badRequest");
  assert.equal(code({ deck: ["As", "Ks"] }), "badRequest");
  assert.throws(() => createHoldem(deps, { seats: 1 }), RangeError);
  assert.throws(() => createHoldem(deps, { minimumOpeningBetBigBlinds: 0 }), RangeError);
});

test("a short stack can post only part of a blind and is all-in", () => {
  let h = start({ players: players(1000, 20), holes: ["As Ks", "Qc Qd"], board: ["2c 7d 9h", "Jd", "3s"] });
  assert.deepEqual(h.players.map((p) => [p.bet, p.allIn, p.lastAction?.kind]), [[25, false, "blind"], [20, true, "allIn"]]);
  assert.equal(h.actorId, "A");
  // The big blind posted only 20; the bet to match stays at the full blind and the small blind pays up to it.
  assert.equal(h.currentBet, 50);
  assert.equal(rules.legalActions(h, "A").call, 25);
  h = play(h, "A", { type: "call" });
  assert.equal(h.stage, "runout");
});

test("minimumOpeningBetBigBlinds sets the minimum bet after the flop", () => {
  const two = createHoldem(deps, { minimumOpeningBetBigBlinds: 2 });
  let h = start({ players: players(1000, 1000), holes: ["As Ks", "Qc Qd"], board: ["2c 7d 9h", "Jd", "3s"], settings: { minimumOpeningBetBigBlinds: 2 } });
  h = play(h, "A", { type: "call" }, two);
  h = play(h, "B", { type: "check" }, two);
  assert.deepEqual(two.legalActions(h, "B").bet, { min: 100, max: 950, opening: true });
});

test("random play: chips are conserved, every legal action is accepted, hands always end, winners hold the best hand", () => {
  const rng = mulberry(20261109);
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  let hands = 0, showdowns = 0, sidePots = 0, splits = 0;
  for (let game = 0; game < 60; game++) {
    const count = 2 + Math.floor(rng() * 8);
    let live: SeatedPlayer[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, seat: i, stack: 1 + Math.floor(rng() * (rng() < 0.3 ? 200 : 3000)) }));
    let positions: { button: number; sbSeat: number; bbSeat: number } | null = null;
    for (let no = 1; live.length >= 2 && no <= 12; no++) {
      const sb = 1 + Math.floor(rng() * 25);
      const started = rules.newHand({ no, level: 1, sb, bb: sb * 2, players: live, positions, deck: shuffled(rng), rng });
      assert.ok(started.ok);
      positions = started.value.positions;
      let h = started.value.hand;
      const total = h.chips;
      for (let steps = 0; !rules.isHandOver(h); steps++) {
        assert.ok(steps < 400, "the hand must end");
        let step;
        if (h.stage === "runout") step = rules.runoutStep(h);
        else {
          const legal = rules.legalActions(h, h.actorId!);
          const options: Action[] = [{ type: "fold" }];
          if (legal.check) options.push({ type: "check" }, { type: "check" });
          if (legal.call !== null) options.push({ type: "call" }, { type: "call" }, { type: "call" });
          if (legal.bet) options.push({ type: "bet", to: legal.bet.min }, { type: "bet", to: legal.bet.max }, { type: "bet", to: legal.bet.min + Math.floor(rng() * (legal.bet.max - legal.bet.min + 1)) });
          const action = pick(options);
          step = rules.apply(h, h.actorId!, action);
          if (!step.ok) {
            // The only legal-range amount that can fail is a non-full raise that is not all-in.
            assert.equal(action.type, "bet");
            assert.equal(step.code, "badAmount");
            step = rules.apply(h, h.actorId!, { type: "call" }).ok ? rules.apply(h, h.actorId!, { type: "call" }) : rules.apply(h, h.actorId!, { type: "check" });
          }
        }
        assert.ok(step.ok, step.ok ? "" : step.code);
        h = step.hand;
        assert.equal(rules.chipsInPlay(h), total);
        assert.ok(h.players.every((p) => p.stack >= 0 && p.bet >= 0 && p.totalIn >= 0));
      }
      hands++;
      assert.equal(Object.values(rules.stacks(h)).reduce((a, b) => a + b, 0), total);
      assert.ok(h.players.every((p) => p.totalIn === 0));
      const awarded = h.result!.pots.reduce((s, p) => s + p.amount, 0);
      assert.equal(h.result!.pots.every((p) => p.winners.reduce((s, w) => s + w.amount, 0) === p.amount), true);
      assert.ok(awarded > 0);
      if (!h.result!.uncontested) {
        showdowns++;
        if (h.result!.pots.length > 1) sidePots++;
        for (const pot of h.result!.pots) {
          if (pot.winners.length > 1) splits++;
          const byId = new Map(h.players.map((p) => [p.id, p]));
          for (const w of pot.winners) for (const id of pot.eligible) {
            assert.ok(oracleCompare([...byId.get(w.playerId)!.cards, ...h.board], [...byId.get(id)!.cards, ...h.board]) >= 0, "a winner holds a best hand of its pot");
          }
        }
      }
      live = h.players.filter((p) => p.stack > 0).map((p) => ({ id: p.id, seat: p.seat, stack: p.stack }));
    }
  }
  assert.ok(hands > 200 && showdowns > 40 && sidePots > 5 && splits >= 1, `coverage: ${hands} hands, ${showdowns} showdowns, ${sidePots} with side pots, ${splits} split pots`);
});

test("consumer example: a check-down hand drives the rules without any game", () => {
  const { stacks, result } = playCheckDown(deps, players(1000, 1000, 1000), rig(["Ac Ad", "Kc Kd", "2c 7d"], ["3h 4h 9s", "Js", "Qc"]), 25, 50);
  assert.deepEqual(stacks, { A: 1100, B: 950, C: 950 });
  assert.equal(result.pots[0].winners[0].playerId, "A");
});
