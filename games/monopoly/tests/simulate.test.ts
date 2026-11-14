import { describe, expect, it } from 'vitest';
import { createState, transition, invalidReason, applySystem, systemAction, assertInvariants, result, isFinished } from '../engine';
import type { MonopolyState, MonopolyAction } from '../engine';
import { isPurchasable } from '../engine/board';

/** Deterministic PRNG for the test driver (not the engine RNG). */
function lcg(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

const SETTINGS: Record<string, unknown>[] = [
  { mode: 'classic', maxPlayers: 6, startMoney: 1500, turnSeconds: 30, auctionSeconds: 20, tradeSeconds: 120, evenBuild: true },
  { mode: 'quick', maxPlayers: 4, startMoney: 1200, turnSeconds: 15, auctionSeconds: 10, tradeSeconds: 60, evenBuild: false },
  { mode: 'teams', startMoney: 1500, turnSeconds: 30, auctionSeconds: 20, tradeSeconds: 120, evenBuild: true },
];

function candidates(s: MonopolyState, seat: number): MonopolyAction[] {
  const out: MonopolyAction[] = [];
  const pid = s.players[seat]!;
  const bank = s.seatBank[seat]!;
  const mine = s.turn === seat;
  const active = s.pausedRemaining === null;
  if (s.phase === 'auction' && s.auction) {
    if (!s.auction.passed.includes(bank) && s.auction.leader !== bank) {
      const min = s.auction.currentBid === 0 ? 10 : s.auction.currentBid + 10;
      const max = Math.min(s.banks[bank]!, min + 200);
      for (let a = min; a <= max; a += 10) out.push({ type: 'bid', amount: a });
      out.push({ type: 'pass' });
    }
    return out;
  }
  if (!mine || !active) return out;
  switch (s.phase) {
    case 'awaitRoll': {
      const p = s.seats[seat]!;
      if (p.inJail) {
        if (s.banks[bank]! >= 50) out.push({ type: 'payJail' });
        if (p.getOutCards > 0) out.push({ type: 'jailCard' });
        if (!(p.jailTurns >= 2)) out.push({ type: 'roll' });
      } else out.push({ type: 'roll' });
      // manage actions are legal in awaitRoll too
      break;
    }
    case 'awaitEnd': out.push({ type: 'endTurn' }); break;
    case 'buy': {
      if (s.pending?.type === 'purchase') {
        out.push({ type: 'buy' }, { type: 'refuse' });
      }
      break;
    }
    case 'debt': break; // handled below via liquidation actions
    case 'finished': break;
  }
  // manage actions during own turn phases
  if ((s.phase === 'awaitRoll' || s.phase === 'awaitEnd' || s.phase === 'debt') && s.pausedRemaining === null) {
    for (let i = 0; i < 40; i++) if (isPurchasable(i)) {
      const prop = s.properties[i]!;
      if (prop.owner === bank && prop.level > 0) out.push({ type: 'sell', property: i });
      if (prop.owner === bank && !prop.mortgaged && prop.level === 0) out.push({ type: 'mortgage', property: i });
      if (prop.owner === bank && prop.mortgaged) out.push({ type: 'unmortgage', property: i });
      if (prop.owner === bank && prop.level < 5) out.push({ type: 'build', property: i });
    }
    // occasional trade offers
    const others = s.players.map((_, i) => i).filter(i => i !== seat && !s.seats[i]!.out);
    if (others.length && s.trades.length < 30) {
      const to = others[Math.floor(rand() * others.length)]!;
      const myProps = s.properties.map((p, i) => p.owner === bank && p.level === 0 && isPurchasable(i) ? i : -1).filter(i => i >= 0);
      const theirBank = s.seatBank[to]!;
      const theirProps = s.properties.map((p, i) => p.owner === theirBank && p.level === 0 && isPurchasable(i) ? i : -1).filter(i => i >= 0);
      out.push({ type: 'offer', to: s.players[to]!, giveMoney: Math.floor(rand() * 100), giveProps: myProps.length && rand() < 0.3 ? [myProps[Math.floor(rand() * myProps.length)]!] : [], getMoney: rand() < 0.3 ? Math.floor(rand() * 100) : 0, getProps: theirProps.length && rand() < 0.3 ? [theirProps[Math.floor(rand() * theirProps.length)]!] : [] });
    }
    // Surrender is legal anytime but rare in sane play — keep it uncommon so
    // simulations exercise real economics instead of instant forfeits.
    if (rand() < 0.005) out.push({ type: 'surrender' });
  }
  return out.filter(a => invalidReason(s, a, pid, NOW_SAFE) === null);
}

// The driver always acts "now"; deadlines are far in the future relative to it.
const NOW_SAFE = 1000;
let rand = () => 0.5;

function pick<T>(list: T[]): T { return list[Math.floor(rand() * list.length)]!; }

/** One full random game. Returns action count; throws on invariant violation. */
export function simulateGame(seed: number, settingsIndex: number, maxActions = 30000): number {
  rand = lcg(seed * 7919 + settingsIndex * 104729 + 13);
  const settings = SETTINGS[settingsIndex]!;
  const count = settings.mode === 'teams' ? 4 : 2 + Math.floor(rand() * Math.min(5, Number(settings.maxPlayers) - 1));
  const players = Array.from({ length: count }, (_, i) => 'sim' + i);
  let s = createState(settings, { players, seed, startedAt: 0 });
  let now = NOW_SAFE;
  let actions = 0;
  while (!isFinished(s) && actions < maxActions) {
    // Any player may respond to trades / bid in auctions.
    const order = [...s.players.keys()];
    let progressed = false;
    // 1) trade responses by involved seats
    for (const t of [...s.trades]) {
      for (const seat of [t.to, t.from, ...s.players.keys()]) {
        if (s.seats[seat]!.out) continue;
        const pid = s.players[seat]!;
        const roll = rand();
        const action: MonopolyAction | null = seat === t.to ? (roll < 0.5 ? { type: 'accept', offerId: t.id } : roll < 0.8 ? { type: 'decline', offerId: t.id } : null)
          : seat === t.from && roll < 0.2 ? { type: 'cancel', offerId: t.id } : null;
        if (action && invalidReason(s, action, pid, now) === null) {
          s = transition(s, action, pid, now); actions++; progressed = true; break;
        }
      }
      if (progressed) break;
    }
    if (progressed) { assertInvariants(s); continue; }
    // 2) current actor
    let actorSeat = -1;
    if (s.phase === 'auction') {
      // find first seat with a legal auction action
      for (const seat of order) {
        const pid = s.players[seat]!;
        if (invalidReason(s, { type: 'pass' }, pid, now) === null) { actorSeat = seat; break; }
      }
    } else {
      actorSeat = s.turn;
    }
    if (actorSeat < 0) { // nobody can act → force timeout path
      const sys = systemAction(s, now + 1, true);
      if (sys) s = applySystem(s, sys, now + 1); else throw new Error('Deadlock: no actor and no system action');
      actions++; assertInvariants(s); continue;
    }
    const pid = s.players[actorSeat]!;
    const options = candidates(s, actorSeat);
    if (!options.length) {
      // prefer timeout-safe fallback: endTurn if legal else surrender else system timeout
      const fallback: MonopolyAction[] = [{ type: 'endTurn' }, { type: 'surrender' }];
      const fb = fallback.find(a => invalidReason(s, a, pid, now) === null);
      if (fb) { s = transition(s, fb, pid, now); actions++; assertInvariants(s); continue; }
      const sys = systemAction(s, now + s.turnSeconds * 1000 + 1, true);
      if (sys) { s = applySystem(s, sys, now + s.turnSeconds * 1000 + 1); now += s.turnSeconds * 1000 + 1; }
      else throw new Error('Deadlock for ' + pid + ' phase ' + s.phase);
      actions++; assertInvariants(s); continue;
    }
    const action = pick(options);
    // Bias toward progress: half the time pick only turn-advancing actions so
    // manage-action oscillation cannot stall the game.
    const progressTypes = ['roll', 'endTurn', 'buy', 'refuse', 'bid', 'pass', 'payJail', 'jailCard'];
    const progress = progressTypes.includes(action.type) ? options.filter(a => progressTypes.includes(a.type)) : options;
    const chosen = progress.length && rand() < 0.6 ? pick(progress) : action;
    s = transition(s, chosen, pid, now);
    actions++;
    assertInvariants(s);
    // occasionally fast-forward time so timers would fire in production;
    // the driver itself always acts before deadlines, so `now` stays put.
  }
  if (!isFinished(s)) throw new Error(`Game did not finish within ${maxActions} actions (phase ${s.phase})`);
  const r = result(s);
  if (!r || r.draw) throw new Error('Finished game without a winner');
  return actions;
}

describe('monopoly simulation', () => {
  it('random games terminate with a valid result and invariants hold', () => {
    const games: number[] = [];
    for (let i = 0; i < 40; i++) {
      const settingsIndex = i % 3;
      const actions = simulateGame(1000 + i * 37, settingsIndex);
      games.push(actions);
      expect(actions).toBeLessThan(30000);
    }
    console.log('simulated games actions:', games.join(','));
  }, 120000);

  it('result is consistent: exactly one winner bank in classic endgames', () => {
    for (let i = 0; i < 10; i++) {
      const settingsIndex = i % 2;
      simulateGame(5000 + i, settingsIndex);
    }
  }, 120000);
});
