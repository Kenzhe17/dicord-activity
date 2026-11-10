import { describe, expect, it } from 'vitest';
import { MatchRuntime, restoreMatch } from '@rize/multiplayer';
import { durakModule } from '../server/module';
import { randomUUID } from 'node:crypto';
describe('Durak GameModule replay', () => {
  it('replays player decisions and server timers, preserving individual views', () => {
    const runtime = new MatchRuntime(durakModule, { mode: 'transfer' }, { players: ['p0', 'p1', 'p2'], seed: 194, startedAt: 0 }, randomUUID(), randomUUID());
    runtime.dispatchSystem(randomUUID(), { type: 'pause' }, 5000);
    runtime.dispatchSystem(randomUUID(), { type: 'resume' }, 15000);
    runtime.dispatchSystem(randomUUID(), { type: 'timeout' }, 40000);
    const initial = runtime.snapshot();
    const actor = runtime.view('p0').state.actorId!;
    const action = runtime.view(actor).state.legalActions.find(a => a.type === 'defend') ?? { type: 'take' as const };
    const envelope = { protocol: 1, matchId: runtime.matchId, roomId: runtime.roomId, requestId: randomUUID(), expectedVersion: 3, action };
    runtime.dispatch(actor, envelope, 40001);
    const replayed = restoreMatch(durakModule, runtime.snapshot());
    for (const id of ['p0', 'p1', 'p2']) expect(replayed.view(id)).toEqual(runtime.view(id));
    expect(replayed.snapshot()).toEqual(runtime.snapshot());
    expect(initial.actions.every(a => a.system)).toBe(true);
    const version = replayed.snapshot().version;
    replayed.dispatch(actor, envelope, 40002); expect(replayed.snapshot().version).toBe(version);
    expect(() => replayed.dispatch(actor, { ...envelope, requestId: randomUUID(), expectedVersion: version, action: { type: 'timeout' } }, 40003)).toThrow();
    const bad = structuredClone(replayed.snapshot()); bad.serialized = '{}';
    expect(() => restoreMatch(durakModule, bad)).toThrow();
  });
});
