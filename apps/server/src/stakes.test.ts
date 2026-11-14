import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import type { StakesBridge } from './economy';

const running: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const instance of running.splice(0)) await instance.app.close(); });

type Bridge = StakesBridge & { getBalance: Mock; escrow: Mock; settle: Mock; refund: Mock; listReservedEscrows: Mock; claimPending: Mock };
function bridge(overrides: Partial<StakesBridge> = {}): Bridge {
  return {
    getBalance: vi.fn(async () => ({ ok: true, balance: 1000, exists: true, writesEnabled: true })),
    escrow: vi.fn(async () => ({ ok: true as const, replayed: false })),
    settle: vi.fn(async () => ({ ok: true as const })),
    refund: vi.fn(async () => ({ ok: true as const })),
    listReservedEscrows: vi.fn(async () => [] as { opId: string; createdAt: string }[]),
    claimPending: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as Bridge;
}

async function setup(stake: number, count = 2, econ: ReturnType<typeof bridge> | null = bridge(), env: Record<string, string> = {}) {
  const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'], ARCADE_STAKES_ENABLED: 'true', ...env }), { logger: false, scheduleTimers: false, economy: econ });
  running.push(instance);
  const players = await Promise.all(Array.from({ length: count }, (_, i) => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'Stake ' + i, avatar: null })));
  const a = players[0]!;
  const room = await instance.rooms.create(a.player, { gameId: 'durak', name: 'Stakes', visibility: 'private', settings: { mode: 'throw-in', maxPlayers: count, stake } }, randomUUID());
  const invite = await instance.rooms.invite(room.id, a.player.id);
  for (const player of players.slice(1)) await instance.rooms.join(room.id, player.player, invite.code.split(':')[1]);
  for (const p of players) { const view = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, view.version, randomUUID()); }
  return { ...instance, players, room, a, invite };
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
  it('keeps paid matches blocked while the stakes flag is off', async () => {
    const econ = bridge();
    const instance = await setup(100, 2, econ, { ARCADE_STAKES_ENABLED: 'false' });
    await expect(instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID())).rejects.toMatchObject({ code: 'GAME_UNAVAILABLE' });
    expect(econ.escrow).not.toHaveBeenCalled();
    expect(await instance.db.matchSnapshot.count({ where: { roomId: instance.room.id } })).toBe(0);
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
    const poor = bridge({ escrow: vi.fn(async () => ({ ok: false as const, reason: 'insufficient' as const, userId: 'someone' })) });
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
  it('aborts the match when the roster changes between escrow and commit', async () => {
    const ref: { instance?: Awaited<ReturnType<typeof setup>> } = {};
    const econ = bridge({
      escrow: vi.fn(async (opId: string, stakes: { userId: string; amount: number }[]) => {
        void opId; void stakes;
        // A player leaves the room while the bridge call is in flight: the
        // committed roster then differs from the escrowed one.
        const instance = ref.instance!;
        await instance.rooms.leave(instance.room.id, instance.players[2]!.player.id);
        return { ok: true as const, replayed: false };
      }),
    });
    const instance = await setup(50, 3, econ);
    ref.instance = instance;
    const requestId = randomUUID();
    await expect(instance.rooms.start(instance.room.id, instance.a.player.id, requestId)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await instance.db.matchSnapshot.count({ where: { roomId: instance.room.id } })).toBe(0);
    // The test database is shared across cases: scope to this attempt's op id.
    expect(await instance.db.economyOperation.count({ where: { kind: 'stake_hold', externalReference: { contains: requestId } } })).toBe(0);
    // The orphaned escrow is refunded by reconciliation, never silently kept.
    const opId = econ.escrow.mock.calls[0]![0] as string;
    const old = new Date(Date.now() - 300000).toISOString();
    econ.listReservedEscrows.mockResolvedValue([{ opId, createdAt: old }]);
    await instance.rooms.tickTimers();
    expect(econ.refund).toHaveBeenCalledWith(opId);
    const events = await instance.db.recoveryEvent.findMany({ where: { kind: 'stake_orphan_refunded', roomId: instance.room.id } });
    expect(events).toHaveLength(1);
  }, 30000); // escrow + commit + tickTimers sweep queue on the shared advisory lock
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
  it('keeps payouts pending on transient failures and settles on retry', async () => {
    let up = false;
    const econ = bridge({
      settle: vi.fn(async () => up ? { ok: true as const } : { ok: false as const, reason: 'unavailable' as const }),
      refund: vi.fn(async () => up ? { ok: true as const } : { ok: false as const, reason: 'unavailable' as const }),
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
  it('records definitive rejections instead of retrying forever', async () => {
    const econ = bridge({
      settle: vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const })),
    });
    const instance = await setup(100, 2, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    await instance.db.matchSnapshot.update({ where: { id: match.matchId }, data: { status: 'finished', result: { winners: [instance.a.player.id], losers: [instance.players[1]!.player.id], draw: false } } });
    await instance.rooms.settleMatch(match.matchId);
    expect(await instance.db.economyOperation.count({ where: { matchId: match.matchId, status: 'settlement_failed' } })).toBe(3); // 2 holds + 1 payout (winner takes pool)
    expect(await instance.db.recoveryEvent.count({ where: { matchId: match.matchId, kind: 'stake_settle_rejected' } })).toBe(1);
  });
  it('persists balance-cap overflow on payouts instead of hiding it', async () => {
    const econ = bridge({
      settle: vi.fn(async (_op: string, payouts: { userId: string; amount: number }[]) => ({
        ok: true as const,
        payouts: payouts.map(p => ({ userId: p.userId, credited: p.amount - 40, overflow: 40 })),
      })),
    });
    const instance = await setup(100, 2, econ);
    const match = await instance.rooms.start(instance.room.id, instance.a.player.id, randomUUID());
    await instance.db.matchSnapshot.update({ where: { id: match.matchId }, data: { status: 'finished', result: { winners: [instance.a.player.id], losers: [instance.players[1]!.player.id], draw: false } } });
    await instance.rooms.settleMatch(match.matchId);
    const payout = await instance.db.economyOperation.findFirst({ where: { matchId: match.matchId, kind: 'stake_payout' } });
    expect(payout?.externalReference).toContain('"overflow":40');
    expect(await instance.db.recoveryEvent.count({ where: { matchId: match.matchId, kind: 'stake_payout_overflow' } })).toBe(1);
    const view = await instance.rooms.match(match.matchId, instance.a.player.id);
    expect(view.stakes?.payouts[0]?.overflow).toBe(40);
    // The parked overflow is claimed from the bot on the next reconcile pass.
    await instance.rooms.tickTimers();
    expect(econ.claimPending).toHaveBeenCalledWith(expect.stringContaining(instance.room.id));
  }, 30000); // settle + reconcile sweep queue on the shared advisory lock
});
