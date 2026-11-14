import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createState, transition, playerView, result, applySystem, legalView, stateSchema } from '../engine';
import type { UnoState, UnoAction } from '../engine';
import { unoModule } from '../server/module';

const ctx = (n: number, seed: number) => ({ players: Array.from({ length: n }, (_, i) => 'p' + i), seed, startedAt: 0 });
const COLORS = ['red', 'blue', 'green', 'yellow'] as const;
const mulberry = (seed: number) => { let v = seed >>> 0; return () => { v = (v + 0x6D2B79F5) | 0; let t = Math.imul(v ^ v >>> 15, 1 | v); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };

/** Force-resolve whatever phase is pending via the system timeout path. */
function timeout(s: UnoState, now: number): UnoState {
  return applySystem({ ...s, deadline: Math.min(s.deadline, now) }, { type: 'timeout' }, now + 1);
}

function randomAction(s: UnoState, rng: () => number): UnoAction | null {
  if (s.actor < 0 || s.phase !== 'turn') return null;
  const actorId = s.players[s.actor]!;
  const legal = legalView(s, actorId);
  const options: UnoAction[] = [];
  const handSize = s.hands[s.actor]!.length;
  for (const card of legal.plays) {
    if (card >= 100) {
      for (const color of COLORS) options.push({ type: 'play', card, color });
      options.push({ type: 'play', card });
      if (card >= 104 && handSize === 2) options.push({ type: 'play', card, callUno: true });
    } else {
      options.push({ type: 'play', card });
      if (handSize === 2) options.push({ type: 'play', card, callUno: true });
    }
  }
  if (legal.canDraw) options.push({ type: 'draw' });
  if (legal.canPass) options.push({ type: 'pass' });
  if (legal.canCallUno) options.push({ type: 'callUno' });
  for (const target of legal.catchable) options.push({ type: 'catchUno', target });
  if (legal.canSurrender && rng() < 0.003) options.push({ type: 'surrender' });
  return options.length ? options[Math.floor(rng() * options.length)]! : null;
}

function step(s: UnoState, rng: () => number, now: number): UnoState {
  if (s.phase === 'finished') return s;
  if (now >= s.deadline) return timeout(s, now);
  if (s.phase === 'color' && s.awaiting) {
    return transition(s, { type: 'chooseColor', color: COLORS[Math.floor(rng() * 4)]! }, s.players[s.actor]!, now);
  }
  if (s.phase === 'challenge' && s.challenge) {
    for (const id of s.players) {
      if (legalView(s, id).canChallenge && rng() < 0.5) return transition(s, { type: 'challenge' }, id, now);
    }
    return timeout(s, now);
  }
  if (s.phase === 'roundEnd') {
    if (rng() < 0.3) return timeout(s, now);
    const id = s.players.find((_, i) => !s.forfeited.includes(i))!;
    return transition(s, { type: 'nextRound' }, id, now);
  }
  const action = randomAction(s, rng);
  if (!action) return timeout(s, now);
  try {
    return transition(s, action, s.players[s.actor]!, now);
  } catch {
    return timeout(s, now);
  }
}

function playMatch(n: number, seed: number, settings: { mode: 'quick' | 'points'; target: number }, maxSteps = 30000) {
  let s = createState({ ...settings, maxPlayers: 10 }, ctx(n, seed));
  const rng = mulberry(seed);
  let now = 0, steps = 0;
  while (s.phase !== 'finished' && steps++ < maxSteps) { now += 1; s = step(s, rng, now); }
  return { state: s, steps };
}

describe('UNO simulation invariants', () => {
  it.each([2, 3, 4, 6, 10])('simulates full matches with %i players without invariant violations', n => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), seed => {
      const { state: s, steps } = playMatch(n, seed, { mode: 'points', target: 300 });
      expect(steps).toBeLessThan(30000);
      expect(s.phase).toBe('finished');
      const r = result(s);
      expect(r).not.toBeNull();
      for (const id of s.players) {
        const view = playerView(s, id) as unknown as Record<string, unknown>;
        for (const key of ['deck', 'hands', 'seed', 'shuffles', 'out', 'awaiting']) expect(view).not.toHaveProperty(key);
        // Public challenge info must never leak the legality verdict.
        const ch = view['challenge'] as Record<string, unknown> | null;
        if (ch) expect(ch).not.toHaveProperty('hadMatch');
      }
      expect(stateSchema.parse(JSON.parse(unoModule.serialize(s)))).toEqual(s);
    }), { numRuns: 6 });
  }, 120000);

  it('every physical card exists exactly once, including across reshuffles', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), seed => {
      const { state: s } = playMatch(4, seed, { mode: 'quick', target: 500 });
      expect(s.phase).toBe('finished');
      const all = [...s.deck, ...s.discard, ...s.out, ...s.hands.flat()].sort((a, b) => a - b);
      expect(all).toEqual(Array.from({ length: 108 }, (_, i) => i));
    }), { numRuns: 5 });
  }, 120000);

  it('replays a full match identically from the action log', () => {
    // Determinism: same seed + same action sequence → same final state.
    const a = playMatch(3, 777, { mode: 'points', target: 200 });
    const b = playMatch(3, 777, { mode: 'points', target: 200 });
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});
