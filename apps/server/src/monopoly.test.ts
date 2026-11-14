import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PlatformService } from './platform';
import type { MonopolyView } from '@rize/monopoly';
const running: Awaited<ReturnType<typeof buildApp>>[] = [];
const fixtures: { instance: Awaited<ReturnType<typeof buildApp>>; roomId: string; matchId: string }[] = [];
afterEach(async () => {
  for (const { instance, roomId, matchId } of fixtures.splice(0)) {
    await instance.db.matchSnapshot.updateMany({ where: { id: matchId, status: 'active' }, data: { status: 'interrupted' } });
    await instance.db.roomSnapshot.update({ where: { id: roomId }, data: { status: 'closed' } });
  }
  for (const instance of running.splice(0)) await instance.app.close();
});
async function setup(count = 2, settings: Record<string, unknown> = {}) {
  const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, scheduleTimers: false });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Mono ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'monopoly', name: 'Monopoly integration', visibility: 'private', settings: { mode: 'classic', maxPlayers: count, startMoney: 1500, turnSeconds: 30, auctionSeconds: 20, tradeSeconds: 120, evenBuild: true, ...settings } }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  const match = await instance.rooms.start(room.id, a.player.id, randomUUID());
  fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
  return { ...instance, players, room, match };
}
describe('Monopoly persistence and multiplayer', () => {
  it('starts a match, applies a roll and restores an identical checkpoint', async () => {
    const instance = await setup();
    let view = instance.match;
    const first = view.state as MonopolyView;
    expect(first.players).toHaveLength(2);
    expect(first.banks[0]!.balance).toBe(1500);
    const actorId = first.turnPlayerId;
    view = await instance.rooms.match(view.matchId, actorId);
    const rolled = await instance.rooms.action(actorId, { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: randomUUID(), expectedVersion: view.version, action: { type: 'roll' } });
    expect(rolled.version).toBe(view.version + 1);
    const after = rolled.state as MonopolyView;
    expect(after.dice).not.toBeNull();
    expect(after.players.find(p => p.id === actorId)!.position).not.toBe(0);
    // A fresh PlatformService must restore the same private view from the checkpoint.
    const restarted = new PlatformService(instance.db, instance.rooms.games);
    const recovered = await restarted.match(rolled.matchId, actorId);
    expect(recovered.state).toEqual(rolled.state);
    expect(recovered.version).toBe(rolled.version);
  });
  it('rejects stale versions and records actions idempotently', async () => {
    const instance = await setup();
    const actorId = (instance.match.state as MonopolyView).turnPlayerId;
    const view = await instance.rooms.match(instance.match.matchId, actorId);
    const requestId = randomUUID();
    const envelope = { protocol: 1 as const, roomId: view.roomId, matchId: view.matchId, requestId, expectedVersion: view.version, action: { type: 'roll' } };
    const first = await instance.rooms.action(actorId, envelope);
    const retry = await instance.rooms.action(actorId, envelope);
    expect(retry.version).toBe(first.version);
    await expect(instance.rooms.action(actorId, { ...envelope, requestId: randomUUID() })).rejects.toThrow('Устаревшая версия');
  });
  it('quick and custom settings start matches with applied values', async () => {
    const quick = await setup(2, { mode: 'quick' });
    expect((quick.match.state as MonopolyView).mode).toBe('quick');
    const custom = await setup(3, { mode: 'classic', maxPlayers: 6, startMoney: 2500, turnSeconds: 45, auctionSeconds: 30, tradeSeconds: 200, evenBuild: false });
    const view = custom.match.state as MonopolyView;
    expect(view.players).toHaveLength(3);
    expect(view.banks[0]!.balance).toBe(2500);
    expect(view.mode).toBe('classic');
  });
  it('teams mode requires exactly four players', async () => {
    await expect(setup(3, { mode: 'teams' })).rejects.toThrow();
    const instance = await setup(4, { mode: 'teams' });
    const view = instance.match.state as MonopolyView;
    expect(view.mode).toBe('teams');
    expect(view.banks).toHaveLength(2);
    expect(view.banks[0]!.members).toHaveLength(2);
  });
});
