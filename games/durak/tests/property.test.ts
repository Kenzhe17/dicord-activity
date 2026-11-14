import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createState, transition, invalidReason, legalActions, playerView, result,
  assertInvariants, applySystem, stateSchema,
} from '../engine';
import type { DurakState, DurakAction } from '../engine';
import { beats, suit } from '../engine/cards';

/**
 * Independent re-check of RULES.md §13 invariants. Deliberately recomputes
 * everything from scratch instead of trusting assertInvariants, so a bug in
 * the engine's own checker cannot hide a state corruption.
 */
function audit(s: DurakState) {
  // 1. Exactly 36 unique card ids across all zones; the trump indicator is one
  //    of those physical cards, never an extra copy.
  const zoned = [
    ...s.hands.flat(), ...s.deck, ...s.discard,
    ...s.table.flatMap(p => (p.defense === null ? [p.attack] : [p.attack, p.defense])),
  ];
  expect(zoned).toHaveLength(36);
  expect(new Set(zoned).size).toBe(36);
  expect(zoned.every(c => Number.isInteger(c) && c >= 0 && c <= 35)).toBe(true);
  expect(zoned.filter(c => c === s.trumpCard)).toHaveLength(1);
  expect(s.trump).toBe(suit(s.trumpCard));

  // Seats.
  expect(s.hands).toHaveLength(s.players.length);
  expect(new Set(s.players).size).toBe(s.players.length);
  for (const [i, h] of s.hands.entries()) {
    if (!s.active.includes(i)) expect(h).toEqual([]);
    expect(new Set(h).size).toBe(h.length);
  }
  expect(new Set(s.active).size).toBe(s.active.length);
  expect(new Set(s.forfeited).size).toBe(s.forfeited.length);
  for (const f of s.forfeited) {
    expect(s.active).not.toContain(f);
    expect(s.hands[f]).toEqual([]);
  }

  // 2. Every defense really beats its attack; attack count within limit.
  for (const p of s.table) {
    if (p.defense !== null) expect(beats(p.attack, p.defense, s.trump)).toBe(true);
  }
  expect(s.table.length).toBeLessThanOrEqual(s.limit);
  expect(s.limit).toBeLessThanOrEqual(6);

  if (s.phase === 'finished') {
    // 9. Terminal: empty table, at most one card-holder, consistent result.
    expect(s.table).toEqual([]);
    expect(s.active.length).toBeLessThanOrEqual(1);
    const r = result(s);
    expect(r).not.toBeNull();
    const expectedLosers = new Set(s.forfeited.map(i => s.players[i]!));
    if (s.active.length === 1) expectedLosers.add(s.players[s.active[0]!]!);
    expect(new Set(r!.losers)).toEqual(expectedLosers);
    expect(new Set(r!.winners)).toEqual(new Set(s.players.filter(id => !expectedLosers.has(id))));
    expect(r!.draw).toBe(expectedLosers.size === 0);
    return;
  }

  // 4/5. Actor/phase/queue consistency.
  expect(s.active.length).toBeGreaterThanOrEqual(2);
  expect(s.active).toContain(s.actor);
  expect(s.active).toContain(s.defender);
  expect(s.active).toContain(s.original);
  expect(s.active).toContain(s.lead);
  expect(s.forfeited).not.toContain(s.actor);

  const uncovered = s.table.filter(p => p.defense === null).length;
  switch (s.phase) {
    case 'opening':
      expect(s.actor).toBe(s.original);
      expect(s.table).toEqual([]);
      break;
    case 'defending':
      expect(s.actor).toBe(s.defender);
      expect(uncovered).toBeGreaterThan(0);
      break;
    case 'throwing':
    case 'taking':
      // Throwing only opens on a fully covered table; 'taking' may still hold
      // uncovered attacks that the taker will collect.
      if (s.phase === 'throwing') expect(uncovered).toBe(0);
      expect(s.queue.length).toBeGreaterThan(0);
      expect(s.queue[0]).toBe(s.actor);
      expect(new Set(s.queue).size).toBe(s.queue.length);
      for (const q of s.queue) {
        expect(s.active).toContain(q);
        expect(q).not.toBe(s.defender);
        expect(s.hands[q]!.length).toBeGreaterThan(0);
      }
      break;
  }
}

const anyCard = fc.integer({ min: -2, max: 40 });
const anyCards = fc.array(anyCard, { minLength: 0, maxLength: 8 });
const anyAction = fc.oneof(
  fc.record({ type: fc.constant('attack' as const), cards: anyCards }),
  fc.record({ type: fc.constant('throw' as const), cards: anyCards }),
  fc.record({ type: fc.constant('transfer' as const), cards: anyCards }),
  fc.record({ type: fc.constant('defend' as const), card: anyCard, target: anyCard }),
  fc.constant({ type: 'take' as const }),
  fc.constant({ type: 'pass' as const }),
  fc.constant({ type: 'surrender' as const }),
);

function randomPrefix(seed: number, steps: number): DurakState {
  let s = createState({ mode: seed % 2 ? 'transfer' : 'throw-in' }, {
    players: Array.from({ length: 2 + (seed % 5) }, (_, i) => 'p' + i), seed, startedAt: 0,
  });
  for (let i = 0; i < steps && s.phase !== 'finished'; i++) {
    const options = legalActions(s, s.players[s.actor]!);
    if (!options.length) break;
    s = transition(s, options[(seed + i * 7) % options.length]!, s.players[s.actor]!, i + 1);
  }
  return s;
}

describe('Durak engine properties (RULES §13)', () => {
  it('preserves all invariants, privacy and determinism along random legal playouts', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 2_000_000_000 }),
      fc.integer({ min: 0, max: 400 }),
      (seed, maxSteps) => {
        let s = createState({ mode: seed % 2 ? 'transfer' : 'throw-in' }, {
          players: Array.from({ length: 2 + (seed >>> 8) % 5 }, (_, i) => 'p' + i),
          seed, startedAt: 0,
        });
        audit(s);
        for (let step = 0; step < maxSteps && s.phase !== 'finished'; step++) {
          const now = step + 1;
          const actorId = s.players[s.actor]!;
          const options = legalActions(s, actorId);
          expect(options.length).toBeGreaterThan(0);
          const action = options[(seed + step * 31) % options.length]!;
          expect(invalidReason(s, action, actorId, now)).toBeNull();

          // 8. Personal view leaks nothing about foreign hands/deck/seed.
          const view = playerView(s, actorId);
          expect(view.hand).toEqual(s.hands[s.actor]);
          expect(view.table).toEqual(s.table);
          expect(view.deckCount).toBe(s.deck.length);
          expect(view.trumpCard).toBe(s.trumpCard);
          for (const [i, p] of view.players.entries()) {
            expect(p.count).toBe(s.hands[i]!.length);
            expect(p.out).toBe(!s.active.includes(i));
            expect(p.forfeited).toBe(s.forfeited.includes(i));
          }
          const serialized = JSON.stringify(view);
          expect(view).not.toHaveProperty('hands');
          expect(view).not.toHaveProperty('deck');
          expect(view).not.toHaveProperty('seed');
          expect(view).not.toHaveProperty('discard');
          expect(serialized).not.toContain('"hands"');
          expect(serialized).not.toContain('"deck"');
          expect(serialized).not.toContain('"seed"');
          for (const other of s.players.filter(id => id !== actorId)) {
            expect(playerView(s, other).legalActions).toEqual([]);
          }

          const before = JSON.stringify(s);
          const next = transition(s, action, actorId, now);
          expect(JSON.stringify(s)).toBe(before); // input untouched
          audit(next);
          assertInvariants(next);
          expect(stateSchema.parse(JSON.parse(JSON.stringify(next)))).toEqual(next);
          s = next;
        }
        if (s.phase === 'finished') {
          // 9. Terminal state rejects everything, result is stable.
          const r1 = result(s);
          expect(r1).not.toBeNull();
          expect(result(s)).toEqual(r1);
          for (const actorId of s.players) {
            for (const a of [
              { type: 'take' as const }, { type: 'pass' as const }, { type: 'surrender' as const },
              { type: 'attack' as const, cards: [0] }, { type: 'throw' as const, cards: [0] },
            ]) {
              expect(() => transition(s, a, actorId, maxSteps + 2)).toThrow();
            }
          }
          expect(() => applySystem(s, { type: 'timeout' }, maxSteps + 2)).toThrow();
          expect(() => applySystem(s, { type: 'recover' }, maxSteps + 2)).toThrow();
        }
      },
    ), { numRuns: 60 });
  });

  it('rejects every invalid generated action without mutating state, accepts every valid one', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 50_000 }),
      fc.integer({ min: 0, max: 30 }),
      anyAction,
      fc.integer({ min: -1, max: 5 }),
      fc.integer({ min: -10, max: 100_000 }),
      (seed, prefixSteps, action, actorIndex, now) => {
        const s = randomPrefix(seed, prefixSteps);
        if (s.phase === 'finished') return;
        const actor = actorIndex === -1 || actorIndex >= s.players.length
          ? 'ghost'
          : s.players[actorIndex]!;
        const reason = invalidReason(s, action as DurakAction, actor, now);
        const before = JSON.stringify(s);
        if (reason !== null) {
          expect(() => transition(s, action as DurakAction, actor, now)).toThrow();
          expect(JSON.stringify(s)).toBe(before);
        } else {
          const next = transition(s, action as DurakAction, actor, now);
          expect(JSON.stringify(s)).toBe(before);
          audit(next);
          assertInvariants(next);
        }
      },
    ), { numRuns: 400 });
  });
});
