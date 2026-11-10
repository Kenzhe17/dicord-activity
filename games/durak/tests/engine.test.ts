import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createState, transition, invalidReason, legalActions, playerView, result, assertInvariants, applySystem, stateSchema } from '../engine';
import type { DurakState, DurakAction } from '../engine';
import { beats, rank, suit } from '../engine/cards';

function fixture(hands: number[][], options: Partial<DurakState> = {}): DurakState {
  const base = createState({ mode: 'transfer' }, { players: hands.map((_, i) => 'p' + i), seed: 9, startedAt: 0 });
  const s: DurakState = { ...base, hands, deck: [], table: [], original: 0, lead: 0, actor: 0, defender: 1, trump: 3, phase: 'opening', limit: Math.min(6, hands[1]!.length), ...options };
  const used = new Set([...s.hands.flat(), ...s.deck, ...s.table.flatMap(p => p.defense === null ? [p.attack] : [p.attack, p.defense])]);
  s.discard = Array.from({ length: 36 }, (_, i) => i).filter(c => !used.has(c));
  assertInvariants(s); return s;
}
const move = (s: DurakState, action: DurakAction) => transition(s, action, s.players[s.actor]!, 1);
function passAll(s: DurakState) { while (s.phase === 'throwing' || s.phase === 'taking') s = move(s, { type: 'pass' }); return s; }

describe('Durak rules', () => {
  it.each([2, 3, 4, 5, 6])('deals 36 unique cards to %i seats and selects the lowest held trump', n => {
    const s = createState({}, { players: Array.from({ length: n }, (_, i) => 'p' + i), seed: 873, startedAt: 100 });
    expect(s.hands.every(h => h.length === 6)).toBe(true);
    expect(s.deck.length).toBe(36 - n * 6);
    assertInvariants(s);
    if (n === 6) expect(s.hands[s.dealer]).toContain(s.trumpCard);
    else expect(s.deck.at(-1)).toBe(s.trumpCard);
    const trumps = s.hands.flat().filter(c => suit(c) === s.trump);
    if (trumps.length) expect(s.hands[s.actor]).toContain(trumps.sort((a, b) => rank(a) - rank(b))[0]);
  });
  it('validates every suit and rank independently', () => {
    for (let a = 0; a < 36; a++) for (let b = 0; b < 36; b++) for (let t = 0; t < 4; t++) {
      const expected = Math.floor(a / 9) === Math.floor(b / 9) ? b % 9 > a % 9 : Math.floor(b / 9) === t && Math.floor(a / 9) !== t;
      expect(beats(a, b, t)).toBe(expected);
    }
  });
  it('rejects wrong actors, duplicate cards, mismatched initial ranks and excess attacks immutably', () => {
    const s = fixture([[0, 9, 2], [1]]), before = JSON.stringify(s);
    for (const cards of [[], [0, 0], [0, 2], [0, 9], [35]]) expect(() => move(s, { type: 'attack', cards })).toThrow();
    expect(() => transition(s, { type: 'attack', cards: [0] }, 'p1', 1)).toThrow();
    expect(JSON.stringify(s)).toBe(before);
  });
  it('allows throwing a defensive rank, resets passes and skips the defender', () => {
    let s = fixture([[0, 9, 7], [1, 3, 6], [10, 18, 4]]);
    s = move(s, { type: 'attack', cards: [0] }); s = move(s, { type: 'defend', card: 1, target: 0 });
    expect(s.actor).toBe(0);
    s = move(s, { type: 'pass' }); expect(s.actor).toBe(2);
    s = move(s, { type: 'throw', cards: [10] }); expect(s.actor).toBe(1);
    expect(() => move(s, { type: 'defend', card: 3, target: 10 })).toThrow();
  });
  it('takes the whole partially defended table, including allowed extra throws', () => {
    let s = fixture([[0, 9, 10, 6], [1, 5, 8], [20, 21]]);
    s = move(s, { type: 'attack', cards: [0, 9] }); s = move(s, { type: 'defend', card: 1, target: 0 });
    s = move(s, { type: 'take' }); expect(s.phase).toBe('taking');
    expect(() => move(s, { type: 'throw', cards: [6] })).toThrow();
    s = move(s, { type: 'throw', cards: [10] });
    expect(s.hands[1]).toEqual(expect.arrayContaining([0, 9, 1, 10]));
    expect(s.actor).toBe(2); expect(s.phase).toBe('opening');
  });
  it('forbids transfer back in two-player play even with enough cards', () => {
    let s = fixture([[0, 4, 5], [9, 3, 6]]);
    s = move(s, { type: 'attack', cards: [0] });
    expect(() => move(s, { type: 'transfer', cards: [9] })).toThrow();
  });
  it('transfers several equal cards and chains back when three players can receive', () => {
    let s = fixture([[0, 1, 2, 3, 4], [9, 18, 5, 6], [27, 7, 8, 10]]);
    s = move(s, { type: 'attack', cards: [0] });
    s = move(s, { type: 'transfer', cards: [9, 18] }); expect(s.defender).toBe(2); expect(s.table.length).toBe(3);
    s = move(s, { type: 'transfer', cards: [27] }); expect(s.defender).toBe(0); expect(s.limit).toBe(4);
    expect(s.original).toBe(0); expect(s.lead).toBe(2); assertInvariants(s);
  });
  it('rejects transfers onto empty or undersized hands and after any cover', () => {
    for (const h of [[], [3]]) {
      let s = fixture([[0, 2], [9, 6], h]); s = move(s, { type: 'attack', cards: [0] });
      expect(() => move(s, { type: 'transfer', cards: [9] })).toThrow();
    }
    let s = fixture([[0, 9, 2], [1, 18, 6], [4, 5, 7]]);
    s = move(s, { type: 'attack', cards: [0, 9] }); s = move(s, { type: 'defend', card: 1, target: 0 });
    expect(() => move(s, { type: 'transfer', cards: [18] })).toThrow();
  });
  it('rejects a transfer at the six-card limit without changing the table', () => {
    const s = fixture([[6, 7, 8], [18, 19, 20], [27, 28, 29, 30, 31, 32]], { phase: 'defending', actor: 1, limit: 6, table: [0, 1, 2, 3, 4, 5].map(attack => ({ attack, defense: null })) });
    expect(() => move(s, { type: 'transfer', cards: [18] })).toThrow();
    expect(s.table).toHaveLength(6);
  });
  it('refills original attacker first and final defender last, trump last', () => {
    let s = fixture([[0, 2], [1, 5], [20, 21]], { deck: [7, 8, 35], trumpCard: 35 });
    s = move(s, { type: 'attack', cards: [0] }); s = move(s, { type: 'defend', card: 1, target: 0 }); s = passAll(s);
    expect(s.hands[0]).toEqual([2, 7, 8, 35]); expect(s.hands[1]).toEqual([5]); expect(s.actor).toBe(1); expect(s.defender).toBe(2);
  });
  it('does not eliminate an empty hand until settlement, then chooses the next active attacker', () => {
    let s = fixture([[0], [1], [5, 6]]);
    s = move(s, { type: 'attack', cards: [0] }); expect(s.active).toContain(0);
    s = move(s, { type: 'defend', card: 1, target: 0 });
    expect(s.phase).toBe('finished'); expect(result(s)).toEqual({ winners: ['p0', 'p1'], losers: ['p2'], draw: false });
  });
  it('ends the last successful defense in a shared draw', () => {
    let s = fixture([[0], [1]]); s = move(s, { type: 'attack', cards: [0] }); s = move(s, { type: 'defend', card: 1, target: 0 });
    expect(result(s)).toEqual({ winners: [], losers: [], draw: true }); assertInvariants(s);
  });
  it('after a defender exits, starts at the next surviving seat and skips the empty attacker', () => {
    let s = fixture([[0, 6], [1], [8, 9], [15, 16]]);
    s = move(s, { type: 'attack', cards: [0] }); s = move(s, { type: 'defend', card: 1, target: 0 });
    expect(s.active).toEqual([0, 2, 3]); expect(s.actor).toBe(2); expect(s.defender).toBe(3);
  });
  it('refills original attacker last when a transfer chain makes them final defender', () => {
    let s = fixture([[0, 1, 10, 19, 4, 5], [9, 6, 7, 8, 11, 12], [18, 13, 14, 15, 16, 17]], { deck: [20, 21, 22, 23, 24, 25, 26, 35], trumpCard: 35 });
    s = move(s, { type: 'attack', cards: [0] }); s = move(s, { type: 'transfer', cards: [9] }); s = move(s, { type: 'transfer', cards: [18] });
    s = move(s, { type: 'defend', card: 1, target: 0 }); s = move(s, { type: 'defend', card: 10, target: 9 }); s = move(s, { type: 'defend', card: 19, target: 18 }); s = passAll(s);
    expect(s.hands[1]).toContain(20); expect(s.hands[2]).toContain(21);
    expect(s.hands[0]).toEqual(expect.arrayContaining([22, 23, 24, 25]));
    expect(s.deck).toEqual([26, 35]); expect(s.actor).toBe(0);
  });
  it('records the taker as loser on the last attack', () => {
    let s = fixture([[0], [9]]); s = move(s, { type: 'attack', cards: [0] }); s = move(s, { type: 'take' });
    expect(result(s)?.losers).toEqual(['p1']); expect(s.hands[1]).toContain(0);
  });
  it('restores timing, pauses all-absent play and never awards a technical defeat', () => {
    const initial = createState({}, { players: ['a', 'b'], seed: 82, startedAt: 0 });
    let s = applySystem(initial, { type: 'pause' }, 10000); expect(s.pausedRemaining).toBe(20000);
    s = stateSchema.parse(JSON.parse(JSON.stringify(s))); s = applySystem(s, { type: 'resume' }, 90000); expect(s.deadline).toBe(110000);
    s = applySystem(s, { type: 'timeout' }, 120000); expect(s.deadline).toBe(150000); expect(s.phase).toBe('defending'); expect(result(s)).toBeNull();
    expect(() => applySystem(s, { type: 'timeout' }, 120000)).toThrow();
  });
});

describe('Durak reachable-state properties', () => {
  it('preserves cards, immutable inputs, privacy, legality and serialization', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2147483647 }), fc.integer({ min: 2, max: 6 }), fc.boolean(), (seed, n, transfer) => {
      let s = createState({ mode: transfer ? 'transfer' : 'throw-in' }, { players: Array.from({ length: n }, (_, i) => 'p' + i), seed, startedAt: 0 });
      for (let step = 0; step < 100 && s.phase !== 'finished'; step++) {
        const actor = s.players[s.actor]!, options = legalActions(s, actor); expect(options.length).toBeGreaterThan(0);
        const selected = options[(seed + step) % options.length]!, before = JSON.stringify(s);
        const own = playerView(s, actor); expect(own.hand).toEqual(s.hands[s.actor]);
        expect(own).not.toHaveProperty('deck'); expect(own).not.toHaveProperty('hands'); expect(own).not.toHaveProperty('seed');
        const altered = structuredClone(s), other = altered.hands.find((h, i) => i !== s.actor && h.some(c => c !== s.trumpCard));
        const opponentCard = other?.find(c => c !== s.trumpCard), deckCard = altered.deck.find(c => c !== s.trumpCard);
        if (other && opponentCard !== undefined && deckCard !== undefined) {
          other[other.indexOf(opponentCard)] = deckCard; altered.deck[altered.deck.indexOf(deckCard)] = opponentCard;
          expect(playerView(altered, actor)).toEqual(own);
        }
        for (const other of s.players.filter(id => id !== actor)) expect(playerView(s, other).legalActions).toEqual([]);
        expect(invalidReason(s, selected, actor, step + 1)).toBeNull();
        const updated = transition(s, selected, actor, step + 1); expect(JSON.stringify(s)).toBe(before);
        assertInvariants(updated); expect(stateSchema.parse(JSON.parse(JSON.stringify(updated)))).toEqual(updated); s = updated;
      }
    }), { numRuns: 100 });
  });
});
