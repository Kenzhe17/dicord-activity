import { createState, assertInvariants, transition } from '../engine';
import type { DurakState, DurakAction } from '../engine';

/** Card id = suit * 9 + rank; suits clubs=0 diamonds=1 hearts=2 spades=3; ranks 6..A = 0..8. */
export const C = (suit: number, rank: number) => suit * 9 + rank;

/**
 * Builds a mid-game state: deals a real state via createState, then overrides
 * hands/deck/table/phase/seats and fills `discard` with every unused card id so
 * card conservation holds. The result must satisfy assertInvariants, so
 * fixtures double as reachable-shape checks.
 */
export function fixture(hands: number[][], options: Partial<DurakState> = {}): DurakState {
  const base = createState({ mode: 'transfer' }, { players: hands.map((_, i) => 'p' + i), seed: 9, startedAt: 0 });
  const s: DurakState = {
    ...base, hands, deck: [], table: [], original: 0, lead: 0, actor: 0, defender: 1,
    trump: 3, phase: 'opening', limit: Math.min(6, hands[1]?.length ?? 0), ...options,
  };
  const used = new Set([...s.hands.flat(), ...s.deck, ...s.table.flatMap(p => (p.defense === null ? [p.attack] : [p.attack, p.defense]))]);
  s.discard = Array.from({ length: 36 }, (_, i) => i).filter(c => !used.has(c));
  assertInvariants(s);
  return s;
}

/** Applies an action for whoever the engine says is acting. */
export const move = (s: DurakState, action: DurakAction, now = 1) =>
  transition(s, action, s.players[s.actor]!, now);

/** Passes until the current bout settles (throwing/taking queue drains). */
export function passAll(s: DurakState): DurakState {
  let cur = s;
  while (cur.phase === 'throwing' || cur.phase === 'taking') cur = move(cur, { type: 'pass' });
  return cur;
}
