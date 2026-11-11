import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DomainError, createRoomSchema, actionEnvelopeSchema, roomViewSchema } from '@rize/shared';
import type { Player, RoomView, RoomSummary, MatchView } from '@rize/shared';
import { RoomDirectory } from '@rize/platform-core';
import type { GameRegistry } from '@rize/platform-core';
import { MatchRuntime, restoreMatch } from '@rize/multiplayer';
import type { PrismaClient } from '@rize/database';
import { atomic, hash, json } from './persistence';
import type { Tx } from './persistence';

export class PlatformService {
  private readonly startedAt: number;
  private readonly recoveryId = randomUUID();
  constructor(readonly db: PrismaClient, readonly games: GameRegistry, private readonly now = Date.now) { this.startedAt = now(); }
  private async room(tx: Tx, id: string) {
    const row = await tx.roomSnapshot.findUnique({ where: { id } });
    if (!row || row.status === 'closed') throw new DomainError('NOT_FOUND', 'Комната не найдена');
    return { row, state: roomViewSchema.parse(row.state) };
  }
  private domain(state: RoomView) { return RoomDirectory.restore(this.games, randomUUID, [state]); }
  private async save(tx: Tx, room: RoomView) {
    await tx.roomSnapshot.update({ where: { id: room.id }, data: { state: json(room), version: room.version, lastActiveAt: new Date(this.now()) } });
    return room;
  }
  private async receipt(tx: Tx, actorId: string, requestId: string, payload: unknown): Promise<string | null> {
    const previous = await tx.requestReceipt.findUnique({ where: { actorId_requestId: { actorId, requestId } } });
    if (!previous) return null;
    if (previous.fingerprint !== hash(JSON.stringify(payload))) throw new DomainError('CONFLICT', 'requestId уже использован для другого запроса');
    return previous.resourceId;
  }
  private async remember(tx: Tx, actorId: string, requestId: string, payload: unknown, resourceId: string) {
    await tx.requestReceipt.create({ data: { actorId, requestId, fingerprint: hash(JSON.stringify(payload)), resourceId } });
  }
  async create(player: Player, raw: unknown, requestId: string): Promise<RoomView> {
    const input = createRoomSchema.parse(raw);
    this.games.parseSettings(input.gameId, input.settings);
    return atomic(this.db, async tx => {
      const previous = await this.receipt(tx, player.id, requestId, { op: 'create', input });
      if (previous) return this.domain((await this.room(tx, previous)).state).view(previous, player.id);
      if (await tx.roomMember.findFirst({ where: { playerId: player.id, leftAt: null } })) throw new DomainError('CONFLICT', 'Сначала покиньте текущую комнату');
      if (await tx.roomSnapshot.count({ where: { status: { not: 'closed' } } }) >= 1000) throw new DomainError('CONFLICT', 'Лимит комнат достигнут');
      const room = new RoomDirectory(this.games, randomUUID).create(player, input);
      await tx.roomSnapshot.create({ data: { id: room.id, state: json(room), version: 0, lastActiveAt: new Date(this.now()) } });
      await tx.roomMember.create({ data: { roomId: room.id, playerId: player.id, lastSeenAt: new Date(this.now()) } });
      await this.remember(tx, player.id, requestId, { op: 'create', input }, room.id);
      return room;
    });
  }
  async list(): Promise<RoomSummary[]> {
    const rows = await this.db.roomSnapshot.findMany({ where: { status: 'waiting' }, orderBy: { createdAt: 'desc' }, take: 1000 });
    const available = new Set(this.games.list().map(game => game.id));
    return rows.map(row => roomViewSchema.parse(row.state)).filter(r => r.visibility === 'public' && available.has(r.gameId)).map(r => ({ id: r.id, name: r.name, gameId: r.gameId, players: r.members.length, maxPlayers: r.maxPlayers }));
  }
  async view(id: string, actorId: string): Promise<RoomView> {
    const { row, state } = await this.room(this.db, id);
    const room = this.domain(state).view(id, actorId);
    const members = await this.db.roomMember.findMany({ where: { roomId: id, leftAt: null } });
    return { ...room, phase: row.status === 'playing' ? 'playing' : 'waiting', matchId: row.status === 'playing' ? row.activeMatchId : null,
      members: room.members.map(member => ({ ...member, connected: members.some(m => m.playerId === member.player.id && this.now() - m.lastSeenAt.getTime() < 45000) })) };
  }
  async activeRoom(actorId: string): Promise<RoomView | null> {
    const member = await this.db.roomMember.findFirst({ where: { playerId: actorId, leftAt: null, room: { status: { not: 'closed' } } } });
    return member ? this.view(member.roomId, actorId) : null;
  }
  async join(id: string, player: Player, inviteToken?: string): Promise<RoomView> {
    await atomic(this.db, async tx => {
      const { row, state } = await this.room(tx, id);
      if (state.members.some(m => m.player.id === player.id)) return;
      if (row.status !== 'waiting') throw new DomainError('CONFLICT', 'Матч уже начался');
      if (state.visibility === 'private' && (!inviteToken || !row.inviteHash || hash(inviteToken) !== row.inviteHash || !row.inviteExpiresAt || row.inviteExpiresAt.getTime() <= this.now())) throw new DomainError('FORBIDDEN', 'Нужно действующее приглашение');
      if (await tx.roomMember.findFirst({ where: { playerId: player.id, leftAt: null } })) throw new DomainError('CONFLICT', 'Сначала покиньте текущую комнату');
      const room = this.domain(state).join(id, player);
      await this.save(tx, room);
      await tx.roomMember.upsert({ where: { roomId_playerId: { roomId: id, playerId: player.id } }, create: { roomId: id, playerId: player.id }, update: { leftAt: null, lastSeenAt: new Date(this.now()) } });
    });
    return this.view(id, player.id);
  }
  async invite(id: string, actorId: string): Promise<{ code: string; expiresAt: number }> {
    return atomic(this.db, async tx => {
      const { state } = await this.room(tx, id);
      if (state.hostId !== actorId) throw new DomainError('FORBIDDEN', 'Приглашениями управляет хост');
      const token = randomBytes(24).toString('base64url');
      const expiresAt = this.now() + 86400000;
      await tx.roomSnapshot.update({ where: { id }, data: { inviteHash: hash(token), inviteExpiresAt: new Date(expiresAt) } });
      return { code: id + ':' + token, expiresAt };
    });
  }
  async ready(id: string, actorId: string, ready: boolean, version: number, requestId: string): Promise<RoomView> {
    await atomic(this.db, async tx => {
      const payload = { op: 'ready', id, ready, version };
      const { row, state } = await this.room(tx, id);
      this.domain(state).view(id, actorId);
      if (await this.receipt(tx, actorId, requestId, payload)) return;
      if (row.status !== 'waiting') throw new DomainError('CONFLICT', 'Матч уже идёт');
      await this.save(tx, this.domain(state).ready(id, actorId, ready, version));
      await this.remember(tx, actorId, requestId, payload, id);
    });
    return this.view(id, actorId);
  }
  async transferHost(id: string, actorId: string, targetId: string): Promise<RoomView> {
    await atomic(this.db, async tx => {
      const { state } = await this.room(tx, id);
      await this.save(tx, this.domain(state).transferHost(id, actorId, targetId));
    });
    return this.view(id, actorId);
  }
  async leave(id: string, actorId: string): Promise<void> {
    await atomic(this.db, async tx => {
      const row = await tx.roomSnapshot.findUnique({ where: { id } });
      const membership = await tx.roomMember.findUnique({ where: { roomId_playerId: { roomId: id, playerId: actorId } } });
      if (!row || !membership) throw new DomainError('FORBIDDEN', 'Вы не участник комнаты');
      if (membership.leftAt || row.status === 'closed') return;
      if (row.status === 'playing') {
        // Only a player who already forfeited may release the seat mid-match;
        // ordinary disconnects must not remove anyone from the game.
        const matchRow = row.activeMatchId ? await tx.matchSnapshot.findUnique({ where: { id: row.activeMatchId } }) : null;
        const checkpoint = matchRow?.state as { context?: { players?: string[] }; serialized?: string } | null;
        const seat = checkpoint?.context?.players?.indexOf(actorId) ?? -1;
        const forfeited = !!matchRow && seat >= 0 && typeof checkpoint?.serialized === 'string' &&
          ((this.games.getModule(matchRow.gameId).restore(checkpoint.serialized) as { forfeited?: number[] }).forfeited ?? []).includes(seat);
        if (!forfeited) throw new DomainError('CONFLICT', 'Сначала завершите матч; отключение не исключает из игры');
      }
      const state = roomViewSchema.parse(row.state);
      const next = this.domain(state).leave(id, actorId);
      await tx.roomMember.update({ where: { roomId_playerId: { roomId: id, playerId: actorId } }, data: { leftAt: new Date(this.now()) } });
      if (next) await this.save(tx, next);
      else await tx.roomSnapshot.update({ where: { id }, data: { status: 'closed', version: row.version + 1 } });
    });
  }
  async close(id: string, actorId: string): Promise<void> {
    await atomic(this.db, async tx => {
      const { row, state } = await this.room(tx, id);
      if (state.hostId !== actorId) throw new DomainError('FORBIDDEN', 'Только хост может закрыть комнату');
      if (row.status === 'playing') throw new DomainError('CONFLICT', 'Нельзя закрыть активный матч');
      await tx.roomSnapshot.update({ where: { id }, data: { status: 'closed', version: row.version + 1 } });
      await tx.roomMember.updateMany({ where: { roomId: id, leftAt: null }, data: { leftAt: new Date(this.now()) } });
    });
  }
  async touch(id: string, actorId: string): Promise<void> {
    await atomic(this.db, async tx => {
      const now = new Date(this.now());
      const changed = await tx.roomMember.updateMany({ where: { roomId: id, playerId: actorId, leftAt: null, room: { status: { not: 'closed' } } }, data: { lastSeenAt: now } });
      if (changed.count) await tx.roomSnapshot.update({ where: { id }, data: { lastActiveAt: now } });
    });
  }
  async cleanup(idleMs: number, hostGraceMs: number): Promise<void> {
    await atomic(this.db, async tx => {
      const rows = await tx.roomSnapshot.findMany({ where: { status: { in: ['waiting', 'playing'] } }, include: { members: { where: { leftAt: null } } } });
      for (const row of rows) {
        const retention = row.status === 'playing' ? Math.max(idleMs, 86400000) : idleMs;
        if (row.lastActiveAt.getTime() < this.now() - retention && row.members.every(m => m.lastSeenAt.getTime() < this.now() - retention)) {
          await tx.roomSnapshot.update({ where: { id: row.id }, data: { status: 'closed', version: row.version + 1 } });
          await tx.roomMember.updateMany({ where: { roomId: row.id, leftAt: null }, data: { leftAt: new Date(this.now()) } });
          await tx.recoveryEvent.create({ data: { id: randomUUID(), roomId: row.id, kind: 'idle_room_closed' } });
          if (row.status === 'playing' && row.activeMatchId) {
            await tx.matchSnapshot.updateMany({ where: { id: row.activeMatchId, status: 'active' }, data: { status: 'interrupted', finishedAt: new Date(this.now()) } });
            await tx.recoveryEvent.create({ data: { id: randomUUID(), roomId: row.id, matchId: row.activeMatchId, kind: 'abandoned_match_preserved' } });
          }
          continue;
        }
        if (row.status === 'playing') continue;
        const state = roomViewSchema.parse(row.state);
        const host = row.members.find(m => m.playerId === state.hostId);
        const successor = row.members.filter(m => this.now() - m.lastSeenAt.getTime() < 45000).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
        if (host && this.now() - host.lastSeenAt.getTime() > hostGraceMs && successor && successor.playerId !== host.playerId) {
          await this.save(tx, this.domain(state).transferHost(row.id, host.playerId, successor.playerId));
          await tx.recoveryEvent.create({ data: { id: randomUUID(), roomId: row.id, playerId: successor.playerId, kind: 'host_transferred' } });
        }
      }
    });
  }
  async start(id: string, actorId: string, requestId: string): Promise<MatchView> {
    const matchId = await atomic(this.db, async tx => {
      const prior = await this.receipt(tx, actorId, requestId, { op: 'start', id });
      if (prior) return prior;
      const { row, state } = await this.room(tx, id);
      if (row.status !== 'waiting') throw new DomainError('CONFLICT', 'Матч уже идёт');
      const room = this.domain(state).assertStartable(id, actorId);
      const module = this.games.getModule(room.gameId);
      const nextId = randomUUID();
      const seed = randomInt(0, 2147483647);
      const runtime = new MatchRuntime(module, room.settings, { players: room.members.map(m => m.player.id), seed, startedAt: this.now() }, id, nextId);
      await tx.matchSnapshot.create({ data: { id: nextId, roomId: id, gameId: room.gameId, stateVersion: module.stateVersion, version: 0, seed, state: json(runtime.snapshot()), status: 'active', participants: { create: room.members.map(m => ({ playerId: m.player.id })) } } });
      await tx.roomSnapshot.update({ where: { id }, data: { status: 'playing', activeMatchId: nextId, version: row.version + 1, state: json({ ...state, version: row.version + 1 }), lastActiveAt: new Date(this.now()) } });
      await this.remember(tx, actorId, requestId, { op: 'start', id }, nextId);
      return nextId;
    });
    return this.match(matchId, actorId);
  }
  async match(id: string, actorId: string): Promise<MatchView> {
    const row = await this.db.matchSnapshot.findUnique({ where: { id }, include: { participants: { where: { playerId: actorId } } } });
    if (!row || row.participants.length === 0) throw new DomainError('FORBIDDEN', 'Матч недоступен');
    const runtime = restoreMatch(this.games.getModule(row.gameId), row.state);
    return { matchId: id, roomId: row.roomId, gameId: row.gameId, status: row.status, createdAt: row.createdAt.toISOString(), ...runtime.view(actorId), result: runtime.result() };
  }
  async action(actorId: string, raw: unknown): Promise<MatchView> {
    const envelope = actionEnvelopeSchema.parse(raw);
    // Authenticate membership before touching clocks; a guessed match ID cannot advance it.
    const member = await this.db.matchParticipant.findUnique({ where: { matchId_playerId: { matchId: envelope.matchId, playerId: actorId } } });
    if (!member) throw new DomainError('FORBIDDEN', 'Игрок не участвует в матче');
    await this.tickMatch(envelope.matchId);
    await atomic(this.db, async tx => {
      const row = await tx.matchSnapshot.findUnique({ where: { id: envelope.matchId } });
      if (!row) throw new DomainError('NOT_FOUND', 'Матч не найден');
      if (row.status === 'interrupted') throw new DomainError('CONFLICT', 'Партия прервана после длительного отсутствия игроков');
      const module = this.games.getModule(row.gameId);
      const runtime = restoreMatch(module, row.state);
      runtime.dispatch(actorId, envelope, this.now());
      await this.persistMatch(tx, row, runtime);
    });
    return this.match(envelope.matchId, actorId);
  }
  async tickMatch(id: string): Promise<{ matchId: string; roomId: string } | null> {
    return atomic(this.db, async tx => {
      const row = await tx.matchSnapshot.findUnique({ where: { id } });
      if (!row || row.status !== 'active') return null;
      const module = this.games.getModule(row.gameId);
      if (!module.getSystemAction) return null;
      const runtime = restoreMatch(module, row.state), now = this.now();
      const recovering = row.createdAt.getTime() < this.startedAt && !await tx.matchAction.findUnique({ where: { matchId_requestId: { matchId: id, requestId: this.recoveryId } } });
      if (!recovering && now < this.startedAt + 30000 && row.createdAt.getTime() < this.startedAt) return null;
      const presence = await tx.roomMember.findFirst({ where: { roomId: row.roomId, leftAt: null, lastSeenAt: { gte: new Date(Math.max(this.startedAt, now - 45000)) } } });
      const action = runtime.nextSystemAction(now, !!presence, recovering);
      if (action === null) return null;
      runtime.dispatchSystem(recovering ? this.recoveryId : randomUUID(), action, now);
      const finished = await this.persistMatch(tx, row, runtime);
      await tx.recoveryEvent.create({ data: { id: randomUUID(), roomId: row.roomId, matchId: id, kind: recovering ? 'match_timer_recovered' : 'match_timer_event' } });
      return finished ? { matchId: id, roomId: row.roomId } : null;
    });
  }
  async tickTimers(): Promise<{ failures: { matchId: string; errorName: string }[]; finished: { matchId: string; roomId: string }[] }> {
    const timedGames = this.games.list().filter(g => g.status === 'ready' && this.games.getModule(g.id).getSystemAction).map(g => g.id);
    const matches = await this.db.matchSnapshot.findMany({ where: { status: 'active', gameId: { in: timedGames } }, select: { id: true } });
    const failures: { matchId: string; errorName: string }[] = [];
    const finished: { matchId: string; roomId: string }[] = [];
    for (const match of matches) {
      try { const done = await this.tickMatch(match.id); if (done) finished.push(done); }
      catch (error) {
        // One damaged checkpoint or clock anomaly must not stop every other table.
        // Never include checkpoint contents, credentials or raw error messages in logs.
        failures.push({ matchId: match.id, errorName: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
    return { failures, finished };
  }
  private async persistMatch(tx: Tx, row: { id: string; roomId: string; gameId: string; version: number; status: string }, runtime: MatchRuntime<unknown, unknown, unknown, unknown>): Promise<boolean> {
      const snapshot = runtime.snapshot();
      if (snapshot.version === row.version) return false;
      const record = snapshot.actions.at(-1);
      if (!record) throw new Error('Missing applied action');
      const result = runtime.result();
      await tx.matchAction.create({ data: { matchId: row.id, sequence: record.version, requestId: record.requestId, actorId: record.actorId, payload: json(record.system ? { system: true, action: record.action } : record.action), occurredAt: new Date(record.now) } });
      await tx.matchSnapshot.update({ where: { id: row.id }, data: { version: snapshot.version, state: json(snapshot), ...(result ? { status: 'finished', result: json(result), finishedAt: new Date(this.now()) } : {}) } });
      await tx.roomSnapshot.update({ where: { id: row.roomId }, data: { lastActiveAt: new Date(this.now()) } });
      if (result && row.status !== 'finished') {
        for (const playerId of snapshot.context.players) {
          const outcome = result.draw ? 'draw' : result.winners.includes(playerId) ? 'win' : 'loss';
          const delta = 0;
          await tx.matchParticipant.update({ where: { matchId_playerId: { matchId: row.id, playerId } }, data: { outcome, ratingDelta: delta } });
          await tx.playerStatistic.upsert({ where: { playerId_gameId: { playerId, gameId: row.gameId } },
            create: { playerId, gameId: row.gameId, played: 1, wins: outcome === 'win' ? 1 : 0, losses: outcome === 'loss' ? 1 : 0, draws: outcome === 'draw' ? 1 : 0, rating: 1000 + delta },
            update: { played: { increment: 1 }, wins: { increment: outcome === 'win' ? 1 : 0 }, losses: { increment: outcome === 'loss' ? 1 : 0 }, draws: { increment: outcome === 'draw' ? 1 : 0 } },
          });
        }
        const { state, row: roomRow } = await this.room(tx, row.roomId);
        await tx.roomSnapshot.update({ where: { id: row.roomId }, data: { status: 'waiting', activeMatchId: null, state: json({ ...state, version: roomRow.version + 1, members: state.members.map(m => ({ ...m, ready: false })) }), version: roomRow.version + 1 } });
      }
      return result !== null;
  }
  async profile(playerId: string) {
    const player = await this.db.player.findUnique({ where: { discordId: playerId }, include: { statistics: { where: { gameId: { in: this.games.list().map(g => g.id) } } } } });
    if (!player) throw new DomainError('NOT_FOUND', 'Профиль не найден');
    return { player: { id: player.discordId, name: player.name, username: player.username, avatar: player.avatar }, joinedAt: player.createdAt.toISOString(), statistics: player.statistics.map(({ gameId, played, wins, losses, draws, rating }) => ({ gameId, played, wins, losses, draws, rating })) };
  }
  async history(playerId: string) {
    const records = await this.db.matchParticipant.findMany({ where: { playerId, match: { status: 'finished', gameId: { in: this.games.list().map(g => g.id) } } }, include: { match: true }, orderBy: { match: { finishedAt: 'desc' } }, take: 50 });
    return records.map(({ outcome, ratingDelta, match }) => ({ id: match.id, gameId: match.gameId, finishedAt: match.finishedAt?.toISOString(), outcome, ratingDelta }));
  }
  async rankings(gameId: string) {
    this.games.get(gameId);
    const records = await this.db.playerStatistic.findMany({ where: { gameId }, include: { player: true }, orderBy: [{ wins: 'desc' }, { played: 'desc' }, { playerId: 'asc' }], take: 50 });
    return records.map(({ player, rating, wins, played }, index) => ({ place: index + 1, player: { id: player.discordId, name: player.name, avatar: player.avatar }, rating, wins, played }));
  }
}
