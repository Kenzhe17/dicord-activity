import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { AuthSession } from '@rize/discord';
import type { RoomView, ClientToServerEvents, ServerToClientEvents } from '@rize/shared';
import { loadConfig } from './config';
import { buildApp } from './app';
const running: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(({ app }) => app.close())); });
async function create() {
  const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false });
  running.push(instance);
  return instance;
}
async function login(app: Awaited<ReturnType<typeof buildApp>>['app'], name = 'Tester') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev', payload: { name } });
  expect(response.statusCode).toBe(200);
  return response.json<AuthSession>();
}
describe('HTTP foundation', () => {
  it('separates verified players behind one proxy while invalid token rotation stays IP limited', async () => {
    const { app } = await create();
    const a = await login(app, 'Rate A'), b = await login(app, 'Rate B');
    for (let i = 0; i < 180; i++) expect((await app.inject({ url: '/api/me', headers: { authorization: 'Bearer ' + a.token } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { authorization: 'Bearer ' + a.token } })).statusCode).toBe(429);
    expect((await app.inject({ url: '/api/me', headers: { authorization: 'Bearer ' + b.token } })).statusCode).toBe(200);
    let status = 0;
    for (let i = 0; i < 181; i++) status = (await app.inject({ url: '/api/me', headers: { authorization: 'Bearer invalid-' + i } })).statusCode;
    expect(status).toBe(429);
  });
  it('boots with PostgreSQL, serves registry and protects room endpoints', async () => {
    const { app } = await create();
    expect((await app.inject('/health/ready')).json()).toMatchObject({ databaseConnected: true, persistence: 'postgresql' });
    expect((await app.inject('/api/games')).json()).toHaveLength(3);
    expect((await app.inject('/api/rooms')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/games', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
  });
  it('supports authenticated room creation, join, ready, transfer and leave', async () => {
    const { app } = await create();
    const a = await login(app, 'A');
    const b = await login(app, 'B');
    const auth = { authorization: 'Bearer ' + a.token };
    const authB = { authorization: 'Bearer ' + b.token };
    const response = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth, payload: { gameId: 'durak', name: 'Table', visibility: 'public', requestId: randomUUID() } });
    expect(response.statusCode).toBe(200);
    const room = response.json<RoomView>();
    expect((await app.inject({ url: '/api/rooms/' + room.id, headers: authB })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/rooms/' + room.id + '/join', headers: authB })).json<RoomView>().members).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: '/api/rooms/' + room.id + '/ready', headers: authB, payload: { ready: true, expectedVersion: 0, requestId: randomUUID() } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/rooms/' + room.id + '/ready', headers: authB, payload: { ready: true, expectedVersion: 1, requestId: randomUUID() } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/rooms/' + room.id + '/host', headers: auth, payload: { targetId: b.player.id } })).json<RoomView>().hostId).toBe(b.player.id);
    expect((await app.inject({ method: 'DELETE', url: '/api/rooms/' + room.id + '/membership', headers: authB })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/rooms/' + room.id, headers: auth })).json<RoomView>().hostId).toBe(a.player.id);
  });
  it('rejects identity injection, malformed bodies and revoked sessions', async () => {
    const { app } = await create();
    expect((await app.inject({ method: 'POST', url: '/api/auth/dev', payload: { name: 'X', id: '123456789012345678' } })).statusCode).toBe(400);
    const a = await login(app);
    const headers = { authorization: 'Bearer ' + a.token };
    expect((await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { gameId: 'durak', name: '', visibility: 'public' } })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: '/api/session', headers });
    expect((await app.inject({ url: '/api/me', headers })).statusCode).toBe(401);
  });
  it('refuses mock production even when NODE_ENV and ARCADE_ENV disagree', () => {
    expect(() => loadConfig({ ARCADE_ENV: 'production', ARCADE_AUTH_MODE: 'mock' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', ARCADE_ENV: 'development', ARCADE_AUTH_MODE: 'mock' })).toThrow();
    expect(() => loadConfig({ ARCADE_AUTH_MODE: 'discord' })).toThrow();
  });
  it('reports database readiness in production and refuses mock login', async () => {
    const instance = await buildApp(loadConfig({ ARCADE_ENV: 'production', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false });
    running.push(instance);
    expect((await instance.app.inject('/health/live')).statusCode).toBe(200);
    expect((await instance.app.inject('/health/ready')).statusCode).toBe(200);
    expect((await instance.app.inject({ method: 'POST', url: '/api/auth/dev', payload: { name: 'Not allowed' } })).statusCode).toBe(403);
  });
});
describe('economy bridge', () => {
  it('reports disabled without configuration and proxies read-only balances when enabled', async () => {
    const { app } = await create();
    const session = await login(app);
    const headers = { authorization: 'Bearer ' + session.token };
    const disabled = await app.inject({ method: 'GET', url: '/api/economy/balance', headers });
    expect(disabled.json()).toEqual({ enabled: false });
    const bridged = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), {
      logger: false,
      economy: { getBalance: async id => id === session.player.id ? { balance: 1234, exists: true } : null },
    });
    running.push(bridged);
    const ok = await bridged.app.inject({ method: 'GET', url: '/api/economy/balance', headers });
    expect(ok.json()).toEqual({ enabled: true, available: true, balance: 1234, walletExists: true });
    expect((await bridged.app.inject({ method: 'GET', url: '/api/economy/balance' })).statusCode).toBe(401);
    const down = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, economy: { getBalance: async () => null } });
    running.push(down);
    expect((await down.app.inject({ method: 'GET', url: '/api/economy/balance', headers })).json()).toEqual({ enabled: true, available: false });
  });
});

describe('Socket.IO integration', () => {
  it('requires session, checks membership and streams room changes', async () => {
    const { app, rooms } = await create();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const a = await login(app);
    const b = await login(app);
    const room = await rooms.create(a.player, { gameId: 'durak', name: 'Realtime', visibility: 'private' }, randomUUID());
    const url = 'http://127.0.0.1:' + address.port;
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = connect(url, { auth: { token: a.token }, extraHeaders: { origin: 'http://127.0.0.1:5173' }, transports: ['websocket'], reconnection: false });
    const bad = connect(url, { auth: { token: 'invalid' }, extraHeaders: { origin: 'http://127.0.0.1:5173' }, transports: ['websocket'], reconnection: false });
    try {
      await Promise.all([new Promise<void>((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); }), new Promise<void>(resolve => bad.on('connect_error', () => resolve()))]);
      const subscribed = await socket.emitWithAck('room:subscribe', { roomId: room.id });
      expect(subscribed.ok).toBe(true);
      const outsider = await rooms.create(b.player, { gameId: 'uno', name: 'Other', visibility: 'private' }, randomUUID());
      expect((await socket.emitWithAck('room:subscribe', { roomId: outsider.id })).ok).toBe(false);
      const update = new Promise<RoomView>(resolve => socket.once('room:state', resolve));
      await app.inject({ method: 'POST', url: '/api/rooms/' + room.id + '/ready', headers: { authorization: 'Bearer ' + a.token }, payload: { ready: true, expectedVersion: 0, requestId: randomUUID() } });
      expect((await update).members[0]?.ready).toBe(true);
      const disconnected = new Promise<void>(resolve => socket.once('disconnect', () => resolve()));
      await app.inject({ method: 'DELETE', url: '/api/session', headers: { authorization: 'Bearer ' + a.token } });
      await disconnected;
      expect(socket.connected).toBe(false);
    } finally { socket.disconnect(); bad.disconnect(); }
  });
});
