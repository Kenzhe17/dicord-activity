import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import type { StakesBridge } from './economy';

const running: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const instance of running.splice(0)) await instance.app.close(); });

function bridge(overrides: Partial<StakesBridge> = {}) {
  return {
    getBalance: async () => ({ balance: 1000, exists: true }),
    escrow: vi.fn(async () => ({ ok: true, replayed: false })),
    settle: vi.fn(async () => ({ ok: true })),
    refund: vi.fn(async () => true),
    ...overrides,
  } satisfies StakesBridge & { getBalance: () => Promise<{ balance: number; exists: boolean }> };
}

async function setup(stake: number, count = 2, econ: ReturnType<typeof bridge> | null = bridge()) {
  const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, scheduleTimers: false, economy: econ });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Stake ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'durak', name: 'Stakes', visibility: 'private', settings: { mode: 'throw-in', maxPlayers: count, stake } }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  return { ...instance, players, room, a };
}

describe('pooled durak stakes', () => {
  it('does not touch the bridge for free matches', async () => {
    const econ = bridge();
    const instance = await setup(0, 2, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    expect(match.stakes).toBeNull();
    expect(econ.escrow).not.toHaveBeenCalled();
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId } })).toBe(0);
  });
  it('reserves the full pool atomically at start and exposes stake info', async () => {
    const econ = bridge();
    const instance = await setup(100, 3, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    expect(econ.escrow).toHaveBeenCalledTimes(1);
    const [opId, stakes] = econ.escrow.mock.calls[0]! as unknown as [string, { userId: string; amount: number }[]];
    expect(opId).toContain(instance.room.id);
    expect(stakes).toHaveLength(3);
    expect(stakes.every(s => s.amount === 100)).toBe(true);
    expect(stakes.map(s => s.userId).sort()).toEqual(instance.players.map(p => p.player.id).sort());
    expect(match.stakes).toMatchObject({ perPlayer: 100, pool: 300, settlement: 'pending' });
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_hold', status: 'reserved' } })).toBe(3);
  });
  it('blocks paid matches when the bridge is unavailable or a wallet is short', async () => {
    const down = await setup(50, 2, null);
    await expect(down.rooms.start(down.room.id, down.a.player.id, randomUUID())).rejects.toMatchObject({ code: 'GAME_UNAVAILABLE' });
    const poor = bridge({ escrow: vi.fn(async () => ({ ok: false, userId: 'someone' })) });
    const instance = await setup(50, 2, poor);
    await expect(instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await instance.db.matchSnapshot.count({ where: { roomId: instance.room.id } })).toBe(0);
  });
  it('reuses one escrow for duplicate start requestIds', async () => {
    const econ = bridge();
    const instance = await setup(25, 2, econ);
    const requestId = randomUUID();
    const first = await instance.rooms.start(instance.room.id, instance.a.player.id, requestId);
    const second = await instance.rooms.start(instance.room.id, instance.a.player.id, requestId);
    expect(second.matchId).toBe(first.matchId);
    expect(econ.escrow).toHaveBeenCalledTimes(1);
  });
  it('settles the full pool to the winner after a surrender finish', async () => {
    const econ = bridge();
    const instance = await setup(100, 2, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    const b = instance.players[1]!;
    const view = await instance.rooms.match(match.matchId, b.player.id);
    const surrendered = await instance.rooms.action(b.player.id, { protocol: 1, roomId: instance.room.id, matchId: match.matchId, requestId: randomUUID(), expectedVersion: view.version, action: { type: 'surrender' } });
    expect(surrendered.status).toBe('finished');
    expect(econ.settle).toHaveBeenCalledTimes(1);
    const payouts = econ.settle.mock.calls[0]![1] as { userId: string; amount: number }[];
    expect(payouts).toEqual([{ userId: instance.a.player.id, amount: 200 }]);
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_hold', status: 'settled' } })).toBe(2);
    const after = await instance.rooms.match(match.matchId, instance.a.player.id);
    expect(after.stakes).toMatchObject({ settlement: 'settled' });
    expect(after.stakes?.payouts).toEqual([{ playerId: instance.a.player.id, amount: 200, status: 'settled' }]);
  });
  it('splits the pool deterministically by seat order and excludes losers', async () => {
    const econ = bridge();
    const instance = await setup(100, 4, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    await instance.db.matchSnapshot.update({ where: { id: match.matchId }, data: { status: 'finished', result: { winners: [instance.players[0]!.player.id, instance.players[2]!.player.id], losers: [instance.players[1]!.player.id, instance.players[3]!.player.id], draw: false } } });
    await instance.rooms.settleMatch(match.matchId);
    const payouts = econ.settle.mock.calls[0]![1] as { userId: string; amount: number }[];
    expect(payouts).toEqual([{ userId: instance.players[0]!.player.id, amount: 200 }, { userId: instance.players[2]!.player.id, amount: 200 }]);
    expect(payouts.reduce((n, p) => n + p.amount, 0)).toBe(400);
  });
  it('refunds everyone on interruption and draw, never paying out', async () => {
    const econ = bridge();
    const instance = await setup(50, 2, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    await instance.db.matchSnapshot.update({ where: { id: match.matchId }, data: { status: 'interrupted' } });
    await instance.rooms.settleMatch(match.matchId);
    expect(econ.refund).toHaveBeenCalledTimes(1);
    expect(econ.settle).not.toHaveBeenCalled();
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_hold', status: 'refunded' } })).toBe(2);
    const second = await setup(50, 2, econ);
    const drawMatch = await second.rooms.start(second.room.id, second.a.player.id, randomUUID());
    await second.db.matchSnapshot.update({ where: { id: drawMatch.matchId }, data: { status: 'finished', result: { winners: [], losers: [], draw: true } } });
    await second.rooms.settleMatch(drawMatch.matchId);
    expect(econ.refund).toHaveBeenCalledTimes(2);
    expect(econ.settle).not.toHaveBeenCalled();
  });
  it('keeps payouts pending while the bridge is down and settles on retry', async () => {
    let up = false;
    const econ = bridge({
      settle: vi.fn(async () => up ? { ok: true } : null),
      refund: vi.fn(async () => up ? true : null),
    });
    const instance = await setup(100, 2, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    await instance.db.matchSnapshot.update({ where: { id: match.matchId }, data: { status: 'finished', result: { winners: [instance.a.player.id], losers: [instance.players[1]!.player.id], draw: false } } });
    await instance.rooms.settleMatch(match.matchId);
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_hold', status: 'reserved' } })).toBe(2);
    up = true;
    await instance.rooms.settleMatch(match.matchId);
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, kind: 'stake_hold', status: 'settled' } })).toBe(2);
    const calls = econ.settle.mock.calls.length;
    await instance.rooms.settleMatch(match.matchId);
    expect(econ.settle.mock.calls.length).toBe(calls); // settled holds are not reprocessed
  });
});
