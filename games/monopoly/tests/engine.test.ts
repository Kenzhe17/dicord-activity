import { describe, expect, it } from 'vitest';
import { createState, transition, invalidReason, assertInvariants, playerView, result, systemAction, applySystem, stateSchema } from '../engine';
import type { MonopolyState, MonopolyAction } from '../engine';
import { JAIL_BAIL, GO_BONUS, MAX_LEVEL } from '../engine/board';
import { monopolyModule } from '../server/module';

const PLAYERS = ['p1', 'p2', 'p3', 'p4'];
const base = (over: Partial<MonopolyState> = {}, settings: Record<string, unknown> = {}, players = PLAYERS) =>
  ({ ...createState({ mode: 'classic', maxPlayers: 6, ...settings }, { players, seed: 42, startedAt: 0 }), ...over });
const NOW = 1000;
const act = (s: MonopolyState, action: MonopolyAction, actor = s.players[s.turn]!, now = NOW) => transition(s, action, actor, now);
const legal = (s: MonopolyState, action: MonopolyAction, actor = s.players[s.turn]!, now = NOW) => invalidReason(s, action, actor, now) === null;

/** Force a purchase decision on cell `index` for the current turn seat. */
function atPurchase(s: MonopolyState, index: number): MonopolyState {
  const next = structuredClone(s);
  next.seats[next.turn]!.position = index;
  next.pending = { type: 'purchase', index };
  next.phase = 'buy';
  next.deadline = NOW + 30000;
  assertInvariants(next);
  return next;
}

describe('monopoly engine — purchase & rent', () => {
  it('buying deducts money, sets owner, bank-level in teams', () => {
    const s0 = base();
    const s = atPurchase(s0, 1);
    const before = s.banks[0]!;
    const s2 = act(s, { type: 'buy' });
    expect(s2.properties[1]!.owner).toBe(0);
    expect(s2.banks[0]).toBe(before - 60);
    expect(s2.phase).toBe('awaitEnd');
    expect(legal(s, { type: 'buy' })).toBe(true);
  });

  it('cannot buy with insufficient funds; refusal starts an auction', () => {
    const s = atPurchase(base({ banks: [10, 1500, 1500, 1500] }), 1);
    expect(legal(s, { type: 'buy' })).toBe(false);
    const s2 = act(s, { type: 'refuse' });
    expect(s2.phase).toBe('auction');
    expect(s2.auction!.index).toBe(1);
  });

  it('auction: bids raise price, pass resolves, winner pays', () => {
    let s = base();
    s = atPurchase(s, 6);
    s = act(s, { type: 'refuse' });
    expect(s.phase).toBe('auction');
    const p2 = s.players[1]!, p3 = s.players[2]!, p4 = s.players[3]!;
    s = transition(s, { type: 'bid', amount: 30 }, p2, NOW);
    expect(s.auction!.currentBid).toBe(30);
    s = transition(s, { type: 'bid', amount: 50 }, p3, NOW + 1);
    expect(s.auction!.leader).toBe(2);
    // too-low and over-balance bids rejected
    expect(invalidReason(s, { type: 'bid', amount: 45 }, p4, NOW + 2)).toBeTruthy();
    expect(invalidReason(s, { type: 'bid', amount: 99999 }, p4, NOW + 2)).toBeTruthy();
    s = transition(s, { type: 'pass' }, p4, NOW + 3);
    s = transition(s, { type: 'pass' }, p2, NOW + 4);
    s = transition(s, { type: 'pass' }, s.players[0]!, NOW + 5); // decliner's bank passes too
    // after all non-leaders pass the auction resolves for bank 2
    expect(s.phase).not.toBe('auction');
    expect(s.properties[6]!.owner).toBe(2);
    expect(s.banks[2]).toBe(1500 - 50);
  });

  it('auction with no bids leaves property unowned', () => {
    let s = base();
    s = atPurchase(s, 3);
    s = act(s, { type: 'refuse' });
    for (const pid of s.players) if (s.phase === 'auction') s = transition(s, { type: 'pass' }, pid, NOW);
    expect(s.properties[3]!.owner).toBeNull();
    expect(s.phase).toBe('awaitEnd');
  });
});

describe('monopoly engine — building, mortgage, trades', () => {
  /** Give seat 0 the full brown group (cells 1,3). */
  function monopoly(s: MonopolyState): MonopolyState {
    const next = structuredClone(s);
    next.properties[1]!.owner = 0; next.properties[3]!.owner = 0;
    return next;
  }

  it('build requires full group and even levels; rent grows', () => {
    let s = monopoly(base());
    s.turn = 0;
    s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    expect(legal(s, { type: 'build', property: 1 })).toBe(true);
    s = act(s, { type: 'build', property: 1 });
    expect(s.properties[1]!.level).toBe(1);
    expect(s.banks[0]).toBe(1500 - 50);
    // even-build: cannot build second level on 1 while 3 is level 0
    expect(legal(s, { type: 'build', property: 1 })).toBe(false);
    expect(legal(s, { type: 'build', property: 3 })).toBe(true);
    s = act(s, { type: 'build', property: 3 });
    expect(legal(s, { type: 'build', property: 1 })).toBe(true);
  });

  it('mortgage gives half price, blocks rent & building; unmortgage costs +10%', () => {
    let s = monopoly(base());
    s.turn = 0; s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    s = act(s, { type: 'mortgage', property: 1 });
    expect(s.properties[1]!.mortgaged).toBe(true);
    expect(s.banks[0]).toBe(1500 + 30);
    expect(legal(s, { type: 'build', property: 1 })).toBe(false);
    s = act(s, { type: 'unmortgage', property: 1 });
    expect(s.properties[1]!.mortgaged).toBe(false);
    expect(s.banks[0]).toBe(1500 + 30 - 33);
  });

  it('trade: offer → accept transfers money and property atomically', () => {
    let s = base();
    s.properties[1]!.owner = 0; s.properties[6]!.owner = 1;
    s.turn = 0; s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    s = act(s, { type: 'offer', to: 'p2', giveMoney: 100, giveProps: [1], getMoney: 0, getProps: [6] });
    expect(s.trades).toHaveLength(1);
    const offer = s.trades[0]!;
    // target accepts
    s = transition(s, { type: 'accept', offerId: offer.id }, 'p2', NOW + 1);
    expect(s.properties[1]!.owner).toBe(1);
    expect(s.properties[6]!.owner).toBe(0);
    expect(s.banks[0]).toBe(1500 - 100);
    expect(s.banks[1]).toBe(1500 + 100);
    expect(s.trades).toHaveLength(0);
  });

  it('trade accept revalidates: stolen property blocks the deal', () => {
    let s = base();
    s.properties[1]!.owner = 0; s.properties[6]!.owner = 1;
    s.turn = 0; s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    s = act(s, { type: 'offer', to: 'p2', giveMoney: 0, giveProps: [1], getMoney: 0, getProps: [6] });
    const offer = s.trades[0]!;
    // property 1 changes hands before acceptance
    s.properties[1]!.owner = 2;
    expect(invalidReason(s, { type: 'accept', offerId: offer.id }, 'p2', NOW + 1)).toBeTruthy();
    // decline works
    expect(invalidReason(s, { type: 'decline', offerId: offer.id }, 'p2', NOW + 1)).toBeNull();
    s = transition(s, { type: 'decline', offerId: offer.id }, 'p2', NOW + 1);
    expect(s.trades).toHaveLength(0);
  });

  it('cancel only by author; expired offers rejected', () => {
    let s = base();
    s.properties[1]!.owner = 0; s.properties[6]!.owner = 1;
    s.turn = 0; s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    s = act(s, { type: 'offer', to: 'p2', giveMoney: 10, giveProps: [], getMoney: 0, getProps: [] });
    const offer = s.trades[0]!;
    expect(invalidReason(s, { type: 'cancel', offerId: offer.id }, 'p2', NOW + 1)).toBeTruthy();
    expect(invalidReason(s, { type: 'cancel', offerId: offer.id }, 'p1', NOW + 1)).toBeNull();
    expect(invalidReason(s, { type: 'accept', offerId: offer.id }, 'p2', offer.expiresAt + 1)).toBeTruthy();
  });
});

describe('monopoly engine — jail, debt, bankruptcy', () => {
  function inJail(s: MonopolyState): MonopolyState {
    const next = structuredClone(s);
    next.seats[next.turn]!.inJail = true;
    next.seats[next.turn]!.jailTurns = 0;
    next.phase = 'awaitRoll'; next.deadline = NOW + 30000;
    return next;
  }

  it('payJail releases and allows a normal roll', () => {
    let s = inJail(base());
    expect(legal(s, { type: 'payJail' })).toBe(true);
    const before = s.banks[0]!;
    s = act(s, { type: 'payJail' });
    expect(s.seats[0]!.inJail).toBe(false);
    expect(s.banks[0]).toBe(before - JAIL_BAIL);
    expect(s.phase).toBe('awaitRoll');
    expect(legal(s, { type: 'roll' })).toBe(true);
  });

  it('jail card releases for free', () => {
    let s = inJail(base());
    s.seats[0]!.getOutCards = 1;
    s = act(s, { type: 'jailCard' });
    expect(s.seats[0]!.inJail).toBe(false);
    expect(s.seats[0]!.getOutCards).toBe(0);
    expect(s.banks[0]).toBe(1500);
  });

  it('debt: selling buildings raises funds until the debt settles', () => {
    let s = base({ banks: [200, 1500, 1500, 1500] });
    s.properties[1]!.owner = 0; s.properties[3]!.owner = 0; s.properties[1]!.level = 2;
    s.pending = { type: 'debt', amount: 100, creditor: 1, returnPhase: 'awaitEnd', forSeat: 0 };
    s.phase = 'debt'; s.deadline = NOW + 60000;
    // balance 200 >= 100 already? No: debt requires balance >= amount → it settles immediately on next check.
    // Use amount above balance: 300.
    s.pending = { ...s.pending, amount: 300 };
    s = act(s, { type: 'sell', property: 1 }); // +25 → 225
    s = act(s, { type: 'sell', property: 1 }); // +25 → 250
    expect(s.phase).toBe('debt');
    s = act(s, { type: 'mortgage', property: 3 }); // +30 → 280
    s = act(s, { type: 'mortgage', property: 1 }); // +30 → 310 ≥ 300 → settles
    expect(s.phase).toBe('awaitEnd');
    expect(s.banks[0]).toBe(10);
    expect(s.banks[1]).toBe(1500 + 300);
  });

  it('debt timeout liquidates then bankrupts when still short', () => {
    const s = base({ banks: [100, 1500, 1500, 1500] });
    s.properties[1]!.owner = 0; s.properties[6]!.owner = 0;
    s.pending = { type: 'debt', amount: 5000, creditor: 1, returnPhase: 'awaitEnd', forSeat: 0 };
    s.phase = 'debt'; s.deadline = NOW + 1;
    const next = applySystem(s, { type: 'timeout' }, NOW + 2);
    expect(next.seats[0]!.out).toBe(true);
    expect(next.phase).toBe('awaitRoll'); // turn passed to seat 1
    expect(next.turn).toBe(1);
    // assets went to creditor bank 1
    expect(next.properties[1]!.owner).toBe(1);
    expect(next.properties[6]!.owner).toBe(1);
    expect(next.banks[1]).toBeGreaterThan(1500);
  });

  it('surrender bankrupts to the bank: property returns unowned without buildings', () => {
    let s = base();
    s.properties[1]!.owner = 0; s.properties[1]!.level = 3;
    s.properties[6]!.owner = 0;
    const before = s.banks[0]!;
    s = act(s, { type: 'surrender' }, 'p1');
    expect(s.seats[0]!.out).toBe(true);
    expect(s.forfeited).toContain(0);
    expect(s.properties[1]!.owner).toBeNull();
    expect(s.properties[1]!.level).toBe(0);
    expect(s.banks[0]).toBe(0);
    expect(s.phase).not.toBe('finished'); // 3 banks remain
    void before;
  });

  it('last bank standing finishes the game with correct result', () => {
    let s = base();
    s.properties[1]!.owner = 3;
    // bankrupt everyone but seat 3 via surrender (off-turn allowed)
    s = transition(s, { type: 'surrender' }, 'p1', NOW);
    s = transition(s, { type: 'surrender' }, 'p2', NOW + 1);
    s = transition(s, { type: 'surrender' }, 'p3', NOW + 2);
    expect(s.phase).toBe('finished');
    const r = result(s)!;
    expect(r.winners).toEqual(['p4']);
    expect(r.losers).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('monopoly engine — timers, pause, serialization', () => {
  it('awaitEnd timeout passes the turn', () => {
    const s = base();
    s.phase = 'awaitEnd'; s.deadline = NOW;
    const next = applySystem(s, { type: 'timeout' }, NOW + 31000);
    expect(next.turn).toBe(1);
    expect(next.phase).toBe('awaitRoll');
  });

  it('buy timeout starts an auction', () => {
    const s = atPurchase(base(), 8);
    s.deadline = NOW;
    const next = applySystem(s, { type: 'timeout' }, NOW + 31000);
    expect(next.phase).toBe('auction');
    expect(next.auction!.index).toBe(8);
  });

  it('pause preserves remaining time; resume restores it', () => {
    const s = base();
    s.deadline = NOW + 20000;
    const paused = applySystem(s, { type: 'pause' }, NOW + 5000);
    expect(paused.pausedRemaining).toBe(15000);
    const resumed = applySystem(paused, { type: 'resume' }, NOW + 60000);
    expect(resumed.deadline).toBe(NOW + 60000 + 15000);
    expect(resumed.pausedRemaining).toBeNull();
  });

  it('serialize/restore roundtrip preserves state', () => {
    const s = base();
    const restored = stateSchema.parse(JSON.parse(JSON.stringify(s)));
    assertInvariants(restored);
    expect(restored).toEqual(s);
  });

  it('module view exposes flags and hides deck contents', () => {
    const s = createState({ mode: 'classic' }, { players: ['a', 'b'], seed: 7, startedAt: 0 });
    const view = playerView(s, 'a');
    expect(view.flags.canRoll).toBe(true);
    expect(view.deckCounts.chance).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('chance:advance');
    expect(monopolyModule.stateVersion).toBe(1);
  });

  it('systemAction pauses when everyone offline', () => {
    const s = createState({ mode: 'classic' }, { players: ['a', 'b'], seed: 7, startedAt: 0 });
    expect(systemAction(s, NOW, false)).toEqual({ type: 'pause' });
    expect(systemAction(s, NOW, true)).toBeNull();
  });
});

describe('monopoly engine — rolls and movement', () => {
  it('roll moves the piece and resolves the landing cell', () => {
    const s = createState({ mode: 'classic' }, { players: ['a', 'b'], seed: 3, startedAt: 0 });
    const s2 = act(s, { type: 'roll' });
    expect(s2.dice).not.toBeNull();
    expect(s2.seats[0]!.position).toBe(s2.dice![0] + s2.dice![1]);
    expect(['awaitEnd', 'awaitRoll', 'buy', 'debt', 'auction']).toContain(s2.phase);
  });

  it('passing GO pays the bonus', () => {
    // craft: seat at 38, roll will pass 0
    let s = base();
    s.seats[0]!.position = 38;
    s.turn = 0; s.phase = 'awaitRoll'; s.deadline = NOW + 30000;
    const before = s.banks[0]!;
    // roll until position wraps (any roll from 38 with sum>=2 passes GO)
    s = act(s, { type: 'roll' });
    if (s.seats[0]!.position < 38) expect(s.banks[0]).toBe(before + GO_BONUS);
  });

  it('teams mode shares a bank between paired seats', () => {
    const s = createState({ mode: 'teams' }, { players: ['a', 'b', 'c', 'd'], seed: 5, startedAt: 0 });
    expect(s.banks).toHaveLength(2);
    expect(s.bankMembers).toEqual([[0, 1], [2, 3]]);
    const view = playerView(s, 'a');
    expect(view.players[0]!.bank).toBe(0);
    expect(view.players[1]!.bank).toBe(0);
    expect(view.players[2]!.bank).toBe(1);
  });

  it('teams mode rejects non-4 player counts', () => {
    expect(() => createState({ mode: 'teams' }, { players: ['a', 'b', 'c'], seed: 5, startedAt: 0 })).toThrow();
  });

  it('hotel is the max level', () => {
    let s = base();
    for (const i of [1, 3]) s.properties[i]!.owner = 0;
    s.turn = 0; s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    // build evenly to level 5 on both
    for (let lvl = 0; lvl < MAX_LEVEL; lvl++) {
      for (const i of [1, 3]) if (legal(s, { type: 'build', property: i })) s = act(s, { type: 'build', property: i });
    }
    expect(s.properties[1]!.level).toBe(MAX_LEVEL);
    expect(legal(s, { type: 'build', property: 1 })).toBe(false);
  });
});

describe('monopoly engine — hardening regressions', () => {
  it('auction mirrors its deadline into s.deadline (long auction not cut by turn timer)', () => {
    const s0 = base({}, { turnSeconds: 30, auctionSeconds: 120 });
    const s = atPurchase(s0, 6);
    const s2 = act(s, { type: 'refuse' });
    expect(s2.phase).toBe('auction');
    expect(s2.deadline).toBe(s2.auction!.deadline);
    expect(s2.deadline - NOW).toBe(120000);
    // A bid refreshes both deadlines together.
    const p2 = s2.players[1]!;
    const s3 = transition(s2, { type: 'bid', amount: 70 }, p2, NOW + 5000);
    expect(s3.deadline).toBe(s3.auction!.deadline);
    expect(s3.deadline).toBe(NOW + 5000 + 120000);
  });

  it('trade accept is rejected during a live auction', () => {
    let s = base();
    s = atPurchase(s, 6);
    s = act(s, { type: 'refuse' }); // auction starts, turn seat is decliner
    const to = s.players[1]!;
    const offer = { type: 'offer' as const, to, giveMoney: 0, giveProps: [], getMoney: 0, getProps: [] };
    // Send offer before auction (awaitEnd-ish phase is fine — force via direct transition on a clone)
    const pre = structuredClone(s);
    pre.phase = 'awaitEnd'; pre.auction = null; pre.pending = null; pre.deadline = NOW + 30000;
    const offered = transition(pre, offer, s.players[s.turn]!, NOW);
    const tradeId = offered.trades[0]!.id;
    s = { ...s, trades: offered.trades };
    assertInvariants(s);
    expect(invalidReason(s, { type: 'accept', offerId: tradeId }, to, NOW)).toBeTruthy();
  });

  it('jail allows a third roll attempt before forced release', () => {
    const s = base();
    s.seats[0]!.inJail = true; s.seats[0]!.jailTurns = 2;
    s.phase = 'awaitRoll'; s.deadline = NOW + 30000;
    // jailTurns=2 → still allowed to roll (third attempt)
    expect(legal(s, { type: 'roll' })).toBe(true);
    // jailTurns=3 → roll blocked; the timeout path force-releases.
    s.seats[0]!.jailTurns = 3;
    expect(legal(s, { type: 'roll' })).toBe(false);
    const s2 = applySystem(s, { type: 'timeout' }, NOW + 31000);
    expect(s2.seats[0]!.inJail).toBe(false);
  });

  it('cannot build while a group-mate is mortgaged', () => {
    const s = base();
    for (const i of [1, 3]) { s.properties[i]!.owner = 0; }
    s.properties[3]!.mortgaged = true;
    s.turn = 0; s.phase = 'awaitEnd'; s.deadline = NOW + 30000;
    s.banks[0] = 5000;
    expect(legal(s, { type: 'build', property: 1 })).toBe(false);
    s.properties[3]!.mortgaged = false;
    expect(legal(s, { type: 'build', property: 1 })).toBe(true);
  });
});
