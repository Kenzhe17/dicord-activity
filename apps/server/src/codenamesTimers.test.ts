import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PlatformService } from './platform';
import type { CodenamesView } from '@rize/codenames';
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

const settings = { ruleSet: 'unlimited', timed: true, traitor: false, hintSeconds: 10, guessSeconds: 15, dictionary: 'ru' };
const code = (view: MatchView) => view.state as CodenamesView;

async function setup() {
  const instance = await buildApp(loadConfig({
    ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'],
    ARCADE_STAKES_ENABLED: 'false',
  }), { logger: false, scheduleTimers: false, economy: null });
  running.push(instance);
  // Ticking service must exist BEFORE the match snapshot is written, otherwise
  // every pre-existing match counts as "recovering" after a restart.
  const clock = { now: Date.now() };
  const platform = new PlatformService(instance.db, instance.rooms.games, () => clock.now);
  const players = await Promise.all(Array.from({ length: 4 }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Timer ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'codenames', name: 'Timed room', visibility: 'private', settings }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  const match = await instance.rooms.start(room.id, a.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
  // Draft the teams so the match reaches the hint phase with a live deadline.
  for (const [i, p] of players.entries()) {
    const view = await instance.rooms.match(match.matchId, p.player.id);
    await instance.rooms.action(p.player.id, { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: randomUUID(), expectedVersion: view.version, action: { type: 'choose', team: i < 2 ? 'red' : 'blue', role: i % 2 === 0 ? 'spymaster' : 'operative' } });
  }
  const host = players[0]!;
  const draft = await instance.rooms.match(match.matchId, host.player.id);
  await instance.rooms.action(host.player.id, { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: randomUUID(), expectedVersion: draft.version, action: { type: 'start' } });
  // System events must be monotonic with player actions stamped by the real clock.
  clock.now = Date.now();
  return { ...instance, players, room, match, platform, clock };
}

async function goOnline(instance: Awaited<ReturnType<typeof buildApp>>, roomId: string, at: number) {
  await instance.db.roomMember.updateMany({ where: { roomId, leftAt: null }, data: { lastSeenAt: new Date(at) } });
}

describe('Codenames timers through PlatformService.tickMatch', () => {
  it('hint deadline expiry passes the turn and records timeout', async () => {
    const ctx = await setup();
    const started = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    expect(code(started).phase).toBe('hint');
    const teamBefore = code(started).currentTeam;
    const deadlineBefore = code(started).deadline!;
    expect(deadlineBefore).toBeGreaterThan(Date.now());

    await goOnline(ctx, ctx.room.id, ctx.clock.now);
    expect(await ctx.platform.tickMatch(ctx.match.matchId)).toBeNull(); // deadline not reached

    ctx.clock.now = deadlineBefore + 1;
    await goOnline(ctx, ctx.room.id, ctx.clock.now);
    await ctx.platform.tickMatch(ctx.match.matchId);
    const view = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    expect(code(view).phase).toBe('hint');
    expect(code(view).currentTeam).not.toBe(teamBefore);
    expect(code(view).lastEvent).toBe('timeout');
    expect(code(view).deadline).toBe(ctx.clock.now + settings.hintSeconds * 1000);
  });

  it('pauses when everyone is offline and resumes with the remaining time', async () => {
    const ctx = await setup();
    const started = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    const deadlineBefore = code(started).deadline!;
    // Everyone offline: lastSeenAt far in the past relative to the tick clock.
    await ctx.db.roomMember.updateMany({ where: { roomId: ctx.room.id, leftAt: null }, data: { lastSeenAt: new Date(ctx.clock.now - 120_000) } });
    await ctx.platform.tickMatch(ctx.match.matchId);
    const paused = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    expect(code(paused).paused).toBe(true);
    expect(code(paused).legalActions).toHaveLength(0);
    // While paused, even an expired deadline cannot fire: advance past it.
    ctx.clock.now = deadlineBefore + 60_000;
    await ctx.platform.tickMatch(ctx.match.matchId);
    const stillPaused = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    expect(code(stillPaused).paused).toBe(true);
    expect(code(stillPaused).phase).toBe('hint');
    // A player returns: resume restores deadline = now + remaining.
    await goOnline(ctx, ctx.room.id, ctx.clock.now);
    await ctx.platform.tickMatch(ctx.match.matchId);
    const resumed = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    expect(code(resumed).paused).toBe(false);
    expect(code(resumed).deadline!).toBeGreaterThan(ctx.clock.now);
    expect(code(resumed).deadline!).toBeGreaterThan(deadlineBefore);
  });

  it('recover after a restart extends the deadline without losing the turn', async () => {
    const ctx = await setup();
    const before = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    const deadlineBefore = code(before).deadline!;
    const versionBefore = before.version;
    // Simulate a server restart: a new PlatformService has a later startedAt,
    // so the pre-existing match snapshot counts as "recovering".
    ctx.clock.now = Date.now() + 2_000;
    const restarted = new PlatformService(ctx.db, ctx.rooms.games, () => ctx.clock.now);
    await goOnline(ctx, ctx.room.id, ctx.clock.now);
    await restarted.tickMatch(ctx.match.matchId);
    const after = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    expect(after.version).toBe(versionBefore + 1);
    expect(code(after).lastEvent).toBe('resume');
    expect(code(after).phase).toBe('hint');
    expect(code(after).deadline).toBe(ctx.clock.now + settings.hintSeconds * 1000);
    expect(code(after).deadline).toBeGreaterThan(deadlineBefore);
    // Recovery is recorded as a system action, not a player move.
    const actions = await ctx.db.matchAction.findMany({ where: { matchId: ctx.match.matchId }, orderBy: { sequence: 'desc' }, take: 1 });
    expect(actions[0]!.payload).toMatchObject({ system: true, action: { type: 'recover' } });
  });

  it('stale expectedVersion conflicts and identical requestId replays idempotently', async () => {
    const ctx = await setup();
    const view = await ctx.rooms.match(ctx.match.matchId, ctx.players[0]!.player.id);
    const team = code(view).currentTeam;
    const spy = team === 'red' ? ctx.players[0]!.player.id : ctx.players[2]!.player.id;
    const fresh = await ctx.rooms.match(ctx.match.matchId, spy);
    const envelope = { protocol: 1 as const, roomId: ctx.room.id, matchId: ctx.match.matchId, requestId: randomUUID(), expectedVersion: fresh.version, action: { type: 'hint' as const, word: 'абракадабра', count: 1 } };
    const first = await ctx.rooms.action(spy, envelope);
    expect(code(first).phase).toBe('guess');
    // Same requestId + same payload: returns the current view without re-applying.
    const replay = await ctx.rooms.action(spy, envelope);
    expect(replay.version).toBe(first.version);
    // Same requestId, different payload: conflict.
    await expect(ctx.rooms.action(spy, { ...envelope, action: { type: 'hint', word: 'другое', count: 1 } })).rejects.toThrow('requestId');
    // Stale version with a fresh requestId: conflict.
    await expect(ctx.rooms.action(spy, { ...envelope, requestId: randomUUID(), expectedVersion: fresh.version })).rejects.toThrow('Устаревшая');
  });
});
