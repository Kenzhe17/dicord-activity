import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { MatchView, ClientToServerEvents, ServerToClientEvents } from '@rize/shared';
import type { DurakView } from '@rize/durak';
import { connectRoom } from '../../web/src/realtime';
import { buildApp } from './app';
import { loadConfig } from './config';

it('graceful shutdown reconnects both existing clients, resubscribes private hands and preserves action receipts', async () => {
  const config = loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] });
  let server = await buildApp(config, { logger: false, scheduleTimers: false });
  const players = await Promise.all([0, 1].map(i => server.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Reconnect ' + i, avatar: null })));
  const room = await server.rooms.create(players[0]!.player, { gameId: 'durak', name: 'Reconnect', visibility: 'private', settings: { maxPlayers: 2 } }, randomUUID());
  const invitation = await server.rooms.invite(room.id, players[0]!.player.id);
  await server.rooms.join(room.id, players[1]!.player, invitation.code.split(':')[1]);
  for (const player of players) {
    const current = await server.rooms.view(room.id, player.player.id);
    await server.rooms.ready(room.id, player.player.id, true, current.version, randomUUID());
  }
  const match = await server.rooms.start(room.id, players[0]!.player.id, randomUUID());
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const sockets = players.map(player => io('http://127.0.0.1:' + address.port, {
    autoConnect: false, auth: { token: player.token }, transports: ['websocket'],
    extraHeaders: { origin: config.ARCADE_ORIGIN }, reconnectionDelay: 50, reconnectionDelayMax: 100,
  }) as Socket<ServerToClientEvents, ClientToServerEvents>);
  const views: (MatchView | undefined)[] = [], statuses: string[] = [], readyVersions: number[][] = [[], []], diagnostics: unknown[] = [];
  const dispose = sockets.map((socket, i) => connectRoom(socket, room.id, {
    room: () => {}, match: value => { views[i] = value; }, closed: () => {}, error: () => {},
    connection: value => { statuses[i] = value; if (value === 'Подключено') readyVersions[i]!.push(views[i]?.version ?? -1); },
    diagnostic: value => diagnostics.push(value),
  }));
  try {
    await expect.poll(() => statuses).toEqual(['Подключено', 'Подключено']);
    expect(readyVersions).toEqual([[0], [0]]);
    const actor = (match.state as DurakView).actorId!;
    const personal = await server.rooms.match(match.matchId, actor);
    const envelope = { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: randomUUID(), expectedVersion: personal.version, action: (personal.state as DurakView).legalActions[0]! };
    const played = await server.rooms.action(actor, envelope);
    const reasons = sockets.map(socket => new Promise<string>(resolve => socket.once('disconnect', reason => resolve(reason))));
    // Uses the real graceful-close path on Windows too, unlike child.kill(SIGTERM).
    await server.app.close();
    expect(await Promise.all(reasons)).toEqual(['transport close', 'transport close']);
    expect(sockets.every(socket => socket.active)).toBe(true);
    server = await buildApp(config, { logger: false, scheduleTimers: false });
    await server.rooms.tickMatch(match.matchId);
    const recovered = await server.rooms.match(match.matchId, actor);
    expect((recovered.state as DurakView).hand).toEqual((played.state as DurakView).hand);
    expect((recovered.state as DurakView).table).toEqual((played.state as DurakView).table);
    expect((await server.rooms.action(actor, envelope)).version).toBe(recovered.version);
    // Advance while transports are down: subscriptions must deliver this latest version.
    const nextActor = (recovered.state as DurakView).actorId!;
    const next = await server.rooms.match(match.matchId, nextActor);
    const advanced = await server.rooms.action(nextActor, { ...envelope, requestId: randomUUID(), expectedVersion: next.version, action: (next.state as DurakView).legalActions[0]! });
    const expected = await Promise.all(players.map(p => server.rooms.match(match.matchId, p.player.id)));
    await server.app.listen({ host: '127.0.0.1', port: address.port });
    await expect.poll(() => statuses).toEqual(['Подключено', 'Подключено']);
    expect(views).toEqual(expected);
    expect(readyVersions).toEqual([[0, advanced.version], [0, advanced.version]]);
    const a = views[0]!.state as DurakView, b = views[1]!.state as DurakView;
    expect(a.hand.some(card => b.hand.includes(card))).toBe(false);
    for (const value of views) {
      for (const key of ['hands', 'deck', 'seed', 'actions', 'context']) expect(value!.state).not.toHaveProperty(key);
    }
    expect((await server.rooms.action(actor, envelope)).version).toBe(advanced.version);
    expect(await server.db.matchAction.count({ where: { matchId: match.matchId } })).toBe(advanced.version);
    expect(diagnostics).toContainEqual({ event: 'disconnected', reason: 'transport close', automatic: true });
    // An explicit logout/revocation must remain terminal, not become a reconnect loop.
    await server.app.inject({ method: 'DELETE', url: '/api/session', headers: { authorization: 'Bearer ' + players[0]!.token } });
    await expect.poll(() => statuses[0]).toBe('Соединение закрыто');
    expect(sockets[0]!.active).toBe(false);
    expect(diagnostics).toContainEqual({ event: 'disconnected', reason: 'io server disconnect', automatic: false });
    const log = JSON.stringify(diagnostics);
    for (const player of players) { expect(log).not.toContain(player.token); expect(log).not.toContain(player.player.id); }
    expect(log).not.toContain(room.id); expect(log).not.toContain(invitation.code); expect(log).not.toContain('hand');
  } finally {
    dispose.forEach(stop => stop());
    await server.db.matchSnapshot.update({ where: { id: match.matchId }, data: { status: 'interrupted' } });
    await server.db.roomSnapshot.update({ where: { id: room.id }, data: { status: 'closed' } });
    await server.app.close();
  }
}, 20000);
