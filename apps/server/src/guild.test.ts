import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { AuthProvider, AuthSession } from '@rize/discord';
import type { ClientToServerEvents, ServerToClientEvents } from '@rize/shared';
import { loadConfig } from './config';
import { buildApp } from './app';
import { DiscordGuildVerifier } from './guild';
import type { GuildVerifier } from './guild';

const ALLOWED = '1196165488565289012';
const DISCORD_ID = '123456789012345678';
const running: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(({ app }) => app.close())); });

// Unique snowflake-shaped id per run: the shared test DB persists rooms/sessions.
const DB_ID = '323456789' + String(Date.now()).slice(-9);
const player = { id: DB_ID, name: 'DiscordUser', username: 'discorduser', avatar: null };
const oauth: AuthProvider = { authenticate: async () => ({ player, accessToken: 'discord-token' }) };

function discordConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'discord',
    ARCADE_DISCORD_CLIENT_ID: DISCORD_ID, ARCADE_DISCORD_CLIENT_SECRET: 'secret',
    ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'], ...extra,
  });
}
async function createDiscordApp(verifier: GuildVerifier | null, extra: Record<string, string> = {}) {
  const instance = await buildApp(discordConfig(extra), { logger: false, oauth, guildVerifier: verifier });
  running.push(instance);
  return instance;
}
async function discordLogin(app: Awaited<ReturnType<typeof buildApp>>['app'], instanceId = 'i-abc-gc-1-2') {
  const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge' });
  const { state } = challenge.json<{ state: string }>();
  return app.inject({ method: 'POST', url: '/api/auth/discord', payload: { code: 'auth-code', state, instanceId } });
}
const okVerifier: GuildVerifier = { verify: async () => ({ guildId: ALLOWED, instanceId: 'i-abc-gc-1-2' }) };

describe('DiscordGuildVerifier', () => {
  const instance = {
    application_id: DISCORD_ID, instance_id: 'i-1', launch_id: 'l',
    location: { id: 'gc-1-2', kind: 'gc', channel_id: '2', guild_id: ALLOWED },
    users: [DISCORD_ID, '999999999999999999'],
  };
  const appMe = { id: DISCORD_ID, name: 'rize3 Arcade' };
  function stub(responses: Record<string, { body: unknown; status?: number } | ((url: string) => { body: unknown; status?: number })>) {
    return vi.fn(async (input: unknown) => {
      const url = String(input);
      const hit = url.includes('/oauth2/applications/@me') ? responses['app'] : responses['instance'];
      const resolved = typeof hit === 'function' ? hit(url) : hit;
      if (!resolved) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(resolved.body), { status: resolved.status ?? 200 });
    }) as unknown as typeof fetch;
  }
  const okResponses = { app: { body: appMe }, instance: { body: instance } };
  const FAST = [1, 1, 1];
  const base = { applicationId: DISCORD_ID, instanceId: 'i-1', userId: DISCORD_ID };
  it('confirms a valid guild-channel instance with the user inside', async () => {
    const v = new DiscordGuildVerifier('bot-token', ALLOWED, stub(okResponses));
    await expect(v.verify(base)).resolves.toEqual({ guildId: ALLOWED, instanceId: 'i-1' });
  });
  it('rejects a bot token that does not belong to the Arcade application', async () => {
    const reasons: string[] = [];
    for (const app of [{ body: {}, status: 401 }, { body: { id: '000000000000000000' } }]) {
      const v = new DiscordGuildVerifier('bad-token', ALLOWED, stub({ app, instance: okResponses.instance }), (r) => reasons.push(r));
      await expect(v.verify(base)).resolves.toBeNull();
    }
    expect(reasons).toContain('invalid_bot_token');
  });
  it('retries transient 404s and user-list lag, then succeeds', async () => {
    let instanceCalls = 0;
    const request = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/oauth2/applications/@me')) return new Response(JSON.stringify(appMe));
      instanceCalls++;
      if (instanceCalls === 1) return new Response('{}', { status: 404 });
      if (instanceCalls === 2) return new Response(JSON.stringify({ ...instance, users: [] }));
      return new Response(JSON.stringify(instance));
    }) as unknown as typeof fetch;
    const v = new DiscordGuildVerifier('bot-token', ALLOWED, request, undefined, FAST);
    await expect(v.verify(base)).resolves.toEqual({ guildId: ALLOWED, instanceId: 'i-1' });
    expect(instanceCalls).toBe(3);
  });
  it('gives up after bounded retries with a diagnosable reason', async () => {
    const reasons: string[] = [];
    const v = new DiscordGuildVerifier('bot-token', ALLOWED, stub({ app: okResponses.app, instance: { body: { ...instance, users: [] } } }), (r) => reasons.push(r), FAST);
    await expect(v.verify(base)).resolves.toBeNull();
    expect(reasons).toContain('user_not_present');
    const missing = new DiscordGuildVerifier('bot-token', ALLOWED, stub({ app: okResponses.app, instance: { body: {}, status: 404 } }), (r) => reasons.push(r), FAST);
    await expect(missing.verify(base)).resolves.toBeNull();
    expect(reasons).toContain('discord_http_404');
  });
  it('rejects other guilds, non-guild locations, foreign apps, missing users and API failures', async () => {
    const cases: [unknown, number][] = [
      [{ ...instance, location: { ...instance.location, guild_id: '999999999999999999' } }, 200],
      [{ ...instance, location: { ...instance.location, kind: 'dm' } }, 200],
      [{ ...instance, application_id: '000000000000000000' }, 200],
      [{ ...instance, instance_id: 'other' }, 200],
      [{ ...instance, users: ['999999999999999999'] }, 200],
      [{ error: 'unknown' }, 400],
      [{ broken: true }, 200],
    ];
    for (const [body, status] of cases) {
      const v = new DiscordGuildVerifier('bot-token', ALLOWED, stub({ app: okResponses.app, instance: { body, status } }), undefined, FAST);
      await expect(v.verify(base)).resolves.toBeNull();
    }
    const offline = new DiscordGuildVerifier('bot-token', ALLOWED, vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch, undefined, FAST);
    await expect(offline.verify(base)).resolves.toBeNull();
  });
});

describe('guild-restricted Discord auth', () => {
  it('issues a bound session inside the allowed guild and serves game APIs', async () => {
    const { app, sessions } = await createDiscordApp(okVerifier);
    const login = await discordLogin(app);
    expect(login.statusCode).toBe(200);
    const session = login.json<AuthSession>();
    expect(session.guildId).toBe(ALLOWED);
    expect(session.instanceId).toBe('i-abc-gc-1-2');
    const auth = { authorization: 'Bearer ' + session.token };
    expect((await app.inject({ url: '/api/me', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/bootstrap', headers: auth })).statusCode).toBe(200);
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth, payload: { gameId: 'durak', name: 'Guild table', visibility: 'public', requestId: randomUUID() } });
    expect(created.statusCode).toBe(200);
    const stored = await sessions.get(session.token);
    expect(stored.guildId).toBe(ALLOWED);
    await app.inject({ method: 'DELETE', url: '/api/rooms/' + created.json<{ id: string }>().id, headers: auth });
  });
  it('rejects login when Discord cannot confirm the allowed guild', async () => {
    for (const verifier of [
      { verify: async () => null } satisfies GuildVerifier,
      { verify: async () => ({ guildId: '999999999999999999', instanceId: 'i-abc-gc-1-2' }) } satisfies GuildVerifier,
      null,
    ]) {
      const { app } = await createDiscordApp(verifier);
      const login = await discordLogin(app);
      expect(login.statusCode).toBe(403);
      expect(login.json<{ error: { code: string } }>().error.code).toBe('GUILD_RESTRICTED');
    }
  });
  it('rejects a forged guildId claim even when the instance verifies', async () => {
    const { app } = await createDiscordApp(okVerifier);
    const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge' });
    const { state } = challenge.json<{ state: string }>();
    const forged = await app.inject({ method: 'POST', url: '/api/auth/discord', payload: { code: 'c', state, instanceId: 'i-abc-gc-1-2', guildId: '999999999999999999' } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ error: { code: string } }>().error.code).toBe('GUILD_RESTRICTED');
  });
  it('denies sessions without a verified guild binding on every protected route', async () => {
    const { app, sessions } = await createDiscordApp(okVerifier);
    const legacy = await sessions.create(player); // pre-binding session, e.g. issued before rollout
    const auth = { authorization: 'Bearer ' + legacy.token };
    for (const [method, url] of [['GET', '/api/me'], ['GET', '/api/bootstrap'], ['GET', '/api/rooms'], ['GET', '/api/profile'], ['GET', '/api/economy/balance'], ['POST', '/api/rooms']] as const) {
      const response = await app.inject({ method, url, headers: auth, ...(method === 'POST' ? { payload: { gameId: 'durak', name: 'x', visibility: 'public', requestId: randomUUID() } } : {}) });
      expect(response.statusCode, url).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('GUILD_RESTRICTED');
    }
  });
  it('keeps public endpoints reachable and reports the restriction config', async () => {
    const { app } = await createDiscordApp(okVerifier, { ARCADE_SERVER_INVITE_URL: 'https://discord.gg/rize3' });
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    expect((await app.inject('/api/games')).statusCode).toBe(200);
    const config = await app.inject('/api/config');
    expect(config.json()).toMatchObject({ allowedGuildId: ALLOWED, serverInviteUrl: 'https://discord.gg/rize3' });
    const bad = await createDiscordApp(okVerifier, { ARCADE_SERVER_INVITE_URL: 'https://evil.example/phish' });
    expect((await bad.app.inject('/api/config')).json()).toMatchObject({ serverInviteUrl: null });
  });
  it('fails closed when the activity instance id is missing', async () => {
    const { app } = await createDiscordApp(okVerifier);
    const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge' });
    const { state } = challenge.json<{ state: string }>();
    const response = await app.inject({ method: 'POST', url: '/api/auth/discord', payload: { code: 'c', state } });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('GUILD_RESTRICTED');
  });
  it('rejects realtime connections from unbound sessions', async () => {
    const { app, sessions } = await createDiscordApp(okVerifier);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const url = 'http://127.0.0.1:' + address.port;
    const bound = await discordLogin(app);
    const boundToken = bound.json<AuthSession>().token;
    const unbound = await sessions.create(player);
    const good: Socket<ServerToClientEvents, ClientToServerEvents> = connect(url, { auth: { token: boundToken }, extraHeaders: { origin: 'http://127.0.0.1:5173' }, transports: ['websocket'], reconnection: false });
    const bad: Socket<ServerToClientEvents, ClientToServerEvents> = connect(url, { auth: { token: unbound.token }, extraHeaders: { origin: 'http://127.0.0.1:5173' }, transports: ['websocket'], reconnection: false });
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => { good.on('connect', resolve); good.on('connect_error', reject); }),
        new Promise<void>(resolve => bad.on('connect_error', () => resolve())),
      ]);
      expect(good.connected).toBe(true);
    } finally { good.disconnect(); bad.disconnect(); }
  });
});
