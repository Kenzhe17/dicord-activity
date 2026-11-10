import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GameRegistry } from '@rize/platform-core';
import type { GameModule } from '@rize/platform-core';
import { MatchRuntime, restoreMatch } from './index';
const stateSchema = z.object({ count: z.number().int(), secret: z.string() });
const fixture: GameModule<z.infer<typeof stateSchema>, { amount: number }, { target: number }, { count: number }> = {
  info: { id: 'counter', name: 'Test fixture', description: '', minPlayers: 2, maxPlayers: 2, status: 'ready', modes: [] },
  stateVersion: 1, stateSchema,
  settingsSchema: z.object({ target: z.number().int().positive() }),
  actionSchema: z.object({ amount: z.number().int().positive() }).strict(),
  createInitialState: () => ({ count: 0, secret: 'private-fixture-value' }),
  validateAction: (s, a, c) => c.actorId === 'dev:p1' && s.count + a.amount <= 3 ? { allowed: true } : { allowed: false, reason: 'Illegal move' },
  applyAction: (s, a) => ({ ...s, count: s.count + a.amount }),
  getPlayerView: s => ({ count: s.count }),
  isFinished: s => s.count >= 3,
  getResult: s => s.count >= 3 ? { winners: ['dev:p1'], losers: ['dev:p2'], draw: false } : null,
  serialize: s => JSON.stringify(s),
  restore: s => stateSchema.parse(JSON.parse(s)),
};
const roomId = '00000000-0000-4000-8000-000000000001';
const matchId = '00000000-0000-4000-8000-000000000002';
const requestId = '00000000-0000-4000-8000-000000000003';
const envelope = { protocol: 1, roomId, matchId, requestId, expectedVersion: 0, action: { amount: 1 } };
const create = () => new MatchRuntime(fixture, { target: 3 }, { players: ['dev:p1', 'dev:p2'], seed: 7, startedAt: 0 }, roomId, matchId);
describe('server action runtime', () => {
  it('registers an executable module with typed boundary validation', () => {
    const registry = new GameRegistry().registerModule(fixture);
    const module = registry.getModule('counter');
    expect(() => module.createInitialState({ target: 'invalid' }, { players: [], seed: 1, startedAt: 0 })).toThrow();
  });
  it('does not expose full state, accepts one transition and deduplicates retries', () => {
    const runtime = create();
    expect(runtime.dispatch('dev:p1', envelope, 10)).toEqual({ version: 1, state: { count: 1 } });
    expect(runtime.dispatch('dev:p1', envelope, 11).version).toBe(1);
    expect(runtime.snapshot().actions).toHaveLength(1);
    expect(runtime.view('dev:p2').state).not.toHaveProperty('secret');
  });
  it('rejects spoofing, stale versions, wrong match, illegal actions and reused keys', () => {
    const runtime = create();
    expect(() => runtime.dispatch('dev:outsider', envelope, 1)).toThrow();
    expect(() => runtime.dispatch('dev:p2', envelope, 1)).toThrow('Illegal');
    expect(() => runtime.dispatch('dev:p1', { ...envelope, matchId: roomId }, 1)).toThrow();
    expect(() => runtime.dispatch('dev:p1', { ...envelope, action: { amount: -1 } }, 1)).toThrow();
    runtime.dispatch('dev:p1', envelope, 1);
    expect(() => runtime.dispatch('dev:p1', { ...envelope, action: { amount: 2 } }, 2)).toThrow('requestId');
    expect(() => runtime.dispatch('dev:p1', { ...envelope, requestId: roomId }, 2)).toThrow('версия');
    expect(runtime.view('dev:p1').version).toBe(1);
  });
  it('replays the action log deterministically and rejects actions after finish', () => {
    const runtime = create();
    runtime.dispatch('dev:p1', { ...envelope, action: { amount: 3 } }, 100);
    const snapshot = runtime.snapshot();
    const replay = create();
    for (const record of snapshot.actions) replay.dispatch(record.actorId, { ...envelope, requestId: record.requestId, expectedVersion: record.version - 1, action: record.action }, record.now);
    expect(replay.snapshot()).toEqual(snapshot);
    expect(restoreMatch(fixture, snapshot).snapshot()).toEqual(snapshot);
    expect(() => restoreMatch(fixture, { ...snapshot, version: 55 })).toThrow();
    expect(() => restoreMatch(fixture, { ...snapshot, stateVersion: 2 })).toThrow();
    expect(() => restoreMatch(fixture, { ...snapshot, serialized: JSON.stringify({ count: 2, secret: 'tampered' }) })).toThrow();
    expect(fixture.restore(snapshot.serialized)).toEqual({ count: 3, secret: 'private-fixture-value' });
    expect(() => runtime.dispatch('dev:p1', { ...envelope, requestId: roomId, expectedVersion: 1 }, 200)).toThrow('завершён');
  });
});
