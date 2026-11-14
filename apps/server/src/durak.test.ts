import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PlatformService } from './platform';
import type { DurakView } from '@rize/durak';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, MatchView } from '@rize/shared';
const running: Awaited<ReturnType<typeof buildApp>>[] = [];
const fixtures: { instance: Awaited<ReturnType<typeof buildApp>>; roomId: string; matchId: string }[] = [];
afterEach(async () => {
  // Retain test history, but never leave synthetic clocks/corrupted snapshots active.
  for (const { instance, roomId, matchId } of fixtures.splice(0)) {
    await instance.db.matchSnapshot.updateMany({ where: { id: matchId, status: 'active' }, data: { status: 'interrupted' } });
    await instance.db.roomSnapshot.update({ where: { id: roomId }, data: { status: 'closed' } });
  }
  for (const instance of running.splice(0)) await instance.app.close();
});
async function setup(mode = 'throw-in', count = 2) {
  const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, scheduleTimers: false });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Durak ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'durak', name: 'Durak integration', visibility: 'private', settings: { mode, maxPlayers: count } }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  const match = await instance.rooms.start(room.id, a.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
  return { ...instance, players, room, match };
}
describe('Durak persistence and multiplayer', () => {
  it('restores checkpoints serialized before the forfeited field existed', async () => {
    const instance = await setup();
    const row = await instance.db.matchSnapshot.findUniqueOrThrow({ where: { id: instance.match.matchId } });
    const checkpoint = row.state as Record<string, unknown>;
    const legacy = JSON.parse(checkpoint['serialized'] as string) as Record<string, unknown>;
    delete legacy['forfeited'];
    await instance.db.matchSnapshot.update({ where: { id: row.id }, data: { state: { ...checkpoint, serialized: JSON.stringify(legacy) } } });
    const platform = new PlatformService(instance.db, instance.rooms.games);
    await expect(platform.tickMatch(instance.match.matchId)).resolves.toBeNull();
    expect((await platform.match(instance.match.matchId, instance.players[0]!.player.id)).status).toBe('active');
  });
  it('quarantines a permanently unrestorable match instead of erroring every second', async () => {
    const instance = await setup();
    const row = await instance.db.matchSnapshot.findUniqueOrThrow({ where: { id: instance.match.matchId } });
    const checkpoint = row.state as Record<string, unknown>;
    // Engine-version drift is a deterministic DomainError on every tick.
    await instance.db.matchSnapshot.update({ where: { id: row.id }, data: { state: { ...checkpoint, stateVersion: 99 } } });
    const platform = new PlatformService(instance.db, instance.rooms.games);
    for (let i = 0; i < 9; i++) await expect(platform.tickMatch(instance.match.matchId)).rejects.toThrow();
    await expect(platform.tickMatch(instance.match.matchId)).resolves.toEqual({ matchId: instance.match.matchId, roomId: instance.room.id });
    expect((await instance.db.matchSnapshot.findUniqueOrThrow({ where: { id: instance.match.matchId } })).status).toBe('interrupted');
    const roomRow = await instance.db.roomSnapshot.findUniqueOrThrow({ where: { id: instance.room.id } });
    expect(roomRow.status).toBe('waiting'); expect(roomRow.activeMatchId).toBeNull();
    const { failures } = await platform.tickTimers();
    expect(failures.map(f => f.matchId)).not.toContain(instance.match.matchId);
  }, 30000); // ten serialized tickMatch transactions queue on the shared advisory lock
  it('isolates a damaged persisted match so other tables still recover their timers', async () => {
    const broken = await setup(), healthy = await setup();
    await broken.db.matchSnapshot.update({ where: { id: broken.match.matchId }, data: { state: {} } });
    const restarted = new PlatformService(healthy.db, healthy.rooms.games, () => Date.now() + 1000);
    // tickTimers sweeps active matches in bounded round-robin batches, so a
    // single call may not reach these newest fixtures — keep sweeping passes.
    let sawFailure = false, sawResume = false;
    for (let pass = 0; pass < 80 && !(sawFailure && sawResume); pass++) {
      const { failures } = await restarted.tickTimers();
      sawFailure ||= failures.some(f => f.matchId === broken.match.matchId && f.errorName === 'ZodError');
      const recovered = await restarted.match(healthy.match.matchId, healthy.players[0]!.player.id);
      if (recovered.version === 1 && (recovered.state as DurakView).lastEvent === 'resume') sawResume = true;
    }
    expect(sawFailure).toBe(true);
    expect(sawResume).toBe(true);
  }, 90000); // tickTimers sweeps active matches in bounded batches across the shared arcade_test database
  it.each(['throw-in', 'transfer'])('finishes %s, restores/retries and records statistics with unchanged rating', async mode => {
    const instance = await setup(mode, 3), a = instance.players[0]!;
    await instance.db.playerStatistic.create({ data: { playerId: a.player.id, gameId: 'durak', rating: 1327 } });
    let view = instance.match, step = 0;
    while (view.status === 'active' && step++ < 1000) {
      // Keep presence fresh so the 45s offline-pause cannot fire mid-test, and
      // retry once on a stale version: a legitimate system tick (pause/timeout)
      // inside action() bumps the version between our read and our write.
      await instance.rooms.touch(instance.room.id, instance.players[0]!.player.id);
      let actorId = '', envelope: Parameters<typeof instance.rooms.action>[1] | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        actorId = (view.state as DurakView).actorId!;
        view = await instance.rooms.match(view.matchId, actorId);
        const state = view.state as DurakView;
        const action = state.legalActions.find(a => a.type === 'defend') ?? state.legalActions.find(a => a.type === 'transfer') ?? state.legalActions[0]!;
        envelope = { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: randomUUID(), expectedVersion: view.version, action };
        try {
          view = await instance.rooms.action(actorId, envelope);
          break;
        } catch (error) {
          if (attempt === 3 || !(error instanceof Error) || !error.message.includes('Устаревшая версия')) throw error;
        }
      }
      if (step === 5) {
        const recovered = new PlatformService(instance.db, instance.rooms.games);
        expect((await recovered.match(view.matchId, actorId)).state).toEqual(view.state);
        // Read and duplicate receipt recovery do not depend on a process-local runtime.
      }
      if (view.status === 'finished') {
        await instance.rooms.action(actorId, envelope!);
        expect(await instance.db.matchAction.count({ where: { matchId: view.matchId } })).toBe(view.version);
      }
    }
    expect(view.status).toBe('finished');
    expect((await instance.rooms.history(a.player.id))[0]).toMatchObject({ ratingDelta: 0 });
    const stat = (await instance.rooms.profile(a.player.id)).statistics[0]!;
    expect(stat.played).toBe(1); expect(stat.rating).toBe(1327);
    expect(await instance.db.matchParticipant.count({ where: { matchId: view.matchId, outcome: { not: null } } })).toBe(3);
    await instance.rooms.close(instance.room.id, a.player.id);
  }, 90000);
  it('persists pause/resume, processes each timeout once and gives recovery grace', async () => {
    const instance = await setup();
    let now = Date.now();
    const platform = new PlatformService(instance.db, instance.rooms.games, () => now);
    await platform.tickMatch(instance.match.matchId);
    const restored = await platform.match(instance.match.matchId, instance.players[0]!.player.id);
    expect((restored.state as DurakView).deadline).toBeGreaterThanOrEqual(now + 30000);
    now += 60000;
    await instance.db.roomMember.updateMany({ where: { roomId: instance.room.id }, data: { lastSeenAt: new Date(now - 60000) } });
    await platform.tickMatch(restored.matchId);
    let view = await platform.match(restored.matchId, instance.players[0]!.player.id); expect((view.state as DurakView).paused).toBe(true);
    const pausedVersion = view.version; await platform.tickMatch(view.matchId); expect((await platform.match(view.matchId, instance.players[0]!.player.id)).version).toBe(pausedVersion);
    await platform.touch(instance.room.id, instance.players[0]!.player.id); await platform.tickMatch(view.matchId);
    view = await platform.match(view.matchId, instance.players[0]!.player.id); expect((view.state as DurakView).paused).toBe(false);
    now += 1; await Promise.all([platform.tickMatch(view.matchId), platform.tickMatch(view.matchId)]);
    const timed = await platform.match(view.matchId, instance.players[0]!.player.id);
    expect(timed.version).toBe(view.version + 1); expect(timed.status).toBe('active');
    expect((timed.state as DurakView).phase).toBe('defending');
    expect((timed.state as DurakView).deadline).toBe(now + 30000);
  });
  it('streams separate hands to two sockets and rejects system-action injection', async () => {
    const instance = await setup(); await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const address = instance.app.server.address(); if (!address || typeof address === 'string') throw new Error('Address');
    const sockets = instance.players.map(p => connect('http://127.0.0.1:' + address.port, { auth: { token: p.token }, extraHeaders: { origin: 'http://127.0.0.1:5173' }, transports: ['websocket'] }) as Socket<ServerToClientEvents, ClientToServerEvents>);
    try {
      await Promise.all(sockets.map(s => new Promise<void>((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); })));
      const views: MatchView[] = [];
      for (const socket of sockets) { const received = new Promise<MatchView>(resolve => socket.once('match:state', resolve)); await socket.emitWithAck('room:subscribe', { roomId: instance.room.id }); views.push(await received); }
      const a = views[0]!.state as DurakView, b = views[1]!.state as DurakView;
      expect(a.hand.some(c => b.hand.includes(c))).toBe(false); expect(a).not.toHaveProperty('deck');
      const actorIndex = instance.players.findIndex(p => p.player.id === a.actorId), actor = sockets[actorIndex]!;
      const envelope = { protocol: 1 as const, roomId: instance.room.id, matchId: instance.match.matchId, requestId: randomUUID(), expectedVersion: 0, action: { type: 'timeout' } };
      expect((await actor.emitWithAck('match:action', envelope)).ok).toBe(false);
      const state = views[actorIndex]!.state as DurakView;
      const updates = sockets.map(s => new Promise<MatchView>(resolve => s.once('match:state', resolve)));
      expect((await actor.emitWithAck('match:action', { ...envelope, requestId: randomUUID(), action: state.legalActions[0]! })).ok).toBe(true);
      expect((await Promise.all(updates)).map(v => v.version)).toEqual([1, 1]);
    } finally { sockets.forEach(s => s.disconnect()); }
  });
});
