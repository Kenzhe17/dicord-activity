import { createState, transition, applySystem } from '../engine';
import type { MafiaState, MafiaAction, MafiaRole } from '../engine';
import type { MafiaPace } from '../server/definition';

export { mafiaModule } from '../server/module';
export { createState, transition, applySystem, systemAction, playerView, result, assertInvariants, stateSchema, actionSchema, mafiaCount, invalidReason } from '../engine';
export type { MafiaState, MafiaAction, MafiaRole, MafiaView, MafiaChatChannel } from '../engine';
export type { MafiaPace } from '../server/definition';
export { MAFIA_PACE } from '../server/definition';

/** Seat ids p0..p(n-1), matching the engine's seat indices. */
export function seatIds(n: number, prefix = 'p'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

export function makeState(n = 6, seed = 1, pace: MafiaPace = 'classic', startedAt = 0): MafiaState {
  return createState({ pace }, { players: seatIds(n), seed, startedAt });
}

/** Advances exactly one phase. `now` defaults to the current deadline, which is always due. */
export function advance(s: MafiaState, now = s.deadline): MafiaState {
  return applySystem(s, { type: 'advance' }, Math.max(now, s.deadline));
}

/** Advances phase-by-phase until `phase` is reached (or the game finishes). */
export function toPhase(s: MafiaState, phase: MafiaState['phase']): MafiaState {
  let cur = s;
  let guard = 0;
  while (cur.phase !== phase && cur.phase !== 'finished' && guard++ < 40) cur = advance(cur);
  return cur;
}

export const toNight = (s: MafiaState) => toPhase(s, 'night');
export const toVoting = (s: MafiaState) => toPhase(s, 'voting');

/** All seats holding `role`. */
export function seatsWith(s: MafiaState, role: MafiaRole): number[] {
  return s.roles.map((r, i) => (r === role ? i : -1)).filter(i => i >= 0);
}

export const seatWith = (s: MafiaState, role: MafiaRole): number => s.roles.indexOf(role);

/** Every living seat index. */
export function aliveSeats(s: MafiaState): number[] {
  return s.players.map((_, i) => i).filter(i => s.alive[i]);
}

/** Applies a player action; `now` defaults to the phase deadline. */
export function act(s: MafiaState, actorId: string, action: MafiaAction, now = s.deadline): MafiaState {
  return transition(s, action, actorId, now);
}

/** Casts `vote` for seat `seat` (seat index, not player id). */
export function vote(s: MafiaState, seat: number, target: number | 'skip', now = s.deadline): MafiaState {
  return transition(s, { type: 'vote', target }, s.players[seat]!, now);
}

/** Every living player votes 'skip'. Only valid during voting/runoff. */
export function skipAllVotes(s: MafiaState): MafiaState {
  let cur = s;
  for (const seat of aliveSeats(cur)) cur = vote(cur, seat, 'skip');
  return cur;
}

/**
 * From the 'night' phase: resolves the night (no actions taken), runs a full
 * day with all-skipped votes, and lands on the next 'night' (or 'finished').
 */
export function nextNight(s: MafiaState): MafiaState {
  let cur = advance(s); // night -> dawn
  if (cur.phase === 'finished') return cur;
  cur = advance(cur); // dawn -> discussion
  cur = advance(cur); // discussion -> voting
  cur = skipAllVotes(cur);
  cur = advance(cur); // voting -> night | finished
  return cur;
}

/** First seed in [seedStart, seedEnd] whose dealt roles satisfy `pred`. */
export function stateWithRoles(
  n: number,
  pred: (s: MafiaState) => boolean,
  seedStart = 1,
  seedEnd = 500,
  pace: MafiaPace = 'classic',
): MafiaState {
  for (let seed = seedStart; seed <= seedEnd; seed++) {
    const s = makeState(n, seed, pace);
    if (pred(s)) return s;
  }
  throw new Error(`No seed in [${seedStart}, ${seedEnd}] matched predicate`);
}
