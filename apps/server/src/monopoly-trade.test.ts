import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
const running: Awaited<ReturnType<typeof buildApp>>[] = [];
const fixtures: { instance: Awaited<ReturnType<typeof buildApp>>; roomId: string; matchId: string }[] = [];
afterEach(async () => {
  for (const { instance, roomId, matchId } of fixtures.splice(0)) {
    await instance.db.matchSnapshot.updateMany({ where: { id: matchId, status: 'active' }, data: { status: 'interrupted' } });
    await instance.db.roomSnapshot.update({ where: { id: roomId }, data: { status: 'closed' } });
  }
  for (const i of running.splice(0)) await i.app.close();
});
describe('Monopoly trade accept persistence', () => {
  it('offer then accept', async () => {
    const instance = await buildApp(loadConfig({ ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: process.env['ARCADE_TEST_DATABASE_URL'] }), { logger: false, scheduleTimers: false });
    running.push(instance);
    const players = await Promise.all([0, 1].map(i => instance.sessions.create({ id: 'dev:' + randomUUID().replaceAll('-', ''), name: 'T' + i, avatar: null })));
    const a = players[0]!;
    const room = await instance.rooms.create(a.player, { gameId: 'monopoly', name: 't', visibility: 'private', settings: { mode: 'classic', maxPlayers: 2, startMoney: 1500, turnSeconds: 60, auctionSeconds: 10, tradeSeconds: 120, evenBuild: true } }, randomUUID());
    const invite = await instance.rooms.invite(room.id, a.player.id);
    await instance.rooms.join(room.id, players[1]!.player, invite.code.split(':')[1]);
    for (const p of players) { const v = await instance.rooms.view(room.id, p.player.id); await instance.rooms.ready(room.id, p.player.id, true, v.version, randomUUID()); }
    const match = await instance.rooms.start(room.id, a.player.id, randomUUID());
    fixtures.push({ instance, roomId: room.id, matchId: match.matchId });
    const env = (_actorId: string, expectedVersion: number, action: unknown) => ({ protocol: 1 as const, roomId: room.id, matchId: match.matchId, requestId: randomUUID(), expectedVersion, action });
    // roll until someone is on turn in awaitEnd/awaitRoll with canTrade — offer requires turn seat
    let view = await instance.rooms.match(match.matchId, a.player.id);
    const st = () => view.state as { phase: string; turnPlayerId: string; flags: { canTrade: boolean }; trades: { byMe: { id: string }[]; toMe: { id: string }[] } };
    for (let i = 0; i < 60; i++) {
      const s = st();
      const actor = s.turnPlayerId;
      if (s.phase === 'awaitRoll') view = await instance.rooms.action(actor, env(actor, view.version, { type: 'roll' }));
      else if (s.phase === 'buy') view = await instance.rooms.action(actor, env(actor, view.version, { type: 'refuse' }));
      else if (s.phase === 'auction') { for (const p of players) { const pv = await instance.rooms.match(match.matchId, p.player.id); const ps = pv.state as { phase: string; flags: { canAuctionPass: boolean } }; if (ps.phase === 'auction' && ps.flags.canAuctionPass) { view = await instance.rooms.action(p.player.id, env(p.player.id, pv.version, { type: 'pass' })); break; } } }
      else if (s.phase === 'awaitEnd') {
        const pv = await instance.rooms.match(match.matchId, actor);
        const offer = await instance.rooms.action(actor, env(actor, pv.version, { type: 'offer', to: players.find(p => p.player.id !== actor)!.player.id, giveMoney: 10, giveProps: [], getMoney: 0, getProps: [] }));
        view = offer;
        const recip = players.find(p => p.player.id !== actor)!;
        const rv = await instance.rooms.match(match.matchId, recip.player.id);
        const rs = rv.state as { trades: { toMe: { id: string }[] } };
        const offerId = rs.trades.toMe[0]!.id;
        const accepted = await instance.rooms.action(recip.player.id, env(recip.player.id, rv.version, { type: 'accept', offerId }));
        expect(accepted.version).toBe(rv.version + 1);
        return;
      } else break;
      view = await instance.rooms.match(match.matchId, a.player.id);
    }
    throw new Error('never reached awaitEnd');
  }, 60000);
});
