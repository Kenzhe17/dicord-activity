import { describe, expect, it } from 'vitest';
import { MatchRuntime, restoreMatch } from '@rize/multiplayer';
import { codenamesModule } from '../server/module';
import { randomUUID } from 'node:crypto';

const PLAYERS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const settings = { ruleSet: 'classic', timed: true, traitor: false, hintSeconds: 60, guessSeconds: 180, dictionary: 'ru' };
const envelope = (runtime: MatchRuntime<never, never, never, never>, _actorId: string, action: unknown, expectedVersion: number) => ({
  protocol: 1 as const, matchId: runtime.matchId, roomId: runtime.roomId,
  requestId: randomUUID(), expectedVersion, action,
});

describe('Codenames GameModule replay', () => {
  it('replays draft, hints, picks and timers preserving per-player views', () => {
    const runtime = new MatchRuntime(codenamesModule, settings, { players: PLAYERS, seed: 99, startedAt: 0, hostId: 'p1' }, randomUUID(), randomUUID());
    // Draft: teams and roles
    const draft: [string, unknown][] = [
      ['p1', { type: 'choose', team: 'red', role: 'spymaster' }],
      ['p2', { type: 'choose', team: 'red', role: 'operative' }],
      ['p3', { type: 'choose', team: 'blue', role: 'spymaster' }],
      ['p4', { type: 'choose', team: 'blue', role: 'operative' }],
      ['p5', { type: 'choose', team: 'spectator' }],
      ['p6', { type: 'choose', team: 'spectator' }],
      ['p1', { type: 'start' }],
    ];
    let version = 0, now = 0;
    for (const [actor, action] of draft) {
      runtime.dispatch(actor, envelope(runtime as never, actor, action, version), now++);
      version++;
    }
    // Play a few turns deterministically from views
    for (let turn = 0; turn < 4; turn++) {
      const view = runtime.view('p1').state as { phase: string; currentTeam: string; turn: { team: string } | null };
      if (view.phase === 'finished') break;
      const spy = view.currentTeam === 'red' ? 'p1' : 'p3';
      const op = view.currentTeam === 'red' ? 'p2' : 'p4';
      if (view.phase === 'hint') {
        runtime.dispatch(spy, envelope(runtime as never, spy, { type: 'hint', word: 'qwerty', count: 1 }, version), now += 1000);
        version++;
      } else {
        const st = runtime.view(op).state as { board: { index: number; revealed: boolean }[] };
        const idx = st.board.find(b => !b.revealed)!.index;
        runtime.dispatch(op, envelope(runtime as never, op, { type: 'pick', index: idx }, version), now += 1000);
        version++;
      }
    }
    // A timeout system event while timed
    runtime.dispatchSystem(randomUUID(), { type: 'timeout' }, 5_000_000);
    const before = runtime.snapshot();
    const replayed = restoreMatch(codenamesModule, before);
    for (const id of PLAYERS) expect(replayed.view(id)).toEqual(runtime.view(id));
    expect(replayed.snapshot()).toEqual(runtime.snapshot());
    // Idempotent replay of the last action returns the same view
    const last = before.actions.at(-1)!;
    const viewVersion = replayed.snapshot().version;
    if (!last.system) {
      const again = { protocol: 1 as const, matchId: replayed.matchId, roomId: replayed.roomId, requestId: last.requestId, expectedVersion: last.version - 1, action: last.action };
      replayed.dispatch(last.actorId, again, last.now);
      expect(replayed.snapshot().version).toBe(viewVersion);
    }
    const bad = structuredClone(before); bad.serialized = '{}';
    expect(() => restoreMatch(codenamesModule, bad)).toThrow();
  });
});
