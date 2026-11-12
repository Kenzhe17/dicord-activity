import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { Server } from 'socket.io';
import { z, ZodError } from 'zod';
import { DomainError, createRoomSchema, actionEnvelopeSchema, isDiscordInviteUrl } from '@rize/shared';
import type { AuthSession } from '@rize/discord';
import type { ClientToServerEvents, ServerToClientEvents, Reply } from '@rize/shared';
import { createArcadeDatabase } from '@rize/database';
import type { PrismaClient } from '@rize/database';
import { DiscordOAuthProvider } from '@rize/discord/server';
import type { AuthProvider } from '@rize/discord';
import type { Config } from './config';
import { createGameRegistry } from './games';
import { PersistentSessions, requestSchema } from './persistence';
import { PlatformService } from './platform';
import { EconomyBridge } from './economy';
import type { BalanceInfo, StakesBridge } from './economy';
import { DiscordGuildVerifier } from './guild';
import type { GuildVerifier } from './guild';
import { interactionIsAdmin, interactionResponse, interactionSchema, NEWS_COMMAND_NAME, patchNewsReply, publishAnnouncementToChannel, verifyDiscordSignature } from './interactions';
import type { DiscordInteraction } from './interactions';

export async function buildApp(config: Config, options: { oauth?: AuthProvider; logger?: boolean; database?: PrismaClient; scheduleTimers?: boolean; economy?: ({ getBalance(id: string): Promise<BalanceInfo | null> } & Partial<StakesBridge>) | null; discordCdnBase?: string; guildVerifier?: GuildVerifier | null } = {}) {
  if (!options.database && !config.ARCADE_DATABASE_URL) throw new Error('ARCADE_DATABASE_URL is required; no implicit production or memory fallback');
  const db = options.database ?? createArcadeDatabase(config.ARCADE_DATABASE_URL ?? '');
  try { await db.$connect(); await db.player.count(); }
  catch (error) { await db.$disconnect(); throw error; }
  const app = Fastify({
    logger: options.logger === false ? false : { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie'], serializers: { req: req => ({ method: req.method, url: String(req.url).split('?')[0] ?? '/' }) } },
    bodyLimit: 16384, requestTimeout: 15000, rewriteUrl: req => (req.url ?? '/').replace(/^\/\.proxy(?=\/)/, ''),
  });
  const economy = options.economy !== undefined ? options.economy : EconomyBridge.fromConfig(config);
  const games = createGameRegistry(config.ARCADE_ENABLE_TEST_GAME && config.ARCADE_ENV !== 'production');
  const rooms = new PlatformService(db, games, Date.now, economy && typeof (economy as StakesBridge).escrow === 'function' ? economy as StakesBridge : null, config.ARCADE_STAKES_ENABLED);
  const sessions = new PersistentSessions(db);
  const oauth = options.oauth ?? (config.ARCADE_AUTH_MODE === 'discord' ? new DiscordOAuthProvider(config.ARCADE_DISCORD_CLIENT_ID ?? '', config.ARCADE_DISCORD_CLIENT_SECRET ?? '') : undefined);
  // Single-guild lockdown applies to Discord-authenticated sessions only;
  // mock/dev auth stays available for local development and tests.
  const guildId = config.ARCADE_ALLOWED_GUILD_ID;
  const guildRestricted = config.ARCADE_AUTH_MODE === 'discord' && !!guildId;
  const guildVerifier: GuildVerifier | null = options.guildVerifier !== undefined
    ? options.guildVerifier
    : guildRestricted && config.ARCADE_DISCORD_BOT_TOKEN && guildId
      ? new DiscordGuildVerifier(config.ARCADE_DISCORD_BOT_TOKEN, guildId, fetch, (reason, detail) => app.log.warn({ event: 'guild_verify_rejected', reason, ...detail }, 'Guild verification rejected'))
      : null;
  if (guildRestricted && !guildVerifier) app.log.error({ event: 'guild_verifier_missing' }, 'ARCADE_DISCORD_BOT_TOKEN is not configured; all Discord logins will be rejected');
  function guardSession(session: AuthSession): void {
    if (!guildRestricted) return;
    if (!guildId || session.guildId !== guildId || !session.instanceId) {
      throw new DomainError('GUILD_RESTRICTED', 'Arcade доступна только на официальном сервере r!z3');
    }
  }
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute', keyGenerator: async req => {
    // Discord/NAT users may share a proxy IP. Only verified identities get separate buckets.
    if (!req.url.startsWith('/api/auth/') && req.headers.authorization) {
      try { return 'player:' + (await sessions.get(tokenFrom(req.headers.authorization))).player.id; } catch { /* Invalid tokens share the IP bucket. */ }
    }
    return 'ip:' + req.ip;
  } });
  await app.register(helmet, { frameguard: false, contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'https://cdn.discordapp.com', 'https://*.discordapp.net', 'data:'],
      connectSrc: ["'self'", 'wss:'], frameAncestors: ['https://discord.com', 'https://*.discord.com', 'https://*.discordsays.com'],
    },
  } });
  // Discord signs interactions over the exact raw body — keep a copy before
  // the JSON parser consumes the stream (this route only).
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (String(req.url).split('?')[0] !== '/api/discord/interactions') return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    (req as typeof req & { rawBody?: string }).rawBody = raw.toString('utf8');
    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });
  const allowedOrigin = new URL(config.ARCADE_ORIGIN).origin;
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== allowedOrigin) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Origin запрещён' } });
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Некорректные параметры запроса' } });
    if (error instanceof DomainError) {
      const status = { INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, GUILD_RESTRICTED: 403, NOT_FOUND: 404, CONFLICT: 409, GAME_UNAVAILABLE: 409, RATE_LIMITED: 429 }[error.code];
      return reply.code(status).send({ error: { code: error.code, message: error.message } });
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) return reply.code(error.statusCode).send({ error: { code: error.statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_INPUT', message: 'Запрос отклонён' } });
    req.log.error({ requestId: req.id, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
  });
  function tokenFrom(authorization: string | undefined): string | undefined { return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined; }
  async function actor(authorization: string | undefined) { const session = await sessions.get(tokenFrom(authorization)); guardSession(session); return session.player; }
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    maxHttpBufferSize: 16384, cors: { origin: allowedOrigin },
    allowRequest: (req, done) => done(null, req.headers.origin === allowedOrigin),
  });
  const subscriptions = new Map<string, { roomId: string; token: string; fingerprint: string; lastTouch: number }>();
  const disconnectReasons = new Set(['server shutting down', 'server namespace disconnect', 'client namespace disconnect', 'transport close', 'transport error', 'ping timeout', 'parse error', 'forced close', 'forced server close']);
  async function publishRoom(roomId: string): Promise<void> {
    for (const [id, subscription] of subscriptions) {
      if (subscription.roomId !== roomId) continue;
      const socket = io.sockets.sockets.get(id);
      if (!socket) continue;
      try {
        const session = await sessions.get(subscription.token);
        const room = await rooms.view(roomId, session.player.id);
        const match = room.matchId ? await rooms.match(room.matchId, session.player.id).catch(() => null) : null;
        const fingerprint = JSON.stringify({ room, match });
        if (fingerprint !== subscription.fingerprint) {
          subscription.fingerprint = fingerprint;
          socket.emit('room:state', room);
          if (match) socket.emit('match:state', match);
        }
      } catch (error) {
        if (!(error instanceof DomainError)) { app.log.error('Room synchronization failed'); continue; }
        if (error.code === 'UNAUTHORIZED') socket.disconnect(true);
        else { socket.emit('room:closed', { roomId }); subscriptions.delete(id); }
      }
    }
  }
  // One-shot delivery of a just-finished match to current room subscribers.
  // Waiting rooms deliberately hide matchId, so results cannot be re-fetched by joiners.
  async function emitFinishedMatch(roomId: string, matchId: string): Promise<void> {
    for (const [id, subscription] of subscriptions) {
      if (subscription.roomId !== roomId) continue;
      const socket = io.sockets.sockets.get(id);
      if (!socket) continue;
      try {
        const session = await sessions.get(subscription.token);
        const match = await rooms.match(matchId, session.player.id).catch(() => null);
        if (match) socket.emit('match:state', match);
      } catch { /* Subscriber went away or lost authorization. */ }
    }
  }
  io.use((socket, next) => {
    void (async () => {
      try { const token = z.string().min(1).max(128).parse(socket.handshake.auth['token']); guardSession(await sessions.get(token)); next(); }
      catch { app.log.info({ event: 'realtime_auth_rejected' }, 'Realtime authentication rejected'); next(new Error('UNAUTHORIZED')); }
    })();
  });
  io.on('connection', socket => {
    app.log.info({ event: 'realtime_connected' }, 'Realtime transport connected');
    const token = socket.handshake.auth['token'] as string;
    let events = 0;
    const reset = setInterval(() => { events = 0; }, 10000);
    socket.on('disconnect', reason => {
      clearInterval(reset); subscriptions.delete(socket.id);
      app.log.info({ event: 'realtime_disconnected', reason: disconnectReasons.has(reason) ? reason : 'other' }, 'Realtime transport disconnected');
    });
    async function execute<T>(operation: () => Promise<T>, ack: (reply: Reply<T>) => void) {
      if (typeof ack !== 'function') return;
      try {
        if (++events > 40) throw new DomainError('RATE_LIMITED', 'Слишком много запросов');
        ack({ ok: true, data: await operation() });
      } catch (error) { ack({ ok: false, error: { code: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: error instanceof DomainError ? error.message : 'Запрос не выполнен' } }); }
    }
    socket.on('room:subscribe', (raw, ack) => {
      void execute(async () => {
        const player = (await sessions.get(token)).player;
        const { roomId } = z.object({ roomId: z.uuid() }).strict().parse(raw);
        await rooms.view(roomId, player.id);
        await rooms.touch(roomId, player.id);
        const room = await rooms.view(roomId, player.id);
        subscriptions.set(socket.id, { roomId, token, fingerprint: '', lastTouch: Date.now() });
        await sessions.recovery(player.id, 'socket_resubscribed', roomId, room.matchId ?? undefined);
        await publishRoom(roomId);
        app.log.info({ event: 'realtime_subscribed', hasMatch: !!room.matchId }, 'Realtime room synchronized');
        return room;
      }, ack);
    });
    socket.on('match:action', (raw, ack) => {
      void execute(async () => {
        const player = (await sessions.get(token)).player;
        const view = await rooms.action(player.id, raw);
        await publishRoom(view.roomId);
        if (view.status === 'finished') await emitFinishedMatch(view.roomId, view.matchId);
        return view;
      }, ack);
    });
  });
  let synchronizing = false;
  let synchronization: Promise<void> = Promise.resolve();
  let ticks = 0;
  const sync = setInterval(() => {
    if (synchronizing) return;
    synchronizing = true;
    synchronization = (async () => {
      for (const [id, sub] of subscriptions) {
        if (Date.now() - sub.lastTouch < 15000) continue;
        try { const session = await sessions.get(sub.token); await rooms.touch(sub.roomId, session.player.id); sub.lastTouch = Date.now(); }
        catch { io.sockets.sockets.get(id)?.disconnect(true); }
      }
      if (options.scheduleTimers !== false) {
        const { failures, finished } = await rooms.tickTimers();
        if (failures.length) app.log.error({ failures }, 'Some match timers could not advance');
        for (const done of finished) await emitFinishedMatch(done.roomId, done.matchId);
      }
      for (const roomId of new Set([...subscriptions.values()].map(s => s.roomId))) await publishRoom(roomId);
      if (++ticks % 30 === 0) await rooms.cleanup(config.ARCADE_ROOM_IDLE_MS, config.ARCADE_HOST_GRACE_MS);
    })().catch(() => app.log.error('Platform synchronization failed')).finally(() => { synchronizing = false; });
  }, 1000);
  sync.unref();
  const params = z.object({ id: z.uuid() });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try { await db.$queryRaw`SELECT 1`; return { status: 'ok', persistence: 'postgresql', databaseConnected: true }; }
    catch { return reply.code(503).send({ status: 'not_ready', persistence: 'postgresql', databaseConnected: false }); }
  });
  app.get('/api/config', async () => ({ authMode: config.ARCADE_AUTH_MODE, clientId: config.ARCADE_DISCORD_CLIENT_ID ?? null, persistence: 'postgresql', testGame: config.ARCADE_ENABLE_TEST_GAME, economy: !!economy, allowedGuildId: guildRestricted ? guildId : null, serverInviteUrl: isDiscordInviteUrl(config.ARCADE_SERVER_INVITE_URL) ? config.ARCADE_SERVER_INVITE_URL : null }));
  app.get('/api/economy/balance', async req => {
    const player = await actor(req.headers.authorization);
    if (!economy) return { enabled: false };
    const balance = await economy.getBalance(player.id);
    if (!balance) return { enabled: true, available: false };
    return { enabled: true, available: true, balance: balance.exists ? balance.balance : 0, walletExists: balance.exists };
  });
  app.get('/api/games', async () => games.list());
  // Discord Interactions endpoint for the Arcade application. Public route —
  // authenticity is proven by the Ed25519 signature, not a session.
  app.post('/api/discord/interactions', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const publicKey = config.ARCADE_DISCORD_PUBLIC_KEY;
    if (!publicKey) return reply.code(503).send({ error: { code: 'GAME_UNAVAILABLE', message: 'Interactions are not configured' } });
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody ?? '';
    if (typeof signature !== 'string' || typeof timestamp !== 'string' || !verifyDiscordSignature(publicKey, timestamp, rawBody, signature)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid interaction signature' } });
    }
    const interaction = interactionSchema.parse(req.body) as DiscordInteraction;
    // /news slash command — the caller gets only an ephemeral reply; the
    // announcement itself is posted as a regular bot message into the channel,
    // so no "used /news" line appears under the post.
    if (interaction.type === 2 && interaction.data?.name === NEWS_COMMAND_NAME) {
      if (!interactionIsAdmin(interaction, adminIds())) {
        return { type: 4, data: { content: 'Команда доступна только администраторам.', flags: 64 } };
      }
      const botToken = config.ARCADE_DISCORD_BOT_TOKEN;
      const appId = config.ARCADE_DISCORD_CLIENT_ID;
      if (!botToken || !appId || !interaction.channel_id) {
        return { type: 4, data: { content: 'Публикация не настроена на сервере.', flags: 64 } };
      }
      if (await announcementExists(interaction.channel_id, botToken)) {
        return { type: 4, data: { content: 'Объявление уже опубликовано в этом канале.', flags: 64 } };
      }
      // Acknowledge ephemerally first (Discord requires a response within 3s),
      // then post and update the ephemeral reply with the outcome.
      reply.send({ type: 4, data: { content: 'Публикую новость…', flags: 64 } });
      try {
        await publishAnnouncementToChannel(interaction.channel_id, botToken, newsBannerUrl);
        req.log.info({ event: 'news_published', channelId: interaction.channel_id }, 'announcement published via /news');
        await patchNewsReply(appId, interaction.token, 'Новость опубликована.');
      } catch (error) {
        req.log.warn({ event: 'news_publish_failed', err: error instanceof Error ? error.message : String(error) }, '/news announcement publish failed');
        await patchNewsReply(appId, interaction.token, 'Не удалось опубликовать объявление. Попробуйте позже.');
      }
      return reply;
    }
    return interactionResponse(interaction, guildId ?? null);
  });
  const adminIds = () => new Set((config.ARCADE_ADMIN_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
  // Public URL of the Durak news banner, served from the web bundle.
  const newsBannerUrl = config.ARCADE_ORIGIN.replace(/\/+$/, '') + '/.proxy/assets/news_durak.png';
  const announcementExists = async (channelId: string, botToken: string): Promise<boolean> => {
    try {
      const history = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=20`, {
        headers: { authorization: 'Bot ' + botToken }, signal: AbortSignal.timeout(8000),
      });
      if (!history.ok) return false;
      const messages: unknown = await history.json();
      return Array.isArray(messages) && messages.some(m => {
        const msg = m as { components?: { components?: { custom_id?: string }[] }[] };
        return msg.components?.some(row => row.components?.some(c => c.custom_id === 'arcade_launch'));
      });
    } catch { return false; }
  };
  app.post('/api/admin/announce', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const player = await actor(req.headers.authorization);
    if (!adminIds().has(player.id)) throw new DomainError('FORBIDDEN', 'Только для администраторов');
    const channelId = config.ARCADE_ANNOUNCE_CHANNEL_ID;
    const botToken = config.ARCADE_DISCORD_BOT_TOKEN;
    if (!channelId || !botToken) throw new DomainError('GAME_UNAVAILABLE', 'Канал объявлений не настроен');
    // Do not repost if the launch announcement is already present.
    if (await announcementExists(channelId, botToken)) return { posted: false, reason: 'already_announced' };
    try {
      await publishAnnouncementToChannel(channelId, botToken, newsBannerUrl);
    } catch {
      throw new DomainError('GAME_UNAVAILABLE', 'Discord отклонил публикацию объявления');
    }
    return { posted: true };
  });
  app.post('/api/auth/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => ({ state: await sessions.challenge() }));
  app.post('/api/auth/dev', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    if (config.ARCADE_AUTH_MODE !== 'mock' || config.ARCADE_ENV === 'production') throw new DomainError('FORBIDDEN', 'Локальная авторизация отключена');
    const { name, avatar } = z.object({ name: z.string().trim().min(1).max(40), avatar: z.string().url().max(512).optional() }).strict().parse(req.body);
    return sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name, username: name, avatar: avatar ?? null });
  });
  app.post('/api/auth/discord', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    if (config.ARCADE_AUTH_MODE !== 'discord' || !oauth) throw new DomainError('FORBIDDEN', 'Discord авторизация не настроена');
    const { code, state, instanceId, guildId: claimedGuildId } = z.object({
      code: z.string().min(1).max(2048), state: z.string().min(32).max(128),
      instanceId: z.string().min(1).max(200).optional(),
      guildId: z.string().max(40).optional(),
    }).strict().parse(req.body);
    await sessions.consumeChallenge(state);
    const verified = await oauth.authenticate(code);
    if (verified.player.id.startsWith('dev:')) throw new DomainError('UNAUTHORIZED', 'Недопустимая Discord identity');
    let binding: { guildId: string; instanceId: string } | undefined;
    if (guildRestricted) {
      // Client-supplied guildId is never trusted: the Activity instance is
      // re-verified against Discord's API with the application bot token.
      if (!guildVerifier || !instanceId) throw new DomainError('GUILD_RESTRICTED', 'Не удалось подтвердить сервер Activity');
      const confirmation = await guildVerifier.verify({ applicationId: config.ARCADE_DISCORD_CLIENT_ID ?? '', instanceId, userId: verified.player.id });
      if (!confirmation || confirmation.guildId !== guildId || (claimedGuildId !== undefined && claimedGuildId !== guildId)) {
        throw new DomainError('GUILD_RESTRICTED', 'Arcade доступна только на официальном сервере r!z3');
      }
      binding = { guildId: confirmation.guildId, instanceId: confirmation.instanceId };
    }
    const old = tokenFrom(req.headers.authorization);
    if (old) await sessions.revoke(old);
    return { ...await sessions.create(verified.player, binding), accessToken: verified.accessToken };
  });
  app.get('/api/me', async req => actor(req.headers.authorization));
  app.get('/api/bootstrap', async req => {
    const session = await sessions.get(tokenFrom(req.headers.authorization));
    guardSession(session);
    const room = await rooms.activeRoom(session.player.id);
    await sessions.recovery(session.player.id, 'session_resumed', room?.id, room?.matchId ?? undefined);
    return { session, room, match: room?.matchId ? await rooms.match(room.matchId, session.player.id).catch(() => null) : null, preferences: await sessions.preferences(session.player.id) };
  });
  app.delete('/api/session', async req => {
    const session = await sessions.get(tokenFrom(req.headers.authorization));
    await sessions.revoke(session.token);
    for (const socket of io.sockets.sockets.values()) if (socket.handshake.auth['token'] === session.token) socket.disconnect(true);
    return { ok: true };
  });
  app.get('/api/profile', async req => rooms.profile((await actor(req.headers.authorization)).id));
  app.get('/api/history', async req => rooms.history((await actor(req.headers.authorization)).id));
  app.get('/api/rankings/:gameId', async req => {
    await actor(req.headers.authorization);
    return rooms.rankings(z.object({ gameId: z.string() }).parse(req.params).gameId);
  });
  app.get('/api/preferences', async req => sessions.preferences((await actor(req.headers.authorization)).id));
  app.put('/api/preferences', async req => sessions.preferences((await actor(req.headers.authorization)).id, req.body));
  app.get('/api/rooms', async req => { await actor(req.headers.authorization); return rooms.list(); });
  app.post('/api/rooms', async req => {
    const body = createRoomSchema.extend({ requestId: z.uuid() }).parse(req.body);
    const { requestId, ...input } = body;
    return rooms.create(await actor(req.headers.authorization), input, requestId);
  });
  app.get('/api/rooms/:id', async req => rooms.view(params.parse(req.params).id, (await actor(req.headers.authorization)).id));
  app.post('/api/rooms/:id/join', async req => {
    const body = z.object({ inviteToken: z.string().max(128).optional() }).strict().parse(req.body ?? {});
    const room = await rooms.join(params.parse(req.params).id, await actor(req.headers.authorization), body.inviteToken);
    await publishRoom(room.id); return room;
  });
  app.post('/api/rooms/:id/invite', async req => rooms.invite(params.parse(req.params).id, (await actor(req.headers.authorization)).id));
  app.post('/api/rooms/:id/ready', async req => {
    const player = await actor(req.headers.authorization);
    const body = z.object({ ready: z.boolean(), expectedVersion: z.number().int().nonnegative(), requestId: z.uuid() }).strict().parse(req.body);
    const room = await rooms.ready(params.parse(req.params).id, player.id, body.ready, body.expectedVersion, body.requestId);
    await publishRoom(room.id); return room;
  });
  app.post('/api/rooms/:id/host', async req => {
    const player = await actor(req.headers.authorization);
    const body = z.object({ targetId: z.string() }).strict().parse(req.body);
    const room = await rooms.transferHost(params.parse(req.params).id, player.id, body.targetId);
    await publishRoom(room.id); return room;
  });
  app.delete('/api/rooms/:id/membership', async req => {
    const player = await actor(req.headers.authorization); const id = params.parse(req.params).id;
    await rooms.leave(id, player.id); await publishRoom(id); return { ok: true };
  });
  app.delete('/api/rooms/:id', async req => {
    const id = params.parse(req.params).id;
    await rooms.close(id, (await actor(req.headers.authorization)).id); await publishRoom(id); return { ok: true };
  });
  app.post('/api/rooms/:id/start', async req => {
    const player = await actor(req.headers.authorization); const { requestId } = requestSchema.parse(req.body);
    const match = await rooms.start(params.parse(req.params).id, player.id, requestId);
    await publishRoom(match.roomId); return match;
  });
  app.get('/api/matches/:id', async req => rooms.match(params.parse(req.params).id, (await actor(req.headers.authorization)).id));
  app.post('/api/matches/:id/actions', async req => {
    const player = await actor(req.headers.authorization); const envelope = actionEnvelopeSchema.parse(req.body);
    if (envelope.matchId !== params.parse(req.params).id) throw new DomainError('INVALID_INPUT', 'Неверный матч');
    const match = await rooms.action(player.id, envelope); await publishRoom(match.roomId);
    if (match.status === 'finished') await emitFinishedMatch(match.roomId, match.matchId);
    return match;
  });
  // Discord Activities route cross-origin requests through /.proxy; avatar URLs
  // rewritten by the client land here. Only whitelisted Discord CDN object paths
  // are fetched — the upstream host is fixed, so this is not an open proxy.
  const discordCdn = options.discordCdnBase ?? 'https://cdn.discordapp.com';
  const avatarObject = /^\/(?:avatars\/\d{5,25}\/[A-Za-z0-9]{1,128}\.(?:png|webp|jpe?g|gif)|embed\/avatars\/\d{1,3}\.(?:png|webp))$/;
  app.get('/discord-cdn/*', async (req, reply) => {
    const path = '/' + String((req.params as Record<string, unknown>)['*'] ?? '');
    if (!avatarObject.test(path)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    try {
      const upstream = await fetch(discordCdn + path, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
      const type = upstream.headers.get('content-type') ?? '';
      const length = Number(upstream.headers.get('content-length') ?? 0);
      if (!upstream.ok || !type.startsWith('image/') || length > 2_000_000) {
        await upstream.body?.cancel();
        return reply.code(502).send({ error: { code: 'UPSTREAM', message: 'Аватар временно недоступен' } });
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.byteLength > 2_000_000) return reply.code(502).send({ error: { code: 'UPSTREAM', message: 'Аватар временно недоступен' } });
      return reply.header('Cache-Control', 'public, max-age=86400').type(type).send(body);
    } catch {
      return reply.code(502).send({ error: { code: 'UPSTREAM', message: 'Аватар временно недоступен' } });
    }
  });
  if (config.ARCADE_SERVE_WEB) {
    await app.register(staticFiles, { root: fileURLToPath(new URL('../../web/dist', import.meta.url)), index: 'index.html' });
    const webIndex = readFileSync(fileURLToPath(new URL('../../web/dist/index.html', import.meta.url)));
    app.setNotFoundHandler((req, reply) => {
      if (['GET', 'HEAD'].includes(req.method) && !req.url.startsWith('/api/') && !req.url.startsWith('/socket.io')) {
        return reply.type('text/html; charset=utf-8').send(webIndex);
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  }
  app.addHook('preClose', async () => {
    clearInterval(sync); await synchronization;
    app.log.info({ event: 'realtime_shutdown', connections: io.sockets.sockets.size }, 'Closing realtime transports for restart');
    // io.close() closes the transport, allowing clients to reconnect. Sending a
    // namespace DISCONNECT first permanently disables their automatic reconnect.
    // Explicit disconnect(true) remains reserved for logout/authorization failure.
    await io.close();
  });
  app.addHook('onClose', async () => { await db.$disconnect(); });
  return { app, rooms, sessions, io, db };
}
