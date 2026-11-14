import { describe, expect, it } from 'vitest';
import { createState, stateSchema, assertInvariants, mafiaCount, roleSchema } from '../engine';
import type { MafiaRole } from '../engine';
import { makeState, seatIds, MAFIA_PACE } from './fixture';

const roleCount = (s: { roles: MafiaRole[] }, role: MafiaRole) => s.roles.filter(r => r === role).length;

describe('createState / role deal', () => {
  it.each([6, 7, 8, 9, 10, 11, 12])('deals a valid role mix for %i players', n => {
    const s = makeState(n, 3);
    expect(s.players).toEqual(seatIds(n));
    expect(s.roles).toHaveLength(n);
    expect(roleCount(s, 'mafia')).toBe(mafiaCount(n));
    expect(roleCount(s, 'sheriff')).toBe(1);
    expect(roleCount(s, 'doctor')).toBe(1);
    expect(roleCount(s, 'town')).toBe(n - mafiaCount(n) - 2);
    expect(s.phase).toBe('reveal');
    expect(s.alive.every(Boolean)).toBe(true);
    expect(s.winner).toBeNull();
    expect(s.deadline).toBe(MAFIA_PACE.classic.reveal * 1000);
    assertInvariants(s);
    expect(stateSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('mafiaCount follows the published table and rejects out-of-range counts', () => {
    expect(mafiaCount(6)).toBe(1);
    expect(mafiaCount(7)).toBe(1);
    expect(mafiaCount(8)).toBe(2);
    expect(mafiaCount(9)).toBe(2);
    expect(mafiaCount(10)).toBe(2);
    expect(mafiaCount(11)).toBe(3);
    expect(mafiaCount(12)).toBe(3);
    for (const n of [0, 5, 13, 100]) expect(() => mafiaCount(n)).toThrow('Invalid player count');
    expect(roleSchema.safeParse('mafia').success).toBe(true);
    expect(roleSchema.safeParse('godfather').success).toBe(false);
  });

  it('same seed deals identical roles and state; different seeds vary', () => {
    const a = makeState(8, 42);
    const b = makeState(8, 42);
    expect(b.roles).toEqual(a.roles);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const deals = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) deals.add(JSON.stringify(makeState(8, seed).roles));
    expect(deals.size).toBeGreaterThan(1);
  });

  it('rejects invalid player counts, duplicates and bad settings', () => {
    const ctx = (players: string[]) => ({ players, seed: 1, startedAt: 0 });
    expect(() => createState({ pace: 'classic' }, ctx(seatIds(5)))).toThrow('Invalid player count');
    expect(() => createState({ pace: 'classic' }, ctx(seatIds(13)))).toThrow('Invalid player count');
    expect(() => createState({ pace: 'classic' }, ctx(Array(6).fill('same')))).toThrow('Invalid player count');
    expect(() => createState({ pace: 'classic' }, ctx([]))).toThrow('Invalid player count');
    expect(() => createState({ pace: 'nope' }, ctx(seatIds(6)))).toThrow();
    expect(() => createState({ pace: 'classic', extra: 1 }, ctx(seatIds(6)))).toThrow();
  });

  it('honours pace presets for the reveal deadline and defaults to classic', () => {
    expect(makeState(6, 1, 'blitz', 100).deadline).toBe(100 + MAFIA_PACE.blitz.reveal * 1000);
    expect(makeState(6, 1, 'short', 100).deadline).toBe(100 + MAFIA_PACE.short.reveal * 1000);
    expect(makeState(6, 1, 'classic', 100).deadline).toBe(100 + MAFIA_PACE.classic.reveal * 1000);
    expect(createState({}, { players: seatIds(6), seed: 1, startedAt: 0 }).pace).toBe('classic');
    expect(makeState(6, 1, 'blitz').pace).toBe('blitz');
  });
});
