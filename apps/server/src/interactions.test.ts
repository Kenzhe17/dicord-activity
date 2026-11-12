import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { AuthSession } from '@rize/discord';
import { loadConfig } from './config';
import { buildApp } from './app';
import { verifyDiscordSignature, interactionResponse } from './interactions';

const running: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(({ app }) => app.close())); vi.unstubAllGlobals(); });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
const sign = (body: string, timestamp = '1700000000') => ({
  'x-signature-ed25519': cryptoSign(null, Buffer.from(timestamp + body), privateKey).toString('hex'),
  'x-signature-timestamp': timestamp,
});

function discordConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock',
    ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'],
    ARCADE_DISCORD_PUBLIC_KEY: publicKeyHex,
    ARCADE_ANNOUNCE_CHANNEL_ID: '111111111111111111',
    ARCADE_ADMIN_USER_IDS: '123456789012345678',
    ARCADE_DISCORD_CLIENT_ID: '1566376251185168394',
    ARCADE_DISCORD_BOT_TOKEN: 'bot-token-test',
    ...extra,
  });
}
async function create(extra: Record<string, string> = {}) {
  const instance = await buildApp(discordConfig(extra), { logger: false });
  running.push(instance);
  return instance;
}
async function devLogin(app: Awaited<ReturnType<typeof buildApp>>['app'], name: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/dev', payload: { name } });
  return response.json<AuthSession>();
}

describe('Discord signature verification', () => {
  it('accepts a valid signature and rejects tampering', () => {
    const body = '{"type":1}';
    const headers = sign(body);
    expect(verifyDiscordSignature(publicKeyHex, headers['x-signature-timestamp'], body, headers['x-signature-ed25519'])).toBe(true);
    expect(verifyDiscordSignature(publicKeyHex, headers['x-signature-timestamp'], body + ' ', headers['x-signature-ed25519'])).toBe(false);
    expect(verifyDiscordSignature(publicKeyHex, '9999999999', body, headers['x-signature-ed25519'])).toBe(false);
    expect(verifyDiscordSignature('00'.repeat(32), headers['x-signature-timestamp'], body, headers['x-signature-ed25519'])).toBe(false);
  });
  it('maps ping and the launch button to Discord responses', () => {
    expect(interactionResponse({ type: 1, id: 'i', token: 't' } as never, null)).toEqual({ type: 1 });
    expect(interactionResponse({ type: 3, id: 'i', token: 't', data: { custom_id: 'arcade_launch' } } as never, null)).toEqual({ type: 12 });
    expect(interactionResponse({ type: 3, id: 'i', token: 't', data: { custom_id: 'other' } } as never, null)).toMatchObject({ type: 4 });
  });
});

describe('interactions endpoint', () => {
  const ping = JSON.stringify({ type: 1, id: 'i1', token: 'tok', application_id: '123' });
  const launch = JSON.stringify({ type: 3, id: 'i2', token: 'tok', guild_id: '1196165488565289012', data: { custom_id: 'arcade_launch' } });
  it('answers signed interactions and rejects forged ones', async () => {
    const { app } = await create();
    const okPing = await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json', ...sign(ping) }, payload: ping });
    expect(okPing.statusCode).toBe(200);
    expect(okPing.json()).toEqual({ type: 1 });
    const okLaunch = await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json', ...sign(launch) }, payload: launch });
    expect(okLaunch.json()).toEqual({ type: 12 });
    expect((await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json' }, payload: ping })).statusCode).toBe(401);
    const forged = await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json', ...sign(launch) }, payload: launch.replace('arcade_launch', 'arcade_launchX') });
    expect(forged.statusCode).toBe(401);
  });
  const newsCmd = (userId: string, perms?: string) => JSON.stringify({
    type: 2, id: 'i3', token: 'news-token', guild_id: '1196165488565289012', channel_id: '222222222222222222',
    member: { user: { id: userId }, permissions: perms },
    data: { name: 'news' },
  });
  it('answers /news for admins ephemerally and posts a separate channel message', async () => {
    const calls: { url: string; method?: string | undefined; body?: { embeds?: { title?: string }[]; components?: unknown[] } | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/messages?limit=')) return new Response('[]', { status: 200 });
      return new Response('{"id":"m"}', { status: 200 });
    }));
    const { app } = await create();
    const body = newsCmd('123456789012345678');
    const response = await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json', ...sign(body) }, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ type: 4 }); // ephemeral only — no public "used /news"
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/channels/222222222222222222/messages'));
    expect(post).toBeTruthy();
    expect((post!.body as { content?: string }).content).toBe('@everyone');
    const embeds = post!.body!.embeds as { title?: string; description?: string; image?: { url?: string }; footer?: { text?: string } }[];
    expect(embeds).toHaveLength(2);
    expect(embeds[0]!.image?.url).toContain('/.proxy/assets/news_durak.png');
    expect(embeds[1]!.title).toBe('r!z3 Arcade — Дурак');
    expect(embeds[1]!.description).toBe('На сервере доступна собственная Discord-активность Дурак.');
    expect(embeds[1]!.footer?.text).toBe('Новые игры уже в разработке.');
    expect(JSON.stringify(post!.body)).not.toContain('🃏');
    // ephemeral reply is patched with the outcome
    expect(calls.some(c => c.method === 'PATCH' && c.url.includes('/webhooks/') && c.url.includes('/messages/@original'))).toBe(true);
  });
  it('denies /news to non-admins; permission-bit admins pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const { app } = await create();
    const denied = newsCmd('999999999999999999');
    const deniedRes = await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json', ...sign(denied) }, payload: denied });
    expect(deniedRes.json()).toMatchObject({ type: 4 });
    const adminPerms = newsCmd('999999999999999999', '8');
    const allowed = await app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json', ...sign(adminPerms) }, payload: adminPerms });
    expect(allowed.json()).toMatchObject({ type: 4 });
  });
  it('fails closed when no public key is configured', async () => {
    const config = discordConfig();
    delete (config as Record<string, unknown>)['ARCADE_DISCORD_PUBLIC_KEY'];
    const instance = await buildApp(config, { logger: false });
    running.push(instance);
    const response = await instance.app.inject({ method: 'POST', url: '/api/discord/interactions', headers: { 'content-type': 'application/json' }, payload: ping });
    expect(response.statusCode).toBe(503);
  });
});

describe('admin announce', () => {
  const ADMIN_ID = '123456789012345678';
  async function adminSession(instance: Awaited<ReturnType<typeof buildApp>>, id = ADMIN_ID) {
    return instance.sessions.create({ id, name: 'Admin', avatar: null });
  }
  it('rejects anonymous and non-admin callers without touching Discord', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => { calls.push(String(input)); return new Response('[]'); }));
    const instance = await create();
    running.push(instance);
    const { app, sessions } = instance;
    const player = await devLogin(app, 'not-admin');
    expect((await app.inject({ method: 'POST', url: '/api/admin/announce', headers: { authorization: 'Bearer ' + player.token } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/announce' })).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    void sessions;
  });
  it('posts the announcement with the launch button for admins', async () => {
    const posts: { url: string; body: { embeds?: { title?: string }[]; components?: unknown[] } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (url.includes('/messages?limit=')) return new Response('[]', { status: 200 });
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('{"id":"msg1"}', { status: 200 });
    }));
    const instance = await create();
    running.push(instance);
    const { app } = instance;
    const session = await adminSession(instance);
    const response = await app.inject({ method: 'POST', url: '/api/admin/announce', headers: { authorization: 'Bearer ' + session.token } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ posted: true });
    expect(posts).toHaveLength(1);
    const embeds = posts[0]!.body.embeds as { title?: string; image?: { url?: string } }[];
    expect(embeds[0]!.image?.url).toContain('/.proxy/assets/news_durak.png');
    expect(embeds[1]!.title).toBe('r!z3 Arcade — Дурак');
    expect(JSON.stringify(posts[0]!.body)).not.toContain('🃏');
    expect(JSON.stringify(posts[0]!.body.components)).toContain('arcade_launch');
  });
  it('does not repost when the announcement already exists', async () => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.includes('/messages?limit=')) {
        return new Response(JSON.stringify([{ components: [{ components: [{ custom_id: 'arcade_launch' }] }] }]), { status: 200 });
      }
      if (init?.method === 'POST') posts.push(url);
      return new Response('{}', { status: 200 });
    }));
    const instance = await create();
    running.push(instance);
    const { app } = instance;
    const session = await adminSession(instance);
    const response = await app.inject({ method: 'POST', url: '/api/admin/announce', headers: { authorization: 'Bearer ' + session.token } });
    expect(response.json()).toEqual({ posted: false, reason: 'already_announced' });
    expect(posts).toHaveLength(0);
  });
});
