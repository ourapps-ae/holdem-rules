import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { adjust, betIsAllIn, betKind, callIsAllIn, canSlide, isAllowedAmount, presets, snap, stepFor, type BetRange } from "../implementation/web/betting.ts";
import { createHoldem } from "../implementation/server/index.ts";
import { deps, rig } from "./support/rig.ts";

const fixture = JSON.parse(readFileSync(new URL("fixtures/betting.json", import.meta.url), "utf8"));

test("step is the small blind and never below one", () => {
  for (const [blind, expected] of fixture.step) assert.equal(stepFor(blind), expected);
  assert.equal(stepFor(undefined), 1);
});

test("quick amounts follow the reference cases under both roundings", () => {
  for (const c of fixture.presets) {
    for (const [name, rounding] of [["nearest", "nearest"], ["down", "down"]] as const) {
      assert.deepEqual(presets({ range: c.range, pot: c.pot, toCall: c.toCall, currentBet: c.currentBet, smallBlind: c.smallBlind, rounding }), c[name], `${name} ${JSON.stringify(c.range)} pot ${c.pot}`);
    }
  }
});

test("snap rounds to the step and stays in range", () => {
  const r: BetRange = { min: 100, max: 1000, opening: false };
  assert.equal(snap(612, r, 25), 600);
  assert.equal(snap(613, r, 25), 625);
  assert.equal(snap(624, r, 25, "down"), 600);
  assert.equal(snap(5, r, 25), 100);
  assert.equal(snap(99999, r, 25), 1000);
});

test("adjust moves by a step, stays in range and survives huge values", () => {
  for (const c of fixture.adjust) assert.equal(adjust(c.amount, c.by, c.range), c.result);
  assert.equal(adjust(Number.MAX_SAFE_INTEGER, 10, { min: 1, max: 9, opening: false }), 9);
  assert.equal(adjust(-Number.MAX_SAFE_INTEGER, -10, { min: 1, max: 9, opening: false }), 1);
});

test("confirm label, all-in detection, typed amounts and slider", () => {
  for (const c of fixture.kind) assert.equal(betKind(c.to, c.range), c.result);
  assert.equal(callIsAllIn(200, 200), true);
  assert.equal(callIsAllIn(200, 500), false);
  assert.equal(betIsAllIn(1000, 900, 100), true);
  assert.equal(betIsAllIn(999, 900, 100), false);
  const r: BetRange = { min: 100, max: 1000, opening: false };
  assert.equal(isAllowedAmount(100, r), true);
  assert.equal(isAllowedAmount(99, r), false);
  assert.equal(isAllowedAmount(1001, r), false);
  assert.equal(isAllowedAmount(150.5, r), false);
  assert.equal(isAllowedAmount(Number.NaN, r), false);
  assert.equal(canSlide(r, 25), true);
  assert.equal(canSlide({ min: 100, max: 110, opening: false }, 25), false);
});

test("every amount the controls can produce from a live hand is accepted or refused exactly as the controls promise", () => {
  const rules = createHoldem(deps);
  const started = rules.newHand({ no: 1, level: 1, sb: 25, bb: 50, players: [{ id: "A", seat: 0, stack: 1000 }, { id: "B", seat: 1, stack: 1000 }, { id: "C", seat: 2, stack: 1000 }],
    positions: null, deck: rig(["2c 3d", "4c 5d", "6c 8d"], ["As Ks Qs", "Js", "9s"]), rng: () => 0 });
  assert.ok(started.ok);
  const hand = started.value.hand;
  const legal = rules.legalActions(hand, hand.actorId!);
  assert.ok(legal.bet);
  const view = rules.view(hand, hand.actorId!);
  const p = presets({ range: legal.bet, pot: view.hand.potTotal, toCall: legal.call, currentBet: view.hand.currentBet, smallBlind: view.hand.sb });
  for (const to of [p.min, p.halfPot, p.pot, p.allIn]) {
    assert.equal(isAllowedAmount(to, legal.bet), true);
    assert.equal(rules.apply(hand, hand.actorId!, { type: "bet", to }).ok, true, `preset ${to}`);
  }
  assert.equal(betKind(p.allIn, legal.bet), "allIn");
  assert.equal(rules.apply(hand, hand.actorId!, { type: "bet", to: legal.bet.min - 1 }).ok, false);
});
