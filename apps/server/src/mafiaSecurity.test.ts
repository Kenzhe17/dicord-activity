import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, MatchView } from '@rize/shared';
import type { MafiaRole, MafiaState, MafiaView } from '@rize/mafia';
import { restoreMatch } from '@rize/multiplayer';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PlatformService } from './platform';
import { connectRoom } from '../../web/src/realtime';

type Instance = Awaited<ReturnType<typeof buildApp>>;
const running: Instance[] = [];
const fixtures: { instance: Instance; roomId: string; matchId: string }[] = [];
afterEach(async () => {
  for (const { instance, roomId, matchId } of fixtures.splice(0)) {
    if (matchId) await instance.db.matchSnapshot.updateMany({ where: { id: matchId, status: 'active' }, data: { status: 'interrupted' } });
    await instance.db.roomSnapshot.update({ where: { id: roomId }, data: { status: 'closed' } }).catch(() => {});
  }
  for (const instance of running.splice(0)) await instance.app.close().catch(() => {});
});

const view = (match: MatchView) => match.state as MafiaView;
const ROLES: MafiaRole[] = ['mafia', 'town', 'sheriff', 'doctor'];

/** Every string the engine is allowed to reveal as a "role" inside a view. */
function roleStrings(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) { for (const value of node) roleStrings(value, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'role' && typeof value === 'string') acc.push(value);
      else if (key === 'kind' && typeof value === 'string' && ROLES.includes(value as MafiaRole)) acc.push(value);
      else roleStrings(value, acc);
    }
  }
  return acc;
}

/**
 * Asserts that a MatchView is exactly the personal projection of the seat:
 * own role visible, other seats' roles hidden (mafia teammates excepted),
 * sheriff results private, and no server-only state field serialized.
 */
function expectPersonal(match: MatchView, ownRole: MafiaRole, roles: MafiaRole[], finished = false) {
  const state = view(match);
  const json = JSON.stringify(match);
  for (const key of ['"rng"', '"serialized"', '"nightKill"', '"sheriffCheck"', '"doctorHeal"',
    '"doctorHealTarget"', '"doctorHealNight"', '"chatAt"', '"deadThisCycle"', '"quietCycles"',
    '"context"', '"actions"', '"seed"', '"votes"', '"sheriffResults"', '"roles"']) {
    expect(json, `leaked server-only field ${key}`).not.toContain(key);
  }
  // `stats` is always serialized but must stay null until the finish reveal.
  if (!finished) expect(state.stats).toBeNull();
  expect(state.you.role.kind).toBe(ownRole);
  for (const seat of state.players) {
    const want = finished ? roles[seat.seat]! : ownRole === 'mafia' && roles[seat.seat] === 'mafia' ? 'mafia' : null;
    expect(seat.role, `seat ${seat.seat} role exposure`).toBe(want);
  }
  if (ownRole !== 'sheriff') {
    expect(state.you.sheriffResult).toBeNull();
    expect(json).not.toContain('"isMafia"');
  }
  if (!finished) {
    const allowed = new Set<string>([ownRole, ...(ownRole === 'mafia' ? ['mafia'] : [])]);
    for (const leaked of roleStrings(match)) expect(allowed.has(leaked), `role "${leaked}" leaked to ${ownRole}`).toBe(true);
  }
}

async function setupMafia(count = 6) {
  const instance = await buildApp(loadConfig({
    ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'],
    ARCADE_STAKES_ENABLED: 'false',
  }), { logger: false, scheduleTimers: false, economy: null });
  running.push(instance);
  // The ticking service must exist BEFORE the match snapshot is written,
  // otherwise every pre-existing match counts as "recovering".
  const clock = { now: Date.now() };
  const platform = new PlatformService(instance.db, instance.rooms.games, () => clock.now);
  const players = await Promise.all(Array.from({ length: count }, (_, i) =>
    instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Mafia ' + i, avatar: null })));
  const host = players[0]!;
  const room = await instance.rooms.create(host.player, { gameId: 'mafia', name: 'Security ' + randomUUID().slice(0, 8), visibility: 'public', settings: { pace: 'blitz' } }, randomUUID());
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player);
  for (const p of players) {
    const current = await instance.rooms.view(room.id, p.player.id);
    await instance.rooms.ready(room.id, p.player.id, true, current.version, randomUUID());
  }
  const match = await instance.rooms.start(room.id, host.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
  clock.now = Date.now();
  return { ...instance, players, room, match, platform, clock };
}
type Ctx = Awaited<ReturnType<typeof setupMafia>>;

/** Server-side truth: the persisted checkpoint legitimately contains roles. */
async function serverState(ctx: Ctx): Promise<MafiaState> {
  const row = await ctx.db.matchSnapshot.findUniqueOrThrow({ where: { id: ctx.match.matchId } });
  return JSON.parse((row.state as { serialized: string }).serialized) as MafiaState;
}
async function rolesOf(ctx: Ctx): Promise<MafiaRole[]> { return (await serverState(ctx)).roles; }
const pid = (ctx: Ctx, seat: number) => ctx.players[seat]!.player.id;

/** Advances exactly one phase through the real tick path (persisted system action). */
async function advancePhase(ctx: Ctx) {
  const current = await ctx.platform.match(ctx.match.matchId, pid(ctx, 0));
  const phaseBefore = view(current).phase;
  ctx.clock.now = view(current).deadline + 1;
  await ctx.platform.tickMatch(ctx.match.matchId);
  const next = await ctx.platform.match(ctx.match.matchId, pid(ctx, 0));
  expect(view(next).phase).not.toBe(phaseBefore);
  return next;
}

function envelope(ctx: Ctx, _actorId: string, expectedVersion: number, action: unknown) {
  return { protocol: 1 as const, roomId: ctx.room.id, matchId: ctx.match.matchId, requestId: randomUUID(), expectedVersion, action };
}
async function act(ctx: Ctx, seat: number, action: unknown) {
  const current = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
  return ctx.platform.action(pid(ctx, seat), envelope(ctx, pid(ctx, seat), current.version, action));
}
/** First living seat currently allowed to use the town channel. */
async function chatSeat(ctx: Ctx): Promise<number> {
  for (const seat of [...Array(ctx.players.length).keys()]) {
    const v = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
    if (view(v).you.abilities.canChatTown) return seat;
  }
  throw new Error('no seat can chat');
}

describe('mafia security: role secrecy through PlatformService and HTTP', () => {
  it('GET /api/matches/:id returns only personal views at every phase', async () => {
    const ctx = await setupMafia();
    const roles = await rolesOf(ctx);
    const checkAll = async () => {
      for (const seat of [...Array(6).keys()]) {
        const http = await ctx.app.inject({ method: 'GET', url: '/api/matches/' + ctx.match.matchId, headers: { authorization: 'Bearer ' + ctx.players[seat]!.token } });
        expect(http.statusCode).toBe(200);
        const body = http.json() as MatchView;
        expectPersonal(body, roles[seat]!, roles);
        expect(body).not.toHaveProperty('serialized');
        expect(body).not.toHaveProperty('actions');
        const direct = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
        expectPersonal(direct, roles[seat]!, roles);
        expect(direct.state).toEqual(body.state);
      }
    };
    // reveal -> night -> dawn -> discussion -> voting -> night, checked per phase.
    await checkAll();
    for (const target of ['night', 'dawn', 'discussion', 'voting', 'night']) {
      await advancePhase(ctx);
      expect(view(await ctx.platform.match(ctx.match.matchId, pid(ctx, 0))).phase).toBe(target);
      await checkAll();
    }
    // Exercise a real night action, then re-check secrecy on the mutated state.
    const mafiaSeat = roles.indexOf('mafia');
    const state = await serverState(ctx);
    const targetSeat = state.players.findIndex((_, i) => i !== mafiaSeat && state.roles[i] !== 'mafia' && state.alive[i]);
    await act(ctx, mafiaSeat, { type: 'nightKill', target: targetSeat });
    await checkAll();
    // Server-side checkpoint really does hold the hidden roles.
    const row = await ctx.db.matchSnapshot.findUniqueOrThrow({ where: { id: ctx.match.matchId } });
    const checkpoint = row.state as { serialized: string; actions: unknown[] };
    expect(checkpoint.serialized).toContain('"roles"');
    expect(checkpoint.serialized).toContain('"mafia"');
    expect(checkpoint.actions.length).toBe(row.version);
    // And the HTTP surface never contains the checkpoint payload.
    const anyBody = JSON.stringify((await ctx.app.inject({ method: 'GET', url: '/api/matches/' + ctx.match.matchId, headers: { authorization: 'Bearer ' + ctx.players[0]!.token } })).json());
    expect(anyBody).not.toContain('"serialized"');
    expect(anyBody).not.toContain('"context"');
  });

  it('reveals every role only after the match finishes', async () => {
    const ctx = await setupMafia();
    const roles = await rolesOf(ctx);
    // Forfeit everyone until the win condition ends the game.
    for (const seat of [...Array(6).keys()]) {
      const current = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      if (current.status === 'finished') break;
      await ctx.platform.action(pid(ctx, seat), envelope(ctx, pid(ctx, seat), current.version, { type: 'forfeit' })).catch(() => {});
    }
    const finished = await ctx.platform.match(ctx.match.matchId, pid(ctx, 0));
    expect(finished.status).toBe('finished');
    expect(finished.result).not.toBeNull();
    for (const seat of [...Array(6).keys()]) {
      const view = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      expectPersonal(view, roles[seat]!, roles, true);
      for (const other of (view.state as { players: { role: unknown; seat: number }[] }).players) expect(other.role).toBe(roles[other.seat]);
    }
  });
});

describe('mafia security: chat channel isolation', () => {
  it('scopes town, mafia and dead channels per viewer through the service layer', async () => {
    const ctx = await setupMafia();
    const roles = await rolesOf(ctx);
    const mafiaSeat = roles.indexOf('mafia');
    const townSeat = roles.indexOf('town');
    const deadSeat = roles.findIndex((r, i) => i !== mafiaSeat && i !== townSeat && r !== 'mafia');
    const all = [...Array(6).keys()];

    // Reveal is a day phase: town chat is public to all living seats.
    await act(ctx, townSeat, { type: 'chat', channel: 'town', text: 'всем привет' });
    for (const seat of all) {
      const v = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      expect(view(v).chat.town.map(m => m.text)).toContain('всем привет');
      expect(view(v).chat.mafia).toHaveLength(0);
      expect(view(v).chat.dead).toHaveLength(0);
    }

    // Night: mafia channel opens only for mafiosi.
    await advancePhase(ctx); // -> night
    await act(ctx, mafiaSeat, { type: 'chat', channel: 'mafia', text: 'убираем первый' });
    for (const seat of all) {
      const v = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      if (seat === mafiaSeat) expect(view(v).chat.mafia.map(m => m.text)).toContain('убираем первый');
      else expect(view(v).chat.mafia).toHaveLength(0);
    }
    // Town chat and non-mafia mafia-chat are rejected at night.
    await expect(act(ctx, townSeat, { type: 'chat', channel: 'town', text: 'ночью нельзя' })).rejects.toThrow();
    const nonMafia = all.find(s => s !== mafiaSeat)!;
    await expect(act(ctx, nonMafia, { type: 'chat', channel: 'mafia', text: 'я не мафия' })).rejects.toThrow();
    // Even the mafia cannot read mafia chat outside the night phase.
    await advancePhase(ctx); // -> dawn
    await advancePhase(ctx); // -> discussion
    const mafiaDay = await ctx.platform.match(ctx.match.matchId, pid(ctx, mafiaSeat));
    expect(view(mafiaDay).chat.mafia).toHaveLength(0);

    // Discussion: a living player forfeits, unlocking the dead channel for them only.
    ctx.clock.now += 1500; // chat cooldown is per-seat wall-clock ms
    await act(ctx, deadSeat, { type: 'forfeit' });
    const deadView = await ctx.platform.match(ctx.match.matchId, pid(ctx, deadSeat));
    expect(view(deadView).you.alive).toBe(false);
    ctx.clock.now += 1500;
    await act(ctx, deadSeat, { type: 'chat', channel: 'dead', text: 'я вылетел, удачи' });
    for (const seat of all) {
      const v = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      if (seat === deadSeat) {
        expect(view(v).chat.dead.map(m => m.text)).toContain('я вылетел, удачи');
        expect(view(v).chat.town).toHaveLength(0); // dead lose town history
      } else {
        expect(view(v).chat.dead).toHaveLength(0);
        expect(view(v).chat.town.map(m => m.text)).toContain('всем привет');
      }
    }
    // Dead channel rejects the living; town channel rejects the dead.
    const aliveSeat = all.find(s => s !== deadSeat)!;
    await expect(act(ctx, aliveSeat, { type: 'chat', channel: 'dead', text: 'живым нельзя' })).rejects.toThrow();
    await expect(act(ctx, deadSeat, { type: 'chat', channel: 'town', text: 'мертвым нельзя' })).rejects.toThrow();
    // A second forfeited player shares the dead channel with the first.
    const deadSeat2 = all.find(s => s !== deadSeat && s !== mafiaSeat && roles[s] !== 'mafia')!;
    await act(ctx, deadSeat2, { type: 'forfeit' });
    ctx.clock.now += 1500;
    await act(ctx, deadSeat2, { type: 'chat', channel: 'dead', text: 'и я' });
    const dead1 = await ctx.platform.match(ctx.match.matchId, pid(ctx, deadSeat));
    const dead2 = await ctx.platform.match(ctx.match.matchId, pid(ctx, deadSeat2));
    expect(view(dead1).chat.dead.map(m => m.text)).toContain('и я');
    expect(view(dead2).chat.dead.map(m => m.text)).toContain('я вылетел, удачи');
    const aliveCheck = await ctx.platform.match(ctx.match.matchId, pid(ctx, mafiaSeat));
    expect(view(aliveCheck).chat.dead).toHaveLength(0);
  });
});

describe('mafia security: reconnect and restart', () => {
  it('repeated fetches return identical personal views; mid-match leave is refused', async () => {
    const ctx = await setupMafia();
    const roles = await rolesOf(ctx);
    await advancePhase(ctx); // night
    const mafiaSeat = roles.indexOf('mafia');
    const state = await serverState(ctx);
    const targetSeat = state.players.findIndex((_, i) => i !== mafiaSeat && state.roles[i] !== 'mafia');
    await act(ctx, mafiaSeat, { type: 'nightKill', target: targetSeat });
    await advancePhase(ctx); // dawn
    await advancePhase(ctx); // discussion
    const talker = await chatSeat(ctx);
    await act(ctx, talker, { type: 'chat', channel: 'town', text: 'ping' });

    for (const seat of [...Array(6).keys()]) {
      // "Reconnect": the same bearer token re-reads session + match state.
      const session = await ctx.sessions.get(ctx.players[seat]!.token);
      expect(session.player.id).toBe(pid(ctx, seat));
      const first = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      const second = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      expect(second).toEqual(first);
      const http = await ctx.app.inject({ method: 'GET', url: '/api/matches/' + ctx.match.matchId, headers: { authorization: 'Bearer ' + ctx.players[seat]!.token } });
      expect(http.json()).toEqual(first);
      expectPersonal(first, roles[seat]!, roles);
      // Disconnecting is not forfeiting: leaving a live match is refused.
      await expect(ctx.rooms.leave(ctx.room.id, pid(ctx, seat))).rejects.toThrow('отключение');
    }
    // State keeps evolving for the reconnected client; own role stays put.
    ctx.clock.now += 1500;
    const talker2 = await chatSeat(ctx);
    const acted = await act(ctx, talker2, { type: 'chat', channel: 'town', text: 'pong' });
    expect(view(acted).you.role.kind).toBe(roles[talker2]);
    const refetched = await ctx.platform.match(ctx.match.matchId, pid(ctx, talker2));
    expect(refetched.state).toEqual(acted.state);
  });

  it('a full backend restart replays the journal into identical views and keeps playing', async () => {
    const ctx = await setupMafia();
    const roles = await rolesOf(ctx);
    await advancePhase(ctx); // night
    const mafiaSeat = roles.indexOf('mafia');
    const state = await serverState(ctx);
    const targetSeat = state.players.findIndex((_, i) => i !== mafiaSeat && state.roles[i] !== 'mafia');
    await act(ctx, mafiaSeat, { type: 'nightKill', target: targetSeat });
    await advancePhase(ctx); // dawn
    await advancePhase(ctx); // discussion
    ctx.clock.now += 1500;
    const talker = await chatSeat(ctx);
    await act(ctx, talker, { type: 'chat', channel: 'town', text: 'до рестарта' });
    await advancePhase(ctx); // voting
    const before = await Promise.all([...Array(6).keys()].map(s => ctx.platform.match(ctx.match.matchId, pid(ctx, s))));
    const actionsBefore = await ctx.db.matchAction.count({ where: { matchId: ctx.match.matchId } });

    // Real restart: close the app (sessions are DB-backed), rebuild on the same database.
    await ctx.app.close();
    const idx = running.findIndex(i => i.app === ctx.app);
    if (idx >= 0) running.splice(idx, 1);
    const config = loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'], ARCADE_STAKES_ENABLED: 'false' });
    const revived = await buildApp(config, { logger: false, scheduleTimers: false, economy: null });
    running.push(revived);
    fixtures.push({ instance: revived, roomId: ctx.room.id, matchId: ctx.match.matchId });
    const clock2 = { now: ctx.clock.now };
    const platform2 = new PlatformService(revived.db, revived.rooms.games, () => clock2.now);

    // Same tokens still authenticate; every player gets the identical personal view.
    for (const seat of [...Array(6).keys()]) {
      const http = await revived.app.inject({ method: 'GET', url: '/api/matches/' + ctx.match.matchId, headers: { authorization: 'Bearer ' + ctx.players[seat]!.token } });
      expect(http.statusCode).toBe(200);
      expect(http.json()).toEqual(before[seat]);
      expectPersonal(http.json() as MatchView, roles[seat]!, roles);
    }

    // Journal replay at the service layer reproduces the checkpoint exactly.
    const row = await revived.db.matchSnapshot.findUniqueOrThrow({ where: { id: ctx.match.matchId } });
    const module = revived.rooms.games.getModule('mafia');
    const replayed = restoreMatch(module, row.state);
    expect(replayed.snapshot()).toEqual(row.state);
    for (const seat of [...Array(6).keys()]) {
      const rv = replayed.view(pid(ctx, seat));
      expect(rv.state).toEqual(before[seat]!.state);
      expect(rv.version).toBe(before[seat]!.version);
    }

    // First tick on the new service is the deterministic one-time 'recover'.
    await platform2.tickMatch(ctx.match.matchId);
    const recovered = await platform2.match(ctx.match.matchId, pid(ctx, 0));
    expect(recovered.version).toBe(before[0]!.version + 1);
    expect(view(recovered).phase).toBe('voting');
    const lastAction = await revived.db.matchAction.findFirstOrThrow({ where: { matchId: ctx.match.matchId }, orderBy: { sequence: 'desc' } });
    expect(lastAction.payload).toMatchObject({ system: true, action: { type: 'recover' } });
    for (const seat of [...Array(6).keys()]) {
      const v = await platform2.match(ctx.match.matchId, pid(ctx, seat));
      expectPersonal(v, roles[seat]!, roles);
    }

    // The restarted match keeps accepting real player actions from a living seat.
    const voterSeat = before.findIndex(b => view(b).you.abilities.canVote);
    expect(voterSeat).toBeGreaterThanOrEqual(0);
    clock2.now += 1500;
    const voted = await platform2.action(pid(ctx, voterSeat), { protocol: 1, roomId: ctx.room.id, matchId: ctx.match.matchId, requestId: randomUUID(), expectedVersion: (await platform2.match(ctx.match.matchId, pid(ctx, voterSeat))).version, action: { type: 'vote', target: 'skip' } });
    expect(view(voted).you.vote).toBe('skip');
    expect(await revived.db.matchAction.count({ where: { matchId: ctx.match.matchId } })).toBe(actionsBefore + 2);
  });
});

describe('mafia security: concurrency and terminal state', () => {
  it('duplicate envelopes apply once; conflicting requestId, stale version and post-finish actions are rejected', async () => {
    const ctx = await setupMafia();
    const first = await ctx.platform.match(ctx.match.matchId, pid(ctx, 0));
    const dup = envelope(ctx, pid(ctx, 0), first.version, { type: 'chat', channel: 'town', text: 'один раз' });
    const results = await Promise.all([ctx.platform.action(pid(ctx, 0), dup), ctx.platform.action(pid(ctx, 0), dup)]);
    expect(results[0]!.version).toBe(results[1]!.version);
    expect(await ctx.db.matchAction.count({ where: { matchId: ctx.match.matchId, requestId: dup.requestId } })).toBe(1);

    // Same requestId, different payload -> conflict.
    await expect(ctx.platform.action(pid(ctx, 0), { ...dup, action: { type: 'chat', channel: 'town', text: 'другое' } })).rejects.toThrow('requestId');
    // Fresh requestId, stale version -> conflict.
    await expect(ctx.platform.action(pid(ctx, 0), { ...dup, requestId: randomUUID(), expectedVersion: first.version })).rejects.toThrow('Устаревшая');

    // Two different players racing the same version: exactly one applies.
    const raced = await Promise.allSettled([
      act(ctx, 1, { type: 'chat', channel: 'town', text: 'гонка A' }),
      act(ctx, 2, { type: 'chat', channel: 'town', text: 'гонка B' }),
    ]);
    const ok = raced.filter(r => r.status === 'fulfilled');
    const bad = raced.filter(r => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason.message).toMatch(/Устаревшая|requestId/);
    const applied = await ctx.db.matchAction.count({ where: { matchId: ctx.match.matchId } });
    expect(applied).toBe(results[0]!.version + 1); // dup replay + exactly one raced winner

    // Drive the match to a terminal state via forfeits, then reject further actions.
    for (const seat of [...Array(6).keys()]) {
      const current = await ctx.platform.match(ctx.match.matchId, pid(ctx, seat));
      if (current.status === 'finished') break;
      await ctx.platform.action(pid(ctx, seat), envelope(ctx, pid(ctx, seat), current.version, { type: 'forfeit' })).catch(() => {});
    }
    const finished = await ctx.platform.match(ctx.match.matchId, pid(ctx, 0));
    expect(finished.status).toBe('finished');
    const postFinish = await ctx.platform.match(ctx.match.matchId, pid(ctx, 0));
    await expect(ctx.platform.action(pid(ctx, 0), envelope(ctx, pid(ctx, 0), postFinish.version, { type: 'chat', channel: 'dead', text: 'после финала' }))).rejects.toThrow(/заверш|finished/i);
    const http = await ctx.app.inject({ method: 'POST', url: '/api/matches/' + ctx.match.matchId + '/actions', headers: { authorization: 'Bearer ' + ctx.players[0]!.token }, payload: envelope(ctx, pid(ctx, 0), postFinish.version, { type: 'forfeit' }) });
    expect(http.statusCode).toBe(409);
  });

  it('system advances are persisted as MatchAction rows and replay deterministically', async () => {
    const ctx = await setupMafia();
    await advancePhase(ctx); // reveal -> night
    await advancePhase(ctx); // night -> dawn
    await advancePhase(ctx); // dawn -> discussion
    const rows = await ctx.db.matchAction.findMany({ where: { matchId: ctx.match.matchId }, orderBy: { sequence: 'asc' } });
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.actorId === 'system')).toBe(true);
    for (const row of rows) expect(row.payload).toMatchObject({ system: true, action: { type: 'advance' } });
    // Replay of the stored checkpoint reproduces the live runtime exactly.
    const stored = await ctx.db.matchSnapshot.findUniqueOrThrow({ where: { id: ctx.match.matchId } });
    const replayed = restoreMatch(ctx.rooms.games.getModule('mafia'), stored.state);
    expect(replayed.snapshot()).toEqual(stored.state);
    for (const seat of [...Array(6).keys()]) {
      expect(replayed.view(pid(ctx, seat)).state).toEqual((await ctx.platform.match(ctx.match.matchId, pid(ctx, seat))).state);
    }
    // A second tick at the same instant is a no-op (deadline not yet reached again).
    const version = (await ctx.platform.match(ctx.match.matchId, pid(ctx, 0))).version;
    await ctx.platform.tickMatch(ctx.match.matchId);
    expect((await ctx.platform.match(ctx.match.matchId, pid(ctx, 0))).version).toBe(version);
  });
});

describe('mafia security: realtime payloads', () => {
  it('match:state socket events carry only each subscriber\'s personal view', async () => {
    const ctx = await setupMafia();
    const roles = await rolesOf(ctx);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    const config = loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] });
    const sockets = ctx.players.map(p => io('http://127.0.0.1:' + address.port, {
      autoConnect: false, auth: { token: p.token }, transports: ['websocket'],
      extraHeaders: { origin: config.ARCADE_ORIGIN }, reconnectionDelay: 50, reconnectionDelayMax: 100,
    }) as Socket<ServerToClientEvents, ClientToServerEvents>);
    const received: MatchView[][] = ctx.players.map(() => []);
    const statuses: string[] = [];
    const dispose = sockets.map((socket, i) => connectRoom(socket, ctx.room.id, {
      room: () => {}, match: value => { received[i]!.push(value); }, closed: () => {}, error: () => {},
      connection: value => { statuses[i] = value; },
    }));
    try {
      await expect.poll(() => statuses).toEqual(['Подключено', 'Подключено', 'Подключено', 'Подключено', 'Подключено', 'Подключено']);
      await expect.poll(() => received.every(list => list.length > 0)).toBe(true);
      const mafiaSeat = roles.indexOf('mafia');
      for (const seat of [...Array(6).keys()]) {
        for (const payload of received[seat]!) expectPersonal(payload, roles[seat]!, roles);
        expect(view(received[seat]!.at(-1)!).you.role.kind).toBe(roles[seat]);
      }
      // Advance to night; the 1s room sync republishes personal views to each socket.
      await advancePhase(ctx);
      await expect.poll(() => received.every(list => list.length > 0 && view(list.at(-1)!).phase === 'night'), { timeout: 8000 }).toBe(true);
      // Mafia sends a night chat; the 1s room sync republishes match:state to
      // every subscriber. (Socket 'match:action' uses the wall clock, which is
      // intentionally behind the fake timer clock used for phase advances, so
      // the action itself goes through the same PlatformService path.)
      const mafiaView = await ctx.platform.match(ctx.match.matchId, pid(ctx, mafiaSeat));
      await ctx.platform.action(pid(ctx, mafiaSeat), envelope(ctx, pid(ctx, mafiaSeat), mafiaView.version, { type: 'chat', channel: 'mafia', text: 'ws only mafia' }));
      await expect.poll(() => {
        const last = received[mafiaSeat]!.at(-1)!;
        return view(last).chat.mafia.some(m => m.text === 'ws only mafia');
      }, { timeout: 8000 }).toBe(true);
      // Give the sync loop a moment, then prove no other socket ever saw the mafia message.
      await new Promise(resolve => setTimeout(resolve, 1600));
      for (const seat of [...Array(6).keys()]) {
        if (seat === mafiaSeat) continue;
        for (const payload of received[seat]!) {
          expect(view(payload).chat.mafia).toHaveLength(0);
          expectPersonal(payload, roles[seat]!, roles);
        }
      }
    } finally {
      dispose.forEach(stop => stop());
      for (const socket of sockets) socket.disconnect();
    }
  }, 30000);
});
