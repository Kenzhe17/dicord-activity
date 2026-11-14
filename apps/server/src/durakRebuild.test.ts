import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PlatformService } from './platform';
import type { StakesBridge } from './economy';
import type { DurakView } from '@rize/durak';
import type { MatchView } from '@rize/shared';

const running: Awaited<ReturnType<typeof buildApp>>[] = [];
const fixtures: { instance: Awaited<ReturnType<typeof buildApp>>; roomId: string; matchId: string }[] = [];
afterEach(async () => {
  for (const { instance, roomId, matchId } of fixtures.splice(0)) {
    if (matchId) await instance.db.matchSnapshot.updateMany({ where: { id: matchId, status: 'active' }, data: { status: 'interrupted' } });
    await instance.db.roomSnapshot.update({ where: { id: roomId }, data: { status: 'closed' } });
  }
  for (const instance of running.splice(0)) await instance.app.close();
});

type Bridge = StakesBridge & { getBalance: Mock; escrow: Mock; settle: Mock; refund: Mock; listReservedEscrows: Mock; claimPending: Mock };
function bridge(): Bridge {
  return {
    getBalance: vi.fn(async () => ({ ok: true, balance: 1000, exists: true, writesEnabled: true })),
    escrow: vi.fn(async () => ({ ok: true as const, replayed: false })),
    settle: vi.fn(async () => ({ ok: true as const })),
    refund: vi.fn(async () => ({ ok: true as const })),
    listReservedEscrows: vi.fn(async () => [] as { opId: string; createdAt: string }[]),
    claimPending: vi.fn(async () => ({ ok: true })),
  } as Bridge;
}

async function setup(count = 2, options: { stake?: number; economy?: Bridge | null; start?: boolean } = {}) {
  const instance = await buildApp(loadConfig({
    ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'],
    ARCADE_STAKES_ENABLED: options.stake ? 'true' : 'false',
  }), { logger: false, scheduleTimers: false, economy: options.economy ?? null });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Rebuild ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'durak', name: 'Durak rebuild', visibility: 'private', settings: { mode: 'throw-in', maxPlayers: count, ...(options.stake ? { stake: options.stake } : {}) } }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  const match = options.start === false ? null : await instance.rooms.start(room.id, a.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match?.matchId ?? '' });
  return { ...instance, players, room, match: match as MatchView, a };
}

const durak = (view: MatchView) => view.state as DurakView;
function envelope(view: MatchView, _actorId: string, action: unknown) {
  return { protocol: 1 as const, roomId: view.roomId, matchId: view.matchId, requestId: randomUUID(), expectedVersion: view.version, action };
}
/** Fast legal bot: defend when possible, otherwise end the bout quickly. */
function botAction(state: DurakView) {
  return state.legalActions.find(a => a.type === 'defend') ?? state.legalActions.find(a => a.type === 'pass') ?? state.legalActions[0]!;
}
/** Every card id a player view exposes in card positions (own hand, table, trump, own legal moves). */
function visibleCardIds(view: MatchView): Set<number> {
  const s = durak(view);
  const ids = new Set<number>(s.hand);
  ids.add(s.trumpCard);
  for (const pair of s.table) { ids.add(pair.attack); if (pair.defense !== null) ids.add(pair.defense); }
  for (const action of s.legalActions) {
    if ('cards' in action && action.cards) action.cards.forEach(c => ids.add(c));
    if ('card' in action && typeof action.card === 'number') ids.add(action.card);
    if ('target' in action && typeof action.target === 'number') ids.add(action.target);
  }
  return ids;
}
/** Indirect 36-card conservation: every view accounts for every card exactly once. */
function assertConservation(view: MatchView) {
  const s = durak(view);
  const tableCards = s.table.reduce((n, p) => n + 1 + (p.defense === null ? 0 : 1), 0);
  const accounted = s.players.reduce((n, p) => n + p.count, 0) + s.deckCount + s.discardCount + tableCards;
  expect(accounted).toBe(36);
}

describe('Durak rebuild integration', () => {
  it('plays a complete 6-player match to a recorded finish', async () => {
    const instance = await setup(6);
    let view = instance.match;
    let steps = 0, conflicts = 0;
    while (view.status === 'active' && steps++ < 4000) {
      // Keep presence fresh: without a heartbeat every member looks offline after
      // ~45s and the engine's pause system-action fires mid-loop.
      await instance.rooms.touch(instance.room.id, instance.players[0]!.player.id);
      const actorId = durak(view).actorId!;
      const personal = await instance.rooms.match(view.matchId, actorId);
      const state = durak(personal);
      expect(state.legalActions.length).toBeGreaterThan(0);
      assertConservation(personal);
      try {
        view = await instance.rooms.action(actorId, envelope(personal, actorId, botAction(state)));
        expect(view.version).toBe(personal.version + 1);
        conflicts = 0;
      } catch (error) {
        // A 30s turn timer can fire between the read and the write; refetch and re-plan.
        view = await instance.rooms.match(view.matchId, actorId);
        if (++conflicts > 8 || view.status !== 'active') throw error;
      }
    }
    expect(steps).toBeLessThan(4000);
    expect(view.status).toBe('finished');
    expect(view.result).not.toBeNull();
    expect(view.result!.winners.length + view.result!.losers.length).toBe(6);
    // Result is recorded exactly once: one matchAction row per version, one outcome per seat.
    expect(await instance.db.matchAction.count({ where: { matchId: view.matchId } })).toBe(view.version);
    expect(await instance.db.matchParticipant.count({ where: { matchId: view.matchId, outcome: { not: null } } })).toBe(6);
    const row = await instance.db.matchSnapshot.findUniqueOrThrow({ where: { id: view.matchId } });
    expect(row.status).toBe('finished'); expect(row.result).not.toBeNull(); expect(row.finishedAt).not.toBeNull();
    for (const p of instance.players) expect((await instance.rooms.profile(p.player.id)).statistics[0]).toMatchObject({ played: 1 });
  }, 240000);

  it('never leaks another player\'s hand cards into a match view', async () => {
    const instance = await setup(4);
    const views = await Promise.all(instance.players.map(p => instance.rooms.match(instance.match.matchId, p.player.id)));
    const hands = views.map(v => new Set(durak(v).hand));
    for (const [aIndex, viewA] of views.entries()) {
      const stateA = durak(viewA);
      // Structural check: no hidden-state fields or per-seat hands may be present.
      for (const key of ['hands', 'deck', 'seed', 'actions', 'context']) expect(stateA).not.toHaveProperty(key);
      for (const seat of stateA.players) expect(Object.keys(seat).sort()).toEqual(['count', 'forfeited', 'id', 'out']);
      assertConservation(viewA);
      const visible = visibleCardIds(viewA);
      for (const [bIndex, handB] of hands.entries()) {
        if (aIndex === bIndex) continue;
        for (const cardId of visible) {
          if (handB.has(cardId)) expect(cardId).toBe(stateA.trumpCard); // only the public trump card may overlap
        }
      }
    }
    // Advance a few moves and re-check while the table is populated.
    let view = views[0]!;
    for (let i = 0; i < 6 && view.status === 'active'; i++) {
      const actorId = durak(view).actorId!;
      const personal = await instance.rooms.match(view.matchId, actorId);
      try {
        view = await instance.rooms.action(actorId, envelope(personal, actorId, botAction(durak(personal))));
      } catch {
        view = await instance.rooms.match(view.matchId, actorId);
      }
    }
    const after = await Promise.all(instance.players.map(p => instance.rooms.match(view.matchId, p.player.id)));
    for (const [aIndex, viewA] of after.entries()) {
      const visible = visibleCardIds(viewA);
      for (const [bIndex, handB] of after.map(v => new Set(durak(v).hand)).entries()) {
        if (aIndex === bIndex) continue;
        for (const cardId of visible) if (handB.has(cardId)) expect(cardId).toBe(durak(viewA).trumpCard);
      }
    }
  }, 60000);

  it('keeps the server-side timer running through a disconnect and restores the same match on reconnect', async () => {
    const instance = await setup(3);
    const dropped = instance.players[1]!;
    const actor0 = durak(instance.match).actorId!;
    const first = await instance.rooms.match(instance.match.matchId, actor0);
    const move = botAction(durak(first));
    const sent = envelope(first, actor0, move);
    const played = await instance.rooms.action(actor0, sent);
    const versionBefore = played.version;
    // Simulate a transport drop: presence timestamp goes stale while others stay online.
    await instance.db.roomMember.update({ where: { roomId_playerId: { roomId: instance.room.id, playerId: dropped.player.id } }, data: { lastSeenAt: new Date(Date.now() - 60000) } });
    // A fresh PlatformService performs the one-time 'recover' tick, then a fake clock crosses the deadline.
    let now = Date.now();
    const platform = new PlatformService(instance.db, instance.rooms.games, () => now);
    const recovered = await platform.tickMatch(instance.match.matchId);
    expect(recovered).toBeNull(); // mid-game tick, not a finish
    const afterRecover = await instance.rooms.match(instance.match.matchId, dropped.player.id);
    expect(afterRecover.version).toBe(versionBefore + 1);
    now += 40000;
    await instance.db.roomMember.updateMany({ where: { roomId: instance.room.id, playerId: { not: dropped.player.id } }, data: { lastSeenAt: new Date(now) } });
    await platform.tickMatch(instance.match.matchId);
    const afterTimeout = await instance.rooms.match(instance.match.matchId, dropped.player.id);
    expect(afterTimeout.version).toBe(versionBefore + 2);
    expect(afterTimeout.status).toBe('active');
    const systemAction = await instance.db.matchAction.findFirst({ where: { matchId: instance.match.matchId, actorId: 'system' }, orderBy: { sequence: 'desc' } });
    expect((systemAction?.payload as { action?: { type?: string } }).action?.type).toBe('timeout');
    // Reconnect: presence restored, same matchId/version, no state rewind.
    await instance.rooms.touch(instance.room.id, dropped.player.id);
    const reconnected = await instance.rooms.match(instance.match.matchId, dropped.player.id);
    expect(reconnected.matchId).toBe(instance.match.matchId);
    expect(reconnected.version).toBe(afterTimeout.version);
    expect(durak(reconnected).hand).toEqual(durak(afterTimeout).hand);
    // Resubmitting the pre-disconnect envelope is idempotent: same receipt, no new version.
    const actionsBefore = await instance.db.matchAction.count({ where: { matchId: instance.match.matchId } });
    const replay = await instance.rooms.action(actor0, sent);
    expect(replay.version).toBe(afterTimeout.version);
    expect(await instance.db.matchAction.count({ where: { matchId: instance.match.matchId } })).toBe(actionsBefore);
    // The reconnected player can keep acting once the turn reaches them. Actions
    // must go through the same clock: the timeout was logged at the fake `now`,
    // and the runtime rejects any action timestamped before the last log entry.
    let view = replay, guard = 0;
    while (durak(view).actorId !== dropped.player.id && view.status === 'active' && guard++ < 200) {
      const actorId = durak(view).actorId!;
      const personal = await platform.match(view.matchId, actorId);
      view = await platform.action(actorId, envelope(personal, actorId, botAction(durak(personal))));
    }
    expect(durak(view).actorId).toBe(dropped.player.id);
    const personal = await platform.match(view.matchId, dropped.player.id);
    const acted = await platform.action(dropped.player.id, envelope(personal, dropped.player.id, botAction(durak(personal))));
    expect(acted.version).toBe(personal.version + 1);
    expect(await instance.db.matchAction.count({ where: { matchId: instance.match.matchId } })).toBe(acted.version);
  }, 60000);

  it('processes each timeout exactly once and chains deterministic system moves', async () => {
    const instance = await setup(3);
    let now = Date.now();
    const platform = new PlatformService(instance.db, instance.rooms.games, () => now);
    let view = await instance.rooms.match(instance.match.matchId, instance.players[0]!.player.id);
    const version0 = view.version;
    // First tick on a fresh service is the one-time 'recover'; later ticks are real timeouts.
    await platform.tickMatch(instance.match.matchId);
    view = await instance.rooms.match(instance.match.matchId, instance.players[0]!.player.id);
    expect(view.version).toBe(version0 + 1);
    for (let i = 0; i < 3; i++) {
      now += 31000;
      await instance.db.roomMember.updateMany({ where: { roomId: instance.room.id }, data: { lastSeenAt: new Date(now) } });
      await platform.tickMatch(instance.match.matchId);
      const next = await instance.rooms.match(instance.match.matchId, instance.players[0]!.player.id);
      expect(next.version).toBe(view.version + 1);
      expect(next.status).toBe('active');
      const last = await instance.db.matchAction.findFirst({ where: { matchId: instance.match.matchId }, orderBy: { sequence: 'desc' } });
      expect((last?.payload as { action?: { type?: string } }).action?.type).toBe('timeout');
      // A second tick at the same instant must not double-apply the deadline.
      await platform.tickMatch(instance.match.matchId);
      expect((await instance.rooms.match(instance.match.matchId, instance.players[0]!.player.id)).version).toBe(next.version);
      view = next;
    }
    expect(await instance.db.matchAction.count({ where: { matchId: instance.match.matchId } })).toBe(view.version);
  }, 60000);

  it('rejects stale, racing, malformed and non-actor actions', async () => {
    const instance = await setup(3);
    // Advance once so expectedVersion has a meaningful "too old" value below current.
    const firstActor = durak(instance.match).actorId!;
    const v0 = await instance.rooms.match(instance.match.matchId, firstActor);
    await instance.rooms.action(firstActor, envelope(v0, firstActor, botAction(durak(v0))));
    const actorId = durak(await instance.rooms.match(instance.match.matchId, firstActor)).actorId!;
    const actorView = await instance.rooms.match(instance.match.matchId, actorId);
    const action = botAction(durak(actorView));
    const other = instance.players.find(p => p.player.id !== actorId)!;
    // Non-actor cannot play the actor's move.
    await expect(instance.rooms.action(other.player.id, envelope(actorView, other.player.id, action))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Stale expectedVersion is a conflict.
    await expect(instance.rooms.action(actorId, { ...envelope(actorView, actorId, action), expectedVersion: actorView.version - 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Malformed action payloads never reach the engine.
    await expect(instance.rooms.action(actorId, envelope(actorView, actorId, { type: 'teleport' }))).rejects.toThrow();
    await expect(instance.rooms.action(actorId, { ...envelope(actorView, actorId, action), expectedVersion: 'soon' } as never)).rejects.toThrow();
    // A player outside the match is forbidden outright.
    await expect(instance.rooms.action('dev:' + '0'.repeat(32), envelope(actorView, actorId, action))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Two concurrent legal actions on the same expectedVersion: exactly one wins.
    const results = await Promise.allSettled([
      instance.rooms.action(actorId, envelope(actorView, actorId, action)),
      instance.rooms.action(actorId, { ...envelope(actorView, actorId, action), requestId: randomUUID() }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');
    expect(ok).toHaveLength(1); expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    const final = await instance.rooms.match(instance.match.matchId, actorId);
    expect(final.version).toBe(actorView.version + 1);
  }, 60000);

  it('surrender forfeits the seat, voids the bout and marks the player a loser', async () => {
    const instance = await setup(3);
    const [p1, p2, p3] = instance.players;
    // p2 surrenders mid-bout (surrender is legal for any active seat, not only the actor).
    const v2 = await instance.rooms.match(instance.match.matchId, p2!.player.id);
    const mid = await instance.rooms.action(p2!.player.id, envelope(v2, p2!.player.id, { type: 'surrender' }));
    expect(mid.status).toBe('active'); // two seats remain: the match continues
    const view2 = durak(await instance.rooms.match(mid.matchId, p2!.player.id));
    expect(view2.forfeited).toBe(true); expect(view2.canSurrender).toBe(false);
    expect(view2.players.find(p => p.id === p2!.player.id)).toMatchObject({ out: true, forfeited: true });
    // The forfeited seat can never act again.
    await expect(instance.rooms.action(p2!.player.id, envelope(mid, p2!.player.id, { type: 'surrender' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // p3 also surrenders: one seat left ends the match immediately.
    const v3 = await instance.rooms.match(mid.matchId, p3!.player.id);
    const done = await instance.rooms.action(p3!.player.id, envelope(v3, p3!.player.id, { type: 'surrender' }));
    expect(done.status).toBe('finished');
    expect(done.result).toEqual({ winners: [p1!.player.id], losers: [p2!.player.id, p3!.player.id], draw: false });
    const outcomes = await instance.db.matchParticipant.findMany({ where: { matchId: done.matchId } });
    expect(outcomes.find(o => o.playerId === p1!.player.id)?.outcome).toBe('win');
    expect(outcomes.find(o => o.playerId === p2!.player.id)?.outcome).toBe('loss');
    expect(outcomes.find(o => o.playerId === p3!.player.id)?.outcome).toBe('loss');
  }, 60000);

  it('settles a finished staked match exactly once', async () => {
    const econ = bridge();
    const instance = await setup(2, { stake: 100, economy: econ, start: false });
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    expect(econ.escrow).toHaveBeenCalledTimes(1);
    expect(match.stakes).toMatchObject({ perPlayer: 100, pool: 200, settlement: 'pending' });
    // Play one real exchange, then finish via surrender.
    const actorId = durak(match).actorId!;
    const v1 = await instance.rooms.match(match.matchId, actorId);
    await instance.rooms.action(actorId, envelope(v1, actorId, botAction(durak(v1))));
    const loser = instance.players.find(p => p.player.id !== actorId)!;
    const v2 = await instance.rooms.match(match.matchId, loser.player.id);
    const done = await instance.rooms.action(loser.player.id, envelope(v2, loser.player.id, { type: 'surrender' }));
    expect(done.status).toBe('finished');
    expect(econ.settle).toHaveBeenCalledTimes(1);
    expect(econ.settle.mock.calls[0]![1]).toEqual([{ userId: actorId, amount: 200 }]);
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_hold', status: 'settled' } })).toBe(2);
    // Settlement is idempotent: re-running it and the timer sweep changes nothing.
    await instance.rooms.settleMatch(match.matchId);
    await instance.rooms.tickTimers();
    expect(econ.settle).toHaveBeenCalledTimes(1);
    expect(econ.refund).not.toHaveBeenCalled();
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_payout', status: 'settled' } })).toBe(1);
    const after = await instance.rooms.match(match.matchId, actorId);
    expect(after.stakes).toMatchObject({ settlement: 'settled' });
  }, 60000);
});
