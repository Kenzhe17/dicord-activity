import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
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

const settings = { ruleSet: 'classic', timed: false, traitor: false, hintSeconds: 60, guessSeconds: 180, dictionary: 'ru' };

async function setup(count = 4) {
  const instance = await buildApp(loadConfig({
    ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'],
    ARCADE_STAKES_ENABLED: 'false',
  }), { logger: false, scheduleTimers: false, economy: null });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Code ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'codenames', name: 'Codenames room', visibility: 'private', settings }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  const match = await instance.rooms.start(room.id, a.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
  return { ...instance, players, room, match, a };
}

const code = (view: MatchView) => view.state as CodenamesView;
function envelope(view: MatchView, action: unknown) {
  return { protocol: 1 as const, roomId: view.roomId, matchId: view.matchId, requestId: randomUUID(), expectedVersion: view.version, action };
}
async function act(instance: Awaited<ReturnType<typeof buildApp>>, playerId: string, matchId: string, action: unknown) {
  const view = await instance.rooms.match(matchId, playerId);
  return instance.rooms.action(playerId, envelope(view, action));
}

describe('Codenames platform integration', () => {
  it('runs draft, hidden-info views, hint/pick, finish and rematch', async () => {
    const ctx = await setup(4);
    const { players, room, match } = ctx;
    const [p1, p2, p3, p4] = players.map(p => p.player.id);
    expect(match.status).toBe('active');
    expect(match.gameId).toBe('codenames');
    expect(code(match).phase).toBe('draft');

    // Draft: every member picks a team and role through validated actions.
    await act(ctx, p1!, match.matchId, { type: 'choose', team: 'red', role: 'spymaster' });
    await act(ctx, p2!, match.matchId, { type: 'choose', team: 'red', role: 'operative' });
    await act(ctx, p3!, match.matchId, { type: 'choose', team: 'blue', role: 'spymaster' });
    await act(ctx, p4!, match.matchId, { type: 'choose', team: 'blue', role: 'operative' });

    // Non-host cannot start; host can once both teams have a spymaster.
    await expect(act(ctx, p2!, match.matchId, { type: 'start' })).rejects.toThrow('организатор');
    const started = await act(ctx, p1!, match.matchId, { type: 'start' });
    expect(started.status).toBe('active');
    expect(['hint', 'guess']).toContain(code(started).phase);

    // Information isolation: spymasters see the key, operatives never do.
    const spyView = await ctx.rooms.match(match.matchId, p1!);
    const opView = await ctx.rooms.match(match.matchId, p2!);
    const spy = code(spyView) as CodenamesView & { key?: string[] };
    const op = code(opView) as CodenamesView & { key?: string[] };
    expect(Array.isArray(spy.key) && spy.key.length).toBe(25);
    expect(op.key).toBeUndefined();
    expect(JSON.stringify(op)).not.toContain('"assassin"');
    expect(op.board.every(c => c.color === null || c.revealed)).toBe(true);

    // Operative cannot give a hint; wrong-team spymaster cannot either.
    await expect(act(ctx, p2!, match.matchId, { type: 'hint', word: 'абракадабра', count: 1 })).rejects.toThrow();

    // Current team spymaster hints; operative guesses; state persists per player.
    const current = code(spyView).currentTeam;
    const spymasterId = current === 'red' ? p1! : p3!;
    const operativeId = current === 'red' ? p2! : p4!;
    const hinted = await act(ctx, spymasterId, match.matchId, { type: 'hint', word: 'абракадабра', count: 1 });
    expect(code(hinted).phase).toBe('guess');
    const guessView = await ctx.rooms.match(match.matchId, operativeId);
    const target = code(guessView).board.find(c => !c.revealed)!;
    const picked = await act(ctx, operativeId, match.matchId, { type: 'pick', index: target.index });
    expect(picked.version).toBe(guessView.version + 1);
    const persisted = await ctx.rooms.match(match.matchId, spymasterId);
    expect(persisted.version).toBe(picked.version);
    expect(code(persisted).board[target.index]!.revealed).toBe(true);
    const snapshot = await ctx.db.matchSnapshot.findUniqueOrThrow({ where: { id: match.matchId } });
    expect(snapshot.version).toBe(picked.version);

    // Surrender finishes the match with the opposing team winning.
    const surrenderer = players.find(p => p.player.id !== spymasterId && p.player.id !== operativeId)!.player.id;
    const finished = await act(ctx, surrenderer, match.matchId, { type: 'surrender' });
    expect(finished.status).toBe('finished');
    expect(finished.result).not.toBeNull();
    expect(finished.result!.winners.length + finished.result!.losers.length).toBe(4);
    expect(await ctx.db.matchAction.count({ where: { matchId: match.matchId } })).toBe(finished.version);
    expect(await ctx.db.matchParticipant.count({ where: { matchId: match.matchId, outcome: { not: null } } })).toBe(4);
    const lobby = await ctx.rooms.view(room.id, p1!);
    expect(lobby.phase).toBe('waiting');

    // Rematch: ready up and the host starts a fresh draft.
    let version = lobby.version;
    for (const p of players) {
      version++;
      await ctx.rooms.ready(room.id, p.player.id, true, version - 1, randomUUID());
    }
    const rematch = await ctx.rooms.start(room.id, players[0]!.player.id, randomUUID());
    expect(rematch.matchId).not.toBe(match.matchId);
    expect(rematch.status).toBe('active');
    expect(code(rematch).phase).toBe('draft');
    await ctx.db.matchSnapshot.update({ where: { id: rematch.matchId }, data: { status: 'interrupted' } });
  });

  it('rejects a second spymaster and keeps spectator views clean', async () => {
    const ctx = await setup(4);
    const { players, match } = ctx;
    const [p1, p2, p3] = players.map(p => p.player.id);
    await act(ctx, p1!, match.matchId, { type: 'choose', team: 'red', role: 'spymaster' });
    await expect(act(ctx, p2!, match.matchId, { type: 'choose', team: 'red', role: 'spymaster' })).rejects.toThrow('Руководитель');
    await act(ctx, p2!, match.matchId, { type: 'choose', team: 'red', role: 'operative' });
    await act(ctx, p3!, match.matchId, { type: 'choose', team: 'spectator' });
    const spec = await ctx.rooms.match(match.matchId, p3!);
    expect(code(spec).me.team).toBe('spectator');
    expect(code(spec).me.role).toBe('spectator');
    expect('key' in code(spec)).toBe(false);
    expect('intel' in code(spec)).toBe(false);
  });
});
