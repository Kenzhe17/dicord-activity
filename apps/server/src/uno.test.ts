import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PlatformService } from './platform';
import type { UnoView } from '@rize/uno';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, MatchView } from '@rize/shared';
const running: Awaited<ReturnType<typeof buildApp>>[] = [];
const fixtures: { instance: Awaited<ReturnType<typeof buildApp>>; roomId: string; matchId: string }[] = [];
afterEach(async () => {
  for (const { instance, roomId, matchId } of fixtures.splice(0)) {
    await instance.db.matchSnapshot.updateMany({ where: { id: matchId, status: 'active' }, data: { status: 'interrupted' } });
    await instance.db.roomSnapshot.update({ where: { id: roomId }, data: { status: 'closed' } });
  }
  for (const instance of running.splice(0)) await instance.app.close();
});
async function setup(mode: 'quick' | 'points' = 'quick', count = 2) {
  const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, scheduleTimers: false });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Uno ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'uno', name: 'UNO integration', visibility: 'private', settings: { mode, target: 500, maxPlayers: count } }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  const match = await instance.rooms.start(room.id, a.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
  return { ...instance, players, room, match };
}
/** Next legal action for one player's view, or null when they must wait. */
function nextUnoAction(view: MatchView): { action: Record<string, unknown>; version: number } | null {
  const s = view.state as UnoView;
  const legal = s.legal;
  let action: Record<string, unknown> | null = null;
  if (legal.canCallUno) action = { type: 'callUno' };
  else if (legal.canNextRound) action = { type: 'nextRound' };
  else if (s.phase === 'color' && legal.canChooseColor) action = { type: 'chooseColor', color: 'red' };
  else if (s.phase === 'challenge' && s.challenge?.iAmChallenger) action = { type: 'challenge' };
  else if (legal.myTurn && s.phase === 'turn') {
    const card = legal.plays[0];
    if (card !== undefined) action = { type: 'play', card, ...(card >= 100 ? { color: 'red' } : {}), ...(s.hand.length === 2 ? { callUno: true } : {}) };
    else if (legal.canDraw) action = { type: 'draw' };
    else if (legal.canPass) action = { type: 'pass' };
  }
  if (!action) for (const target of legal.catchable) { action = { type: 'catchUno', target }; break; }
  return action ? { action, version: view.version } : null;
}
describe('UNO catalog and settings', () => {
  it('lists UNO as playable and enforces its settings schema over HTTP', async () => {
    const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, scheduleTimers: false });
    running.push(instance);
    const catalog = await instance.app.inject('/api/games');
    expect(catalog.statusCode).toBe(200);
    const uno = (catalog.json() as { id: string; status: string; minPlayers: number; maxPlayers: number }[]).find(g => g.id === 'uno');
    expect(uno).toMatchObject({ status: 'ready', minPlayers: 2, maxPlayers: 10 });
    const session = await instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Catalog', avatar: null });
    const auth = { authorization: 'Bearer ' + session.token };
    const post = (settings: unknown) => instance.app.inject({ method: 'POST', url: '/api/rooms', headers: auth, payload: { requestId: randomUUID(), gameId: 'uno', name: 'UNO catalog', visibility: 'public', settings } });
    expect((await post({ mode: 'invalid' })).statusCode).toBe(400);
    expect((await post({ mode: 'quick', target: 50 })).statusCode).toBe(400);
    expect((await post({ mode: 'quick', stake: 100 })).statusCode).toBe(400);
    const created = await post({ mode: 'quick' });
    expect(created.statusCode).toBe(200);
    const room = created.json() as { id: string; settings: unknown };
    expect(room.settings).toEqual({ mode: 'quick', target: 500, maxPlayers: 10 });
    await instance.rooms.close(room.id, session.player.id);
  });
});
describe('UNO persistence and multiplayer', () => {
  it('plays a full quick match to a persisted result with idempotent retries', async () => {
    const instance = await setup('quick', 3), a = instance.players[0]!;
    await instance.db.playerStatistic.create({ data: { playerId: a.player.id, gameId: 'uno', rating: 1400 } });
    let view = instance.match, step = 0, actions = 0, lastEnvelope: Record<string, unknown> | null = null, lastActor = '';
    while (view.status === 'active' && step++ < 4000) {
      // The acting player differs per phase; scan views until someone can move.
      let moved = false;
      for (const p of instance.players) {
        let candidate = await instance.rooms.match(view.matchId, p.player.id);
        // Retry on a stale version: a legitimate system tick (timeout, turn
        // pass) inside action() bumps the version between our read and write.
        for (let attempt = 0; attempt < 4; attempt++) {
          const next = nextUnoAction(candidate);
          if (!next) break;
          const envelope = { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: randomUUID(), expectedVersion: next.version, action: next.action };
          lastEnvelope = envelope; lastActor = p.player.id;
          try {
            view = await instance.rooms.action(p.player.id, envelope);
            actions++; moved = true;
            break;
          } catch (error) {
            if (attempt === 3 || !(error instanceof Error) || !error.message.includes('Устаревшая версия')) throw error;
            candidate = await instance.rooms.match(view.matchId, p.player.id);
          }
        }
        if (moved) break;
      }
      if (!moved) throw new Error('No legal UNO action found at step ' + step);
      if (step === 10) {
        const recovered = new PlatformService(instance.db, instance.rooms.games);
        expect((await recovered.match(view.matchId, lastActor)).state).toEqual(view.state);
      }
      if (view.status === 'finished') {
        // Replaying the last receipt returns the stored result without a new action.
        await instance.rooms.action(lastActor, lastEnvelope);
        expect(await instance.db.matchAction.count({ where: { matchId: view.matchId } })).toBe(view.version);
      }
    }
    expect(view.status).toBe('finished');
    expect(actions).toBeGreaterThan(0);
    expect((await instance.rooms.history(a.player.id))[0]).toMatchObject({ ratingDelta: 0 });
    const stat = (await instance.rooms.profile(a.player.id)).statistics[0]!;
    expect(stat.played).toBe(1); expect(stat.rating).toBe(1400);
    expect(await instance.db.matchParticipant.count({ where: { matchId: view.matchId, outcome: { not: null } } })).toBe(3);
    await instance.rooms.close(instance.room.id, a.player.id);
  }, 120000);
  it('rejects cards outside the hand and hides other players hands', async () => {
    const instance = await setup('quick', 2);
    const [a, b] = instance.players;
    const viewA = await instance.rooms.match(instance.match.matchId, a!.player.id);
    const viewB = await instance.rooms.match(instance.match.matchId, b!.player.id);
    const sa = viewA.state as UnoView, sb = viewB.state as UnoView;
    expect(sa.hand.length).toBe(7); expect(sb.hand.length).toBe(7);
    expect(sa.hand.some(c => sb.hand.includes(c))).toBe(false);
    expect(sa).not.toHaveProperty('deck'); expect(sa).not.toHaveProperty('hands');
    const actor = instance.players.find(p => p.player.id === sa.actorId)!;
    const view = await instance.rooms.match(viewA.matchId, actor.player.id);
    const s = view.state as UnoView;
    const card = Array.from({ length: 108 }, (_, i) => i).find(c => !s.hand.includes(c))!;
    await expect(instance.rooms.action(actor.player.id, { protocol: 1, roomId: instance.room.id, matchId: view.matchId, requestId: randomUUID(), expectedVersion: view.version, action: { type: 'play', card } })).rejects.toThrow();
  });
  it('restores checkpoints serialized before late state fields existed', async () => {
    const instance = await setup();
    const row = await instance.db.matchSnapshot.findUniqueOrThrow({ where: { id: instance.match.matchId } });
    const checkpoint = row.state as Record<string, unknown>;
    const legacy = JSON.parse(checkpoint['serialized'] as string) as Record<string, unknown>;
    // Fields added to stateSchema after early UNO checkpoints were written
    // must default instead of ZodError-ing every timer tick.
    for (const key of ['forfeited', 'out', 'pausedRemaining', 'pendingDraw', 'awaiting', 'challenge', 'roundWinner', 'roundPoints', 'lastEvent']) delete legacy[key];
    await instance.db.matchSnapshot.update({ where: { id: row.id }, data: { state: { ...checkpoint, serialized: JSON.stringify(legacy) } } });
    const platform = new PlatformService(instance.db, instance.rooms.games);
    await expect(platform.tickMatch(instance.match.matchId)).resolves.toBeNull();
    const view = await platform.match(instance.match.matchId, instance.players[0]!.player.id);
    expect(view.status).toBe('active');
    const { failures } = await platform.tickTimers();
    expect(failures.map(f => f.matchId)).not.toContain(instance.match.matchId);
  }, 30000); // tickTimers sweeps every active match in the shared arcade_test database
  it('persists pause/resume, processes each timeout once and gives recovery grace', async () => {
    const instance = await setup();
    let now = Date.now();
    const platform = new PlatformService(instance.db, instance.rooms.games, () => now);
    await platform.tickMatch(instance.match.matchId);
    const restored = await platform.match(instance.match.matchId, instance.players[0]!.player.id);
    expect((restored.state as UnoView).deadline).toBeGreaterThanOrEqual(now + 30000);
    now += 60000;
    await instance.db.roomMember.updateMany({ where: { roomId: instance.room.id }, data: { lastSeenAt: new Date(now - 60000) } });
    await platform.tickMatch(restored.matchId);
    let view = await platform.match(restored.matchId, instance.players[0]!.player.id); expect((view.state as UnoView).paused).toBe(true);
    const pausedVersion = view.version; await platform.tickMatch(view.matchId); expect((await platform.match(view.matchId, instance.players[0]!.player.id)).version).toBe(pausedVersion);
    await platform.touch(instance.room.id, instance.players[0]!.player.id); await platform.tickMatch(view.matchId);
    view = await platform.match(view.matchId, instance.players[0]!.player.id); expect((view.state as UnoView).paused).toBe(false);
    now += 1; await Promise.all([platform.tickMatch(view.matchId), platform.tickMatch(view.matchId)]);
    const timed = await platform.match(view.matchId, instance.players[0]!.player.id);
    expect(timed.version).toBe(view.version + 1); expect(timed.status).toBe('active');
  });
  it('streams separate hands to two sockets and rejects system-action injection', async () => {
    const instance = await setup(); await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const address = instance.app.server.address(); if (!address || typeof address === 'string') throw new Error('Address');
    const sockets = instance.players.map(p => connect('http://127.0.0.1:' + address.port, { auth: { token: p.token }, extraHeaders: { origin: 'http://127.0.0.1:5173' }, transports: ['websocket'] }) as Socket<ServerToClientEvents, ClientToServerEvents>);
    try {
      await Promise.all(sockets.map(s => new Promise<void>((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); })));
      const views: MatchView[] = [];
      for (const socket of sockets) { const received = new Promise<MatchView>(resolve => socket.once('match:state', resolve)); await socket.emitWithAck('room:subscribe', { roomId: instance.room.id }); views.push(await received); }
      const a = views[0]!.state as UnoView, b = views[1]!.state as UnoView;
      expect(a.hand.some(c => b.hand.includes(c))).toBe(false); expect(a).not.toHaveProperty('deck');
      const actorIndex = instance.players.findIndex(p => p.player.id === a.actorId), actor = sockets[actorIndex]!;
      const envelope = { protocol: 1 as const, roomId: instance.room.id, matchId: instance.match.matchId, requestId: randomUUID(), expectedVersion: 0, action: { type: 'timeout' } };
      expect((await actor.emitWithAck('match:action', envelope)).ok).toBe(false);
      const updates = sockets.map(s => new Promise<MatchView>(resolve => s.once('match:state', resolve)));
      expect((await actor.emitWithAck('match:action', { ...envelope, requestId: randomUUID(), expectedVersion: views[actorIndex]!.version, action: { type: 'surrender' } })).ok).toBe(true);
      expect((await Promise.all(updates)).map(v => v.version)).toEqual([views[0]!.version + 1, views[1]!.version + 1]);
    } finally { sockets.forEach(s => s.disconnect()); }
  });
});
