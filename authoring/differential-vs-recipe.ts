// Differential driver against the recipe engine (not packaged). See SOURCE.md "Tests and checks" for the scratch-folder setup.
import { newLobby, join, apply, advance, setLive, type Game } from "./server/src/engine.ts";
import { createHoldem } from "/Users/george/Projects/com/my/components/holdem-rules/implementation/server/index.ts";
import { handRanking } from "/Users/george/Projects/com/my/components/poker-hand-ranking/implementation/server/index.ts";

import * as ledger from "/Users/george/Projects/com/my/components/chip-ledger/implementation/server/ledger.ts";
const rules = createHoldem({ ranking: handRanking, ledger });
function lcg(seed: number) { let a = seed >>> 0; return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; }; }
let hands = 0, actions = 0, errors = 0, bad = 0, split = 0, sides = 0, shorts = 0;
let cur = ""; const log = (m: string) => { bad++; if (bad < 8) console.log("MISMATCH", cur, m); };

for (let seed = 1; seed <= 150; seed++) {
  const rng = lcg(seed); cur = "seed " + seed;
  let now = 1_000_000;
  const deps = { rng, now: () => now };
  let g: Game = newLobby(now);
  const n = 2 + (seed % 8);
  for (let i = 0; i < n; i++) { const r = join(g, "p" + i, "P" + i, now); if (!r.ok) throw new Error("join"); g = r.game; }
  for (let i = 0; i < n; i++) g = setLive(g, "p" + i, true, now);
  const s = apply(g, "p0", { type: "start" }, deps);
  if (!s.ok) throw new Error("start " + s.code);
  g = s.game;
  let positions: any = null;
  const aggression = 0.2 + rng() * 0.7;
  for (let handNo = 0; handNo < 14 && g.status === "running" && g.hand; handNo++) {
    const eh = g.hand;
    const ins = g.players.filter((p) => p.inHand).sort((a, b) => a.seat - b.seat);
    // Rebuild the deck so mine deals the same cards.
    const dealt = ins.flatMap((p) => p.cards);
    const deck = [...eh.deck, ...[...dealt].reverse()];
    const seats = ins.map((p) => p.seat);
    const buttonIdx = seats.indexOf(g.positions!.button);
    const start = rules.newHand({
      no: eh.no, level: eh.level, sb: eh.sb, bb: eh.bb,
      players: ins.map((p) => ({ id: p.id, seat: p.seat, stack: p.startStack })),
      positions, deck, rng: () => (buttonIdx + 0.5) / ins.length,
    });
    if (!start.ok) { log("newHand " + start.code); break; }
    let h = start.value.hand;
    positions = start.value.positions;
    if (JSON.stringify(positions) !== JSON.stringify(g.positions)) log(`positions ${JSON.stringify(positions)} vs ${JSON.stringify(g.positions)}`);
    hands++; cur = `seed ${seed} hand ${handNo} no ${eh.no}`;
    const same = (where: string) => {
      const e = g.hand!;
      for (const mp of h.players) {
        const ep = g.players.find((p) => p.id === mp.id)!;
        if (mp.stack !== ep.stack || mp.bet !== ep.bet || mp.totalIn !== ep.totalIn || mp.folded !== ep.folded || mp.allIn !== ep.allIn) log(`${where} player ${mp.id}: mine ${mp.stack}/${mp.bet}/${mp.totalIn} engine ${ep.stack}/${ep.bet}/${ep.totalIn}`);
      }
      if (h.currentBet !== e.currentBet || h.street !== e.street || (h.actorId ?? null) !== (e.actorId ?? null) || h.board.join() !== e.board.join() || h.stage !== e.stage || h.lastFullRaiseTo !== e.lastFullRaiseTo || h.lastFullRaise !== e.lastFullRaise)
        log(`${where} state mine ${h.currentBet} ${h.street} ${h.actorId} ${h.stage} ${h.lastFullRaise}/${h.lastFullRaiseTo} engine ${e.currentBet} ${e.street} ${e.actorId} ${e.stage} ${e.lastFullRaise}/${e.lastFullRaiseTo}`);
    };
    same("after deal");
    for (let guard = 0; guard < 300 && g.hand!.stage === "betting"; guard++) {
      const actor = h.actorId!;
      const legal = rules.legalActions(h, actor);
      const options: any[] = [];
      if (legal.fold && rng() < 0.25) options.push({ type: "fold" });
      if (legal.check) options.push({ type: "check" });
      if (legal.call !== null) options.push({ type: "call" });
      if (legal.bet) {
        const r = rng();
        const to = r < aggression * 0.4 ? legal.bet.max : r < 0.6 ? legal.bet.min : legal.bet.min + Math.floor(rng() * (legal.bet.max - legal.bet.min + 1));
        options.push({ type: "bet", to }, { type: "bet", to: legal.bet.min + 1 });
      }
      if (!options.length) options.push({ type: "fold" });
      const action = options[Math.floor(rng() * options.length)];
      // the engine's legal view must agree with mine
      const mine = rules.apply(h, actor, action);
      const theirs = apply(g, actor, action, deps);
      actions++;
      if (mine.ok !== theirs.ok) { log(`ok ${JSON.stringify(action)} mine ${mine.ok} theirs ${theirs.ok ? "ok" : theirs.code}`); break; }
      if (!mine.ok || !theirs.ok) { errors++; if (!mine.ok && !theirs.ok && mine.code !== theirs.code) log(`code ${mine.code} vs ${theirs.code}`); h = h; g = g; continue; }
      h = mine.hand; g = theirs.game;
      if (g.hand!.stage === "betting" || g.hand!.stage === "runout") same(`after ${JSON.stringify(action)}`);
      if (action.type === "bet" && h.lastFullRaiseTo !== h.currentBet) shorts++;
      if (g.hand!.stage === "over") break;
    }
    // Runout: advance the engine exactly to each due time.
    for (let guard = 0; guard < 8 && g.hand && g.hand.stage === "runout"; guard++) {
      if (h.stage !== "runout") { log("stage mismatch before runout"); break; }
      now += g.hand.runoutAt! - g.actionClock;
      g = advance(g, deps).game;
      const step = rules.runoutStep(h);
      if (!step.ok) { log("runoutStep " + step.code); break; }
      h = step.hand;
    }
    if (!g.hand || g.hand.stage !== "over" || h.stage !== "over") { log(`end stage mine ${h.stage} engine ${g.hand?.stage}`); break; }
    // Compare results.
    const er = g.hand.result!, mr = h.result!;
    const norm = (r: any) => JSON.stringify({ pots: r.pots.map((p: any) => ({ amount: p.amount, eligible: p.eligible, winners: p.winners })), board: r.board, uncontested: r.uncontested, showdown: r.showdown });
    if (norm(er) !== norm(mr)) log(`result\n mine ${norm(mr)}\n engine ${norm(er)}`);
    for (const mp of h.players) {
      const ep = g.players.find((p) => p.id === mp.id)!;
      if (mp.stack !== ep.stack) log(`final stack ${mp.id} ${mp.stack} vs ${ep.stack}`);
      if (JSON.stringify(mp.shown) !== JSON.stringify(ep.shown)) log(`shown ${mp.id}`);
      if (JSON.stringify(mp.lastAction) !== JSON.stringify(ep.lastAction)) log(`lastAction ${mp.id} ${JSON.stringify(mp.lastAction)} ${JSON.stringify(ep.lastAction)}`);
    }
    if (mr.pots.length > 1) sides++;
    if (mr.pots.some((p: any) => p.winners.length > 1)) split++;
    // Move the engine on to the next hand: result pause, then any rebuy offers.
    now += g.hand.overAt! - g.actionClock;
    g = advance(g, deps).game;
    for (let k = 0; k < 4 && g.status === "running" && !g.hand; k++) { now += 31000; g = advance(g, deps).game; }
    // Hand over for the human players: show cards compare uses default; next loop continues if the engine dealt.
    if (g.hand && positions && JSON.stringify(g.positions) !== JSON.stringify(positions) && g.hand.no === eh.no) log("hand did not advance");
  }
}
console.log({ hands, actions, errors, shortAllInRaises: shorts, sides, split, mismatches: bad });
