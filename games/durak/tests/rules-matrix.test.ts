import { describe, expect, it } from 'vitest';
import {
  transition, playerView, result, applySystem, assertInvariants,
} from '../engine';
import type { DurakState, DurakAction } from '../engine';
import { fixture, move, passAll } from './fixture';

// trump = spades (suit 3) unless stated; card id = suit*9 + rank, ranks 6..A = 0..8.
const byId = (s: DurakState, player: string, action: DurakAction, now = 1) =>
  transition(s, action, player, now);

describe('attack limit (RULES §6)', () => {
  it('caps the initial attack at min(6, defender hand size) and never shrinks as the defender plays', () => {
    // Defender starts with 3 cards -> limit 3 for the whole bout.
    let s = fixture(
      [[9, 18, 27, 0, 1, 2], [10, 19, 28], [4, 5, 6, 7, 8, 11]],
      { mode: 'throw-in', limit: 3 },
    );
    // Four same-rank attacks exceed the limit of 3 and leave state untouched.
    const before = JSON.stringify(s);
    expect(() => move(s, { type: 'attack', cards: [9, 18, 27, 0] })).toThrow();
    expect(JSON.stringify(s)).toBe(before);

    s = move(s, { type: 'attack', cards: [9] });
    expect(s.limit).toBe(3);
    s = move(s, { type: 'defend', card: 10, target: 9 }); // d7 > d6
    expect(s.hands[1]).toHaveLength(2);
    expect(s.limit).toBe(3); // not reduced by the defense
    s = move(s, { type: 'throw', cards: [18] }); // h6, rank 0 seen
    s = move(s, { type: 'defend', card: 19, target: 18 }); // h7 > h6
    expect(s.hands[1]).toHaveLength(1);
    expect(s.limit).toBe(3);
    // table = 2, limit = 3: a two-card throw of seen ranks would make 4 > 3.
    expect(() => move(s, { type: 'throw', cards: [27, 0] })).toThrow();
    expect(() => move(s, { type: 'throw', cards: [2] })).toThrow(); // rank 2 not on table
    s = move(s, { type: 'throw', cards: [27] }); // s6, rank 0 seen -> table = 3 = limit
    s = move(s, { type: 'defend', card: 28, target: 27 }); // s7 > s6
    expect(s.hands[1]).toHaveLength(0);
    expect(s.limit).toBe(3);
    // Full cover at the limit settles immediately: table -> discard.
    expect(s.phase).toBe('opening');
    expect(s.table).toHaveLength(0);
    expect(s.discard).toEqual(expect.arrayContaining([9, 10, 18, 19, 27, 28]));
    // Defender emptied with an empty deck -> exits right after the bout.
    expect(s.active).toEqual([0, 2]);
    expect(s.hands[1]).toEqual([]);
    assertInvariants(s);
  });

  it('still allows a multi-card throw that fits exactly under the limit', () => {
    let s = fixture(
      [[9, 18, 27, 1, 2, 3], [10, 19, 28], [4, 5, 6, 7, 8, 11]],
      { mode: 'throw-in', limit: 3 },
    );
    s = move(s, { type: 'attack', cards: [9] });
    s = move(s, { type: 'defend', card: 10, target: 9 });
    // table=1, limit=3: throwing [18,27] reaches exactly 3 in one action.
    s = move(s, { type: 'throw', cards: [18, 27] });
    expect(s.table).toHaveLength(3);
    expect(s.phase).toBe('defending');
    s = move(s, { type: 'defend', card: 19, target: 18 });
    s = move(s, { type: 'defend', card: 28, target: 27 });
    expect(s.phase).toBe('opening'); // 3 >= limit -> discard, no throw round
    expect(s.discard).toEqual(expect.arrayContaining([9, 18, 27, 10, 19, 28]));
    assertInvariants(s);
  });
});

describe('transfer mode (RULES §7)', () => {
  it('rejects transfer in throw-in mode and after any defense card is played', () => {
    const hands = [[9, 18, 1, 2, 3, 4], [10, 19, 27, 5, 6, 7], [11, 12, 13, 14, 15, 16]];
    let s = fixture(hands, { mode: 'throw-in' });
    s = move(s, { type: 'attack', cards: [9, 18] });
    s = move(s, { type: 'defend', card: 10, target: 9 });
    expect(() => move(s, { type: 'transfer', cards: [27] })).toThrow(); // wrong mode

    s = fixture(hands, { mode: 'transfer' });
    s = move(s, { type: 'attack', cards: [9, 18] });
    s = move(s, { type: 'defend', card: 10, target: 9 }); // one cover played
    expect(s.table.some(p => p.defense !== null)).toBe(true);
    expect(() => move(s, { type: 'transfer', cards: [27] })).toThrow(); // covered card locks transfer
    s = move(s, { type: 'defend', card: 19, target: 18 });
    expect(s.phase).toBe('throwing');
    assertInvariants(s);
  });

  it('enforces recipient capacity table+added <= min(6, recipient hand) and recomputes the limit', () => {
    // p2 has only 3 cards; the table already has 2 attacks.
    let s = fixture(
      [[9, 18, 1, 2, 3, 4], [10, 19, 27, 0, 5, 6], [11, 20, 29]],
      { mode: 'transfer' },
    );
    s = move(s, { type: 'attack', cards: [9, 18] });
    // 2 + 2 = 4 > min(6, 3) = 3 -> rejected; the table is untouched.
    expect(() => move(s, { type: 'transfer', cards: [27, 0] })).toThrow();
    expect(s.table).toHaveLength(2);
    s = move(s, { type: 'transfer', cards: [27] });
    expect(s.defender).toBe(2);
    expect(s.lead).toBe(1); // transferring defender becomes the lead attacker
    expect(s.original).toBe(0); // original attacker preserved for refill
    expect(s.limit).toBe(3); // recomputed from the NEW defender's hand
    expect(s.table).toHaveLength(3);
    expect(s.table.every(p => p.attack % 9 === 0)).toBe(true); // still one rank
    // The new defender covers all three attacks with exactly their 3 cards.
    s = move(s, { type: 'defend', card: 11, target: 9 }); // d8 > d6
    s = move(s, { type: 'defend', card: 20, target: 18 }); // h8 > h6
    s = move(s, { type: 'defend', card: 29, target: 27 }); // s8 > s6
    expect(s.phase).toBe('opening'); // 3 >= limit -> settle
    expect(s.hands[2]).toEqual([]);
    expect(s.active).toEqual([0, 1]); // p2 emptied with an empty deck -> out
    assertInvariants(s);
  });

  it('allows chains of 3+ players including a return to the original attacker', () => {
    let s = fixture(
      [[9, 10, 28, 29, 30, 31], [0, 1, 2, 3, 4, 5], [27, 6, 7, 8, 11, 12]],
      { mode: 'transfer' },
    );
    s = move(s, { type: 'attack', cards: [9] });
    s = move(s, { type: 'transfer', cards: [0] }); // p1 -> p2
    expect(s.defender).toBe(2);
    expect(s.lead).toBe(1);
    s = move(s, { type: 'transfer', cards: [27] }); // p2 -> back to original p0 (3 active: legal)
    expect(s.defender).toBe(0);
    expect(s.original).toBe(0);
    expect(s.lead).toBe(2);
    expect(s.actor).toBe(0);
    expect(s.table).toHaveLength(3);
    // Original attacker is now the defender and covers all three rank-0 attacks.
    s = move(s, { type: 'defend', card: 10, target: 9 }); // d7 > d6
    s = move(s, { type: 'defend', card: 28, target: 0 }); // s7 trump > c6
    s = move(s, { type: 'defend', card: 29, target: 27 }); // s8 > s6
    expect(s.phase).toBe('throwing');
    s = passAll(s);
    expect(s.phase).toBe('opening');
    assertInvariants(s);
  });

  it('forbids transferring back to the original attacker with exactly two active seats', () => {
    // Three seats exist but p2 has already left: only p0/p1 are active.
    let s = fixture(
      [[9, 11, 12, 13, 14, 15], [0, 10, 1, 2, 3, 4], []],
      { mode: 'transfer', active: [0, 1] },
    );
    s = move(s, { type: 'attack', cards: [9] });
    // nextSeat(1) wraps past inactive p2 to p0 == original -> forbidden for 2 active.
    expect(() => move(s, { type: 'transfer', cards: [0] })).toThrow();
    expect(s.table).toHaveLength(1);
    s = move(s, { type: 'defend', card: 10, target: 9 }); // d7 > d6
    expect(s.phase).toBe('throwing');
    assertInvariants(s);
  });

  it('rejects transfer onto an empty-hand seat, which stays in the rotation and refills', () => {
    let s = fixture(
      [[9, 11, 12, 13, 14, 15], [10, 0, 16, 17, 5, 6], []],
      { mode: 'transfer', deck: [20, 21, 22, 23, 24], trumpCard: 35 },
    );
    s = move(s, { type: 'attack', cards: [9] });
    // p2 is active but holds 0 cards: 1 attack + 1 transfer > min(6,0)=0.
    expect(() => move(s, { type: 'transfer', cards: [0] })).toThrow();
    s = move(s, { type: 'defend', card: 10, target: 9 }); // d7 > d6
    s = passAll(s); // p0 passes; p2 is skipped in the queue (empty hand) but not removed
    expect(s.phase).toBe('opening');
    // p2 was NOT skipped out of the game: it refilled from the deck during settle.
    expect(s.active).toEqual([0, 1, 2]);
    expect(s.hands[0]).toContain(20); // original attacker refills first
    expect(s.hands[2]).toEqual([21, 22, 23, 24]);
    expect(s.deck).toEqual([]);
    // The defender refills last and finds the deck already empty.
    expect(s.hands[1]).toEqual([0, 16, 17, 5, 6]);
    expect(s.actor).toBe(1); // defender becomes next attacker after a discard
    expect(s.defender).toBe(2);
    assertInvariants(s);
  });
});

describe('throw-in queue (RULES §5)', () => {
  it('only allows table ranks (incl. defense ranks), never lets the defender throw, and resets passes each round', () => {
    // 5 seats: p3 active but empty-handed, p1 is defender. Queue must be [0,2,4].
    let s = fixture(
      [
        [9, 0, 18, 30, 31, 32],    // p0 attacker
        [10, 2, 28, 19, 27, 5],    // p1 defender
        [20, 21, 22, 23, 24, 25],  // p2
        [],                         // p3 empty but active
        [11, 15, 16, 17, 26, 35],   // p4
      ],
      { mode: 'throw-in', deck: [33, 34], trumpCard: 33 },
    );
    s = move(s, { type: 'attack', cards: [9] });
    s = move(s, { type: 'defend', card: 10, target: 9 }); // d7 > d6
    expect(s.phase).toBe('throwing');
    expect(s.actor).toBe(0); // lead attacker acts first
    expect(s.queue).toEqual([0, 2, 4]); // defender 1 and empty 3 skipped

    // The defender can never throw to himself.
    expect(playerView(s, 'p1').legalActions).toEqual([]);
    expect(() => byId(s, 'p1', { type: 'throw', cards: [5] })).toThrow();
    // A rank not on the table (p0's spade fillers are rank 3/4/5) is rejected.
    expect(() => move(s, { type: 'throw', cards: [30] })).toThrow();

    // Round 1: p0 throws club-6, p1 covers with club-8.
    s = move(s, { type: 'throw', cards: [0] });
    s = move(s, { type: 'defend', card: 2, target: 0 }); // c8 > c6
    expect(s.phase).toBe('throwing');
    expect(s.actor).toBe(0); // queue restarted at the lead attacker
    expect(s.queue).toEqual([0, 2, 4]); // passes were reset

    // p0 passes -> p2 -> p4; p4 throws d8 (rank 2 seen via the club-8 defense).
    s = move(s, { type: 'pass' });
    expect(s.actor).toBe(2);
    s = move(s, { type: 'pass' });
    expect(s.actor).toBe(4);
    s = move(s, { type: 'throw', cards: [11] }); // d8, rank 2 on table
    s = move(s, { type: 'defend', card: 28, target: 11 }); // s7 trump beats d8
    expect(s.actor).toBe(0);

    // p0 throws heart-6; p1 covers with heart-7.
    s = move(s, { type: 'throw', cards: [18] });
    s = move(s, { type: 'defend', card: 19, target: 18 }); // h7 > h6
    expect(s.actor).toBe(0);

    // p2 PASSED two rounds ago but is back in the queue: passes reset per round.
    s = move(s, { type: 'pass' });
    expect(s.actor).toBe(2);
    s = move(s, { type: 'throw', cards: [20] }); // h8, rank 2 still on table
    s = move(s, { type: 'defend', card: 27, target: 20 }); // s6 trump beats h8
    expect(s.actor).toBe(0);

    // Everyone passes -> discard; refill order proves original-first / defender-last.
    s = move(s, { type: 'pass' });
    expect(s.actor).toBe(2);
    s = move(s, { type: 'pass' });
    expect(s.actor).toBe(4);
    s = move(s, { type: 'pass' });
    expect(s.phase).toBe('opening');
    expect(s.table).toHaveLength(0);
    // 10 table cards went to the discard.
    for (const c of [9, 10, 0, 2, 11, 28, 18, 19, 20, 27]) expect(s.discard).toContain(c);
    // Refill: original attacker p0 first (took both deck cards), p3 was empty and
    // got nothing before the deck ran out, defender p1 refilled last with nothing left.
    expect(s.hands[0]).toEqual([30, 31, 32, 33, 34]);
    expect(s.hands[3]).toEqual([]);
    expect(s.hands[1]).toEqual([5]); // defender refilled last, deck already empty
    expect(s.active).toEqual([0, 1, 2, 4]); // only the empty-handed p3 exited
    expect(s.actor).toBe(1); // defender becomes next attacker after a discard
    expect(s.defender).toBe(2);
    assertInvariants(s);
  });
});

describe('taking (RULES §8)', () => {
  it('lets the defender take with uncovered cards even when defendable, then allows throws to the preserved limit', () => {
    let s = fixture(
      [[9, 18, 27, 0, 1, 2], [10, 19, 5, 6, 7, 8], [20, 21, 22, 23, 24, 25]],
      { mode: 'throw-in' },
    );
    s = move(s, { type: 'attack', cards: [9, 18] });
    s = move(s, { type: 'defend', card: 10, target: 9 }); // 19 could still cover 18
    expect(s.hands[1]).toContain(19);
    s = move(s, { type: 'take' }); // voluntary take with one uncovered card
    expect(s.phase).toBe('taking');
    expect(s.table).toHaveLength(2); // cards stay on the table
    expect(s.limit).toBe(6); // limit preserved from the bout start
    expect(s.actor).toBe(0); // lead attacker first in the taking queue
    expect(s.queue).toEqual([0, 2]); // defender excluded
    // Defense/transfer are no longer possible.
    expect(() => move(s, { type: 'defend', card: 19, target: 18 })).toThrow();
    expect(() => move(s, { type: 'transfer', cards: [27] })).toThrow();
    s = move(s, { type: 'throw', cards: [27] }); // rank 0 still on the table
    expect(s.table).toHaveLength(3);
    s = move(s, { type: 'pass' });
    expect(s.actor).toBe(2);
    s = move(s, { type: 'pass' });
    // The taker receives ALL table cards: both attacks and the defense card.
    expect(s.phase).toBe('opening');
    expect(s.hands[1]).toEqual(expect.arrayContaining([9, 10, 18, 27, 19, 5, 6, 7, 8]));
    expect(s.actor).toBe(2); // next active seat after the final defender
    expect(s.defender).toBe(0);
    assertInvariants(s);
  });

  it('settles immediately on take when the table already reached the limit', () => {
    // Defender has 2 cards -> limit 2; two attacks fill it.
    let s = fixture(
      [[9, 18, 1, 2, 3, 4], [10, 19], [11, 12, 13, 14, 15, 16]],
      { mode: 'throw-in', limit: 2 },
    );
    s = move(s, { type: 'attack', cards: [9, 18] });
    s = move(s, { type: 'defend', card: 10, target: 9 });
    s = move(s, { type: 'take' }); // no taking phase: table is at the limit
    expect(s.phase).toBe('opening');
    expect(s.table).toHaveLength(0);
    // Taker gets attacks AND the played defense card.
    expect(s.hands[1]).toEqual(expect.arrayContaining([10, 19, 9, 18]));
    assertInvariants(s);
  });
});

describe('settle, refill and exits (RULES §9-10)', () => {
  it('refills original attacker first, empty seats next, defender last; trump card last', () => {
    let s = fixture(
      [[9, 11, 12, 13, 14, 15], [10, 16, 17, 5, 6, 7], [20, 21]],
      { mode: 'throw-in', deck: [22, 23, 24, 35], trumpCard: 35 },
    );
    s = move(s, { type: 'attack', cards: [9] });
    s = move(s, { type: 'defend', card: 10, target: 9 });
    s = passAll(s);
    // p0 needed 1 -> took 22. p2 needed 4 but only 23,24,35 remained (trump last).
    expect(s.hands[0]).toEqual([11, 12, 13, 14, 15, 22]);
    expect(s.hands[2]).toEqual([20, 21, 23, 24, 35]);
    // Defender refilled last and the deck was already empty.
    expect(s.hands[1]).toEqual([16, 17, 5, 6, 7]);
    expect(s.deck).toEqual([]);
    expect(s.actor).toBe(1);
    expect(s.defender).toBe(2);
    assertInvariants(s);
  });

  it('keeps an emptied attacker active until settle, skips them in the queue and exits them after', () => {
    let s = fixture(
      [[9], [10, 19, 5, 6, 7, 8], [20, 21, 22, 23, 24, 25]],
      { mode: 'throw-in' },
    );
    s = move(s, { type: 'attack', cards: [9] }); // p0's hand is now empty
    s = move(s, { type: 'defend', card: 10, target: 9 });
    expect(s.phase).toBe('throwing');
    expect(s.active).toEqual([0, 1, 2]); // empty hand mid-bout is NOT an exit
    expect(s.queue).toEqual([2]); // lead attacker skipped: empty hand
    expect(s.actor).toBe(2);
    s = move(s, { type: 'pass' }); // queue drains -> settle
    expect(s.phase).toBe('opening');
    expect(s.active).toEqual([1, 2]); // p0 exits only now: deck empty + hand empty
    expect(s.actor).toBe(1); // defender attacks next after a discard
    expect(s.defender).toBe(2);
    assertInvariants(s);
  });

  it('produces a shared draw when every hand empties on an empty deck', () => {
    // 3 players, all cards played exactly, deck empty -> 0 active = draw.
    let s = fixture(
      [[0], [2, 28], [11]],
      { mode: 'throw-in', limit: 2 },
    );
    s = move(s, { type: 'attack', cards: [0] }); // c6
    s = move(s, { type: 'defend', card: 2, target: 0 }); // c8 > c6
    expect(s.phase).toBe('throwing');
    expect(s.actor).toBe(2); // p0 skipped (empty), defender skipped
    s = move(s, { type: 'throw', cards: [11] }); // d8, rank 2 seen via defense
    s = move(s, { type: 'defend', card: 28, target: 11 }); // s7 trump beats d8
    expect(s.phase).toBe('finished');
    expect(s.active).toEqual([]);
    expect(result(s)).toEqual({ winners: [], losers: [], draw: true });
    assertInvariants(s);
  });
});

describe('timers (RULES §11)', () => {
  const timeoutFixture = (attackerHand: number[]) =>
    fixture(
      [attackerHand, [1, 2, 3, 4, 5, 6], [10, 11, 12, 13, 14, 15]],
      { mode: 'throw-in', phase: 'opening', actor: 0, original: 0, lead: 0, defender: 1, limit: 6 },
    );

  it('auto-attack picks the lowest non-trump, else lowest trump, ties by clubs<diamonds<hearts<spades', () => {
    // Lowest non-trump rank 0 exists in all three suits -> clubs wins the tie.
    let s = timeoutFixture([18, 9, 0, 28, 30, 31]); // h6,d6,c6 + spades
    s = applySystem(s, { type: 'timeout' }, 30000);
    expect(s.table[0]!.attack).toBe(0);
    expect(s.phase).toBe('defending');
    expect(s.actor).toBe(1);
    expect(s.deadline).toBe(60000);

    // A high non-trump still beats a low trump: non-trump is preferred first.
    s = timeoutFixture([8, 27, 28, 29, 30, 31]); // cA + five spades
    s = applySystem(s, { type: 'timeout' }, 30000);
    expect(s.table[0]!.attack).toBe(8);

    // Only trumps in hand -> lowest trump rank.
    s = timeoutFixture([27, 28, 29, 30, 31, 32]); // all spades
    s = applySystem(s, { type: 'timeout' }, 30000);
    expect(s.table[0]!.attack).toBe(27);
  });

  it('defending timeout takes; throwing timeout passes; deadlines advance per decision', () => {
    let s = fixture(
      [[9, 18, 1, 2, 3, 4], [10, 19, 5, 6, 7, 8], [20, 21, 22, 23, 24, 25]],
      { mode: 'throw-in' },
    );
    s = move(s, { type: 'attack', cards: [9] }, 1); // deadline = 30001
    s = applySystem(s, { type: 'timeout' }, 30001); // defender times out -> take
    expect(s.phase).toBe('taking');
    expect(s.table).toEqual([{ attack: 9, defense: null }]);
    expect(s.actor).toBe(0); // taking queue starts at the lead attacker
    expect(s.deadline).toBe(60001);
    s = applySystem(s, { type: 'timeout' }, 60001); // thrower times out -> pass
    expect(s.actor).toBe(2);
    s = applySystem(s, { type: 'timeout' }, 90001); // last pass -> settle, taker wins table
    expect(s.phase).toBe('opening');
    expect(s.hands[1]).toContain(9);
    expect(s.table).toHaveLength(0);
  });

  it('stores pausedRemaining on pause, restores it on resume and extends deadline on recover', () => {
    let s = fixture(
      [[9, 18, 1, 2, 3, 4], [10, 19, 5, 6, 7, 8], [20, 21, 22, 23, 24, 25]],
      { mode: 'throw-in' },
    );
    // deadline is 30000 (startedAt 0 + 30s).
    s = applySystem(s, { type: 'pause' }, 10000);
    expect(s.pausedRemaining).toBe(20000);
    // Normal actions are rejected while paused.
    expect(() => move(s, { type: 'attack', cards: [9] })).toThrow();
    // Timeout cannot fire while paused.
    expect(() => applySystem(s, { type: 'timeout' }, 40000)).toThrow();
    // Recover extends the deadline but preserves pausedRemaining.
    s = applySystem(s, { type: 'recover' }, 100000);
    expect(s.deadline).toBe(130000);
    expect(s.pausedRemaining).toBe(20000);
    s = applySystem(s, { type: 'resume' }, 110000);
    expect(s.pausedRemaining).toBeNull();
    expect(s.deadline).toBe(130000); // 110000 + stored 20000
    s = applySystem(s, { type: 'timeout' }, 130000); // now due -> auto attack
    expect(s.phase).toBe('defending');
    expect(s.deadline).toBe(160000);
  });
});

describe('surrender / forfeit (RULES §10, engine forfeit)', () => {
  it('removes the seat permanently, sends hand+table to discard and voids the bout', () => {
    let s = fixture(
      [[9, 18, 1, 2, 3, 4], [10, 19, 5, 6, 7, 8], [11, 12, 13, 14, 15, 16]],
      { mode: 'throw-in' },
    );
    s = move(s, { type: 'attack', cards: [9] });
    s = move(s, { type: 'defend', card: 10, target: 9 });
    expect(s.phase).toBe('throwing');
    // p2 forfeits off-turn in the middle of the bout.
    s = byId(s, 'p2', { type: 'surrender' }, 2);
    expect(s.forfeited).toEqual([2]);
    expect(s.active).toEqual([0, 1]);
    expect(s.hands[2]).toEqual([]);
    expect(s.table).toHaveLength(0); // bout voided like a defended settle
    // Hand AND table cards all went to the discard.
    for (const c of [9, 10, 11, 12, 13, 14, 15, 16]) expect(s.discard).toContain(c);
    expect(s.phase).toBe('opening');
    expect(s.actor).toBe(1); // defender attacks next
    expect(s.defender).toBe(0);
    // The seat can never return or act again.
    expect(playerView(s, 'p2').canSurrender).toBe(false);
    expect(() => byId(s, 'p2', { type: 'surrender' }, 3)).toThrow();
    expect(() => byId(s, 'p2', { type: 'attack', cards: [9] }, 3)).toThrow();
    assertInvariants(s);
  });

  it('ends the match at one active seat and never crowns a forfeited player', () => {
    let s = fixture(
      [[9, 18, 1, 2, 3, 4], [10, 19, 5, 6, 7, 8], [11, 12, 13, 14, 15, 16]],
      { mode: 'throw-in' },
    );
    s = byId(s, 'p2', { type: 'surrender' }, 1);
    expect(s.phase).toBe('opening'); // two seats remain -> match continues
    s = byId(s, 'p1', { type: 'surrender' }, 2);
    expect(s.phase).toBe('finished');
    expect(s.active).toEqual([]);
    const r = result(s)!;
    expect(r.draw).toBe(false);
    expect(r.losers).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(r.winners).toEqual(['p0']);
    expect(r.winners).not.toContain('p2'); // forfeited seats are never winners
    assertInvariants(s);
  });
});

describe('privacy (RULES §12-13)', () => {
  const midGame = () => fixture(
    [[9, 18, 1, 2, 3, 4], [10, 19, 5, 6, 7, 8], [11, 12, 13, 14, 15, 16]],
    { mode: 'throw-in', deck: [20, 21, 22, 23, 24, 25] },
  );

  it('views contain only own hand, public table and counts - never foreign cards, deck order or seed', () => {
    const s = midGame();
    const v0 = playerView(s, 'p0');
    const v1 = playerView(s, 'p1');
    expect(v0.hand).toEqual(s.hands[0]);
    expect(v1.hand).toEqual(s.hands[1]);
    expect(v0.hand).not.toEqual(v1.hand);
    expect(v0.table).toEqual(s.table);
    expect(v0.players.map(p => p.count)).toEqual([6, 6, 6]);
    expect(v0.deckCount).toBe(6);
    for (const v of [v0, v1]) {
      expect(v).not.toHaveProperty('hands');
      expect(v).not.toHaveProperty('deck');
      expect(v).not.toHaveProperty('seed');
      expect(v).not.toHaveProperty('discard');
      // legalActions may only name the actor's own cards.
      for (const a of v.legalActions) {
        const ids = 'cards' in a ? a.cards : a.type === 'defend' ? [a.card] : [];
        for (const id of ids) expect(s.hands[s.players.indexOf(v.actorId!)]).toContain(id);
      }
    }
    // Serializing two players' views exposes disjoint private data only.
    expect(JSON.stringify(v0)).not.toBe(JSON.stringify(v1));
    expect(JSON.stringify(v0)).toContain('"hand"');
  });

  it('is invariant under permuting foreign hands and the deck (no hidden-info dependence)', () => {
    const s = midGame();
    const v0 = playerView(s, 'p0');
    const v1 = playerView(s, 'p1');
    // Swap two equal-length foreign hands entirely: counts stay the same.
    const alt = structuredClone(s);
    [alt.hands[1], alt.hands[2]] = [alt.hands[2]!, alt.hands[1]!];
    expect(playerView(alt, 'p0')).toEqual(v0);
    // Swap a foreign card with a deck card: lengths and deckCount unchanged.
    const alt2 = structuredClone(s);
    const foreign = alt2.hands[2]!;
    const deckCard = alt2.deck[0]!;
    foreign[0] = deckCard;
    alt2.deck[0] = s.hands[2]![0]!;
    expect(playerView(alt2, 'p0')).toEqual(v0);
    expect(playerView(alt2, 'p1')).toEqual(v1); // p1's own hand untouched
    // Sanity: p1's view DID change where it should - it now holds the swapped card.
    expect(playerView(alt2, 'p2').hand).not.toEqual(s.hands[2]);
  });
});
