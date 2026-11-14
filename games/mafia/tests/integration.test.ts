import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MatchRuntime, restoreMatch } from '@rize/multiplayer';
import { mafiaModule } from '../server/module';
import { transition, applySystem, systemAction, assertInvariants } from '../engine';
import type { MafiaState } from '../engine';
import {
  makeState, toNight, advance, skipAllVotes, seatWith, seatIds,
} from './fixture';

const P = (s: MafiaState, seat: number) => s.players[seat]!;

describe('timers', () => {
  it('systemAction returns null before the deadline and advance at/after it', () => {
    const s = makeState(6, 50); // classic reveal: startedAt 0 + 20s
    expect(s.deadline).toBe(20000);
    expect(systemAction(s, 19999, true)).toBeNull();
    expect(systemAction(s, 19999, false)).toBeNull(); // `online` is ignored by design
    expect(systemAction(s, 20000, true)).toEqual({ type: 'advance' });
    expect(systemAction(s, 999999, true)).toEqual({ type: 'advance' });
    const night = applySystem(s, { type: 'advance' }, 20000);
    expect(night.phase).toBe('night');
    expect(night.night).toBe(1);
    expect(night.deadline).toBe(65000);
    expect(systemAction(night, 64999, true)).toBeNull();
    expect(systemAction(night, 65000, true)).toEqual({ type: 'advance' });
  });

  it('applySystem rejects early advance, unknown actions and finished games', () => {
    const s = makeState(6, 51);
    expect(() => applySystem(s, { type: 'advance' }, 19999)).toThrow('Timer not due');
    expect(() => applySystem(s, { type: 'bogus' }, 20000)).toThrow();
    expect(() => applySystem(s, { type: 'advance', extra: 1 }, 20000)).toThrow();
    const mafia = seatWith(s, 'mafia');
    const fin = transition(s, { type: 'forfeit' }, P(s, mafia), 1);
    expect(fin.phase).toBe('finished');
    expect(systemAction(fin, 10_000_000, true)).toBeNull();
    expect(() => applySystem(fin, { type: 'advance' }, 10_000_000)).toThrow('Finished');
    expect(() => applySystem(fin, { type: 'recover' }, 10_000_000)).toThrow('Finished');
  });

  it('recover extends the deadline by 30s from now without advancing the phase', () => {
    const s = makeState(6, 52); // deadline 20000
    const r = applySystem(s, { type: 'recover' }, 10000);
    expect(r.phase).toBe('reveal');
    expect(r.deadline).toBe(40000); // max(20000, 10000 + 30000)
    expect(systemAction(r, 30000, true)).toBeNull();
    expect(systemAction(r, 40000, true)).toEqual({ type: 'advance' });
    const r2 = applySystem(s, { type: 'recover' }, 0);
    expect(r2.deadline).toBe(30000); // max(20000, 0 + 30000)
    expect(s.deadline).toBe(20000); // input state untouched
    assertInvariants(r);
    assertInvariants(r2);
  });
});

describe('determinism', () => {
  /** A fixed script: night kill, day chat, all-skip vote, next night. */
  function scripted(seed: number): MafiaState {
    let s = toNight(makeState(6, seed));
    const m = seatWith(s, 'mafia');
    const target = s.roles.findIndex((r, i) => i !== m && r !== 'mafia');
    s = transition(s, { type: 'nightKill', target }, P(s, m), s.deadline);
    s = advance(s); // -> dawn
    s = advance(s); // -> discussion
    const chatSeat = s.alive.findIndex(Boolean);
    s = transition(s, { type: 'chat', channel: 'town', text: 'день' }, P(s, chatSeat), s.deadline);
    s = advance(s); // -> voting
    s = skipAllVotes(s);
    s = advance(s); // -> night 2
    return s;
  }

  it('identical seeds and action sequences produce byte-identical states', () => {
    const a = scripted(77);
    const b = scripted(77);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    assertInvariants(a);
    expect(a.phase).toBe('night');
    expect(a.night).toBe(2);
    expect(a.alive.filter(Boolean).length).toBe(5); // one night kill landed
  });

  it('different seeds diverge (roles and rng differ)', () => {
    expect(JSON.stringify(scripted(1))).not.toBe(JSON.stringify(scripted(2)));
  });
});

describe('MatchRuntime integration', () => {
  it('dispatches player actions and system advances, then restores identically', () => {
    const players = seatIds(6);
    const runtime = new MatchRuntime(
      mafiaModule,
      { pace: 'classic' },
      { players, seed: 61, startedAt: 0 },
      randomUUID(),
      randomUUID(),
    );
    // Timer gating through the runtime surface.
    expect(runtime.nextSystemAction(19999, true)).toBeNull();
    expect(runtime.nextSystemAction(20000, true)).toEqual({ type: 'advance' });
    expect(runtime.nextSystemAction(21000, true, true)).toEqual({ type: 'recover' }); // recovering flag
    runtime.dispatchSystem(randomUUID(), { type: 'advance' }, 20000); // reveal -> night

    // Roles are hidden in views, but each player sees their own.
    const mafiaId = players.find(id => runtime.view(id).state.you.role.kind === 'mafia')!;
    const targetId = players.find(id => id !== mafiaId && runtime.view(id).state.you.role.kind !== 'mafia')!;
    const targetSeat = runtime.view(targetId).state.you.seat;
    const version = runtime.snapshot().version;
    const envelope = {
      protocol: 1,
      matchId: runtime.matchId,
      roomId: runtime.roomId,
      requestId: randomUUID(),
      expectedVersion: version,
      action: { type: 'nightKill', target: targetSeat },
    };
    runtime.dispatch(mafiaId, envelope, 21000);
    expect(runtime.snapshot().version).toBe(version + 1);
    // Same requestId + payload is idempotent: no version bump.
    runtime.dispatch(mafiaId, envelope, 21000);
    expect(runtime.snapshot().version).toBe(version + 1);
    // Stale expectedVersion is rejected.
    expect(() => runtime.dispatch(
      mafiaId,
      { ...envelope, requestId: randomUUID(), expectedVersion: version, action: { type: 'nightKill', target: targetSeat } },
      21001,
    )).toThrow();
    // Illegal action for a non-mafia is rejected through validateAction.
    expect(() => runtime.dispatch(
      targetId,
      { ...envelope, requestId: randomUUID(), expectedVersion: version + 1, action: { type: 'nightKill', target: targetSeat } },
      21001,
    )).toThrow();

    // Night timer: deadline was set at 20000 + 45s.
    expect(runtime.nextSystemAction(64999, true)).toBeNull();
    expect(runtime.nextSystemAction(65000, true)).toEqual({ type: 'advance' });
    runtime.dispatchSystem(randomUUID(), { type: 'advance' }, 65000); // night -> dawn

    // Journal replay must reproduce every per-player view and the snapshot.
    const replayed = restoreMatch(mafiaModule, runtime.snapshot());
    expect(replayed.snapshot()).toEqual(runtime.snapshot());
    for (const id of players) expect(replayed.view(id)).toEqual(runtime.view(id));
    const bad = structuredClone(runtime.snapshot());
    bad.serialized = '{}';
    expect(() => restoreMatch(mafiaModule, bad)).toThrow();
  });
});
