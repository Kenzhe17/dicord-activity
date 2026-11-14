import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, createRoomSchema, actionEnvelopeSchema, roomViewSchema } from '@rize/shared';
import type { Player, RoomView, RoomSummary, MatchView } from '@rize/shared';
import { RoomDirectory } from '@rize/platform-core';
import type { GameRegistry } from '@rize/platform-core';
import { MatchRuntime, restoreMatch } from '@rize/multiplayer';
import type { PrismaClient } from '@rize/database';
import { atomic, hash, json } from './persistence';
import type { Tx } from './persistence';

import type { StakesBridge } from './economy';
import { TRANSIENT_FAILURES } from './economy';
interface StakeRef { op: string; stake: number; overflow?: number }
const stakeRef = (raw: string | null): StakeRef | null => { try { const v = JSON.parse(raw ?? '') as StakeRef; return typeof v?.op === 'string' && Number.isInteger(v?.stake) ? v : null; } catch { return null; } };

export class PlatformService {
  private readonly startedAt: number;
  private readonly recoveryId = randomUUID();
  private lastStakeReconcile = 0;
  constructor(readonly db: PrismaClient, readonly games: GameRegistry, private readonly now = Date.now, private readonly economy: StakesBridge | null = null, private readonly stakesEnabled = false) { this.startedAt = now(); }
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
    // activeMatchId intentionally survives the finish: participants reload into
    // the recorded result (and rematch flow) instead of losing the match.
    // It is only exposed to match participants — a late joiner must not receive
    // a matchId whose match they are forbidden to read (that would wedge the
    // client's subscribe/sync handshake waiting for a match:state that never
    // arrives).
    const matchId = row.activeMatchId && await this.db.matchParticipant.findUnique({ where: { matchId_playerId: { matchId: row.activeMatchId, playerId: actorId } }, select: { matchId: true } }) ? row.activeMatchId : null;
    return { ...room, phase: row.status === 'playing' ? 'playing' : 'waiting', matchId,
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
  /** Stake context for a room: per-player amount and participant ids, or null
   * for free matches. Read outside the start transaction; revalidated inside. */
  private async stakeContext(id: string): Promise<{ amount: number; players: string[] } | null> {
    const { state } = await this.room(this.db, id);
    const settings = this.games.parseSettings(state.gameId, state.settings) as { stake?: number };
    const amount = settings.stake ?? 0;
    return amount > 0 ? { amount, players: state.members.map(m => m.player.id) } : null;
  }
  async start(id: string, actorId: string, requestId: string): Promise<MatchView> {
    const stake = await this.stakeContext(id);
    let escrowOpId: string | null = null;
    if (stake) {
      // Paid matches require the explicit activation flag AND a reachable
      // bridge; free matches (stake = 0) never touch either.
      if (!this.stakesEnabled || !this.economy) throw new DomainError('GAME_UNAVAILABLE', 'Ставки временно недоступны — матч не начат');
      // Cheap pre-check so obviously invalid starts never reserve coins.
      const { state: preState } = await this.room(this.db, id);
      this.domain(preState).assertStartable(id, actorId);
      const prior = await this.db.requestReceipt.findUnique({ where: { actorId_requestId: { actorId, requestId } } });
      if (!prior) {
        // Deterministic per requestId AND participant set: HTTP retries of the
        // same start replay one escrow, a changed roster gets a fresh op id,
        // and every rematch (new requestId) reserves a fresh pool.
        escrowOpId = 'arcade-stake:' + id + ':' + requestId + ':' + hash(JSON.stringify(stake)).slice(0, 24);
        const escrow = await this.economy.escrow(escrowOpId, stake.players.map(playerId => ({ userId: playerId, amount: stake.amount })));
        if (!escrow.ok) {
          if (escrow.reason === 'insufficient') throw new DomainError('CONFLICT', 'Недостаточно монет у одного из игроков');
          if (escrow.reason === 'unauthorized') throw new DomainError('GAME_UNAVAILABLE', 'Ошибка авторизации economy-моста — матч не начат');
          if (escrow.reason === 'bad_request' || escrow.reason === 'not_found' || escrow.reason === 'conflict') throw new DomainError('CONFLICT', 'Не удалось зарезервировать ставку — матч не начат');
          throw new DomainError('GAME_UNAVAILABLE', 'Банк временно недоступен — матч не начат');
        }
      }
    }
    const outcome = await atomic(this.db, async tx => {
      const prior = await this.receipt(tx, actorId, requestId, { op: 'start', id });
      if (prior) return { id: prior, created: false };
      const { row, state } = await this.room(tx, id);
      if (row.status !== 'waiting') throw new DomainError('CONFLICT', 'Матч уже идёт');
      const room = this.domain(state).assertStartable(id, actorId);
      if (escrowOpId && stake) {
        // The escrowed roster must be exactly the roster this match commits:
        // atomic() serializes all platform writes, so members cannot change
        // inside this transaction — only between escrow and commit.
        const committed = room.members.map(m => m.player.id);
        if (committed.length !== stake.players.length || committed.some((p, i) => p !== stake.players[i]))
          throw new DomainError('CONFLICT', 'Состав игроков изменился — запустите матч повторно');
      }
      const module = this.games.getModule(room.gameId);
      const nextId = randomUUID();
      const seed = randomInt(0, 2147483647);
      const runtime = new MatchRuntime(module, room.settings, { players: room.members.map(m => m.player.id), seed, startedAt: this.now(), hostId: room.hostId }, id, nextId);
      await tx.matchSnapshot.create({ data: { id: nextId, roomId: id, gameId: room.gameId, stateVersion: module.stateVersion, version: 0, seed, state: json(runtime.snapshot()), status: 'active', participants: { create: room.members.map(m => ({ playerId: m.player.id })) } } });
      if (escrowOpId) for (const member of room.members) {
        await tx.economyOperation.create({ data: { id: randomUUID(), idempotencyKey: 'hold:' + hash(escrowOpId + ':' + member.player.id), playerId: member.player.id, matchId: nextId, kind: 'stake_hold', status: 'reserved', externalReference: JSON.stringify({ op: escrowOpId, stake: stake!.amount }) } });
      }
      await tx.roomSnapshot.update({ where: { id }, data: { status: 'playing', activeMatchId: nextId, version: row.version + 1, state: json({ ...state, version: row.version + 1 }), lastActiveAt: new Date(this.now()) } });
      await this.remember(tx, actorId, requestId, { op: 'start', id }, nextId);
      return { id: nextId, created: true };
    });
    // A prior receipt means the existing match already owns this escrow op —
    // refunding it here would steal an active match's stake. Escrows orphaned
    // by a failed commit are refunded by the reconciliation scan in tickTimers.
    return this.match(outcome.id, actorId);
  }
  async match(id: string, actorId: string): Promise<MatchView> {
    const row = await this.db.matchSnapshot.findUnique({ where: { id }, include: { participants: { where: { playerId: actorId } } } });
    if (!row || row.participants.length === 0) throw new DomainError('FORBIDDEN', 'Матч недоступен');
    const runtime = restoreMatch(this.games.getModule(row.gameId), row.state);
    const ops = await this.db.economyOperation.findMany({ where: { matchId: id, kind: { in: ['stake_hold', 'stake_payout'] } } });
    const holds = ops.filter(o => o.kind === 'stake_hold');
    const ref = holds[0] ? stakeRef(holds[0].externalReference) : null;
    const stakes = ref ? {
      perPlayer: ref.stake, pool: ref.stake * holds.length,
      settlement: holds[0]!.status === 'reserved' ? 'pending' : holds[0]!.status,
      payouts: ops.filter(o => o.kind === 'stake_payout').map(o => { const r = stakeRef(o.externalReference); return { playerId: o.playerId, amount: r?.stake ?? 0, status: o.status, ...(r?.overflow ? { overflow: r.overflow } : {}) }; }),
    } : null;
    return { matchId: id, roomId: row.roomId, gameId: row.gameId, status: row.status, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString(), ...runtime.view(actorId), result: runtime.result(), stakes };
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
    const view = await this.match(envelope.matchId, actorId);
    if (view.status === 'finished') await this.settleMatch(view.matchId);
    return view;
  }
  /** Deterministic data errors (bad checkpoint, illegal replay, schema drift)
   * can never self-heal; after a streak the match is interrupted instead of
   * erroring every second forever. Infrastructure errors never quarantine. */
  private static readonly QUARANTINE_STREAK = 10;
  private static readonly TICK_KINDS = ['match_timer_failed', 'match_timer_event', 'match_timer_recovered', 'match_quarantined'];
  private async noteTickOutcome(id: string, failed: boolean): Promise<number> {
    if (failed) {
      await this.db.recoveryEvent.create({ data: { id: randomUUID(), matchId: id, kind: 'match_timer_failed' } });
      const recent = await this.db.recoveryEvent.findMany({ where: { matchId: id, kind: { in: PlatformService.TICK_KINDS } }, orderBy: { occurredAt: 'desc' }, take: PlatformService.QUARANTINE_STREAK, select: { kind: true } });
      let streak = 0;
      for (const event of recent) { if (event.kind !== 'match_timer_failed') break; streak++; }
      return streak;
    }
    const last = await this.db.recoveryEvent.findFirst({ where: { matchId: id, kind: { in: PlatformService.TICK_KINDS } }, orderBy: { occurredAt: 'desc' }, select: { kind: true } });
    if (last?.kind === 'match_timer_failed') await this.db.recoveryEvent.create({ data: { id: randomUUID(), matchId: id, kind: 'match_timer_recovered' } });
    return 0;
  }
  /** Terminal state for a checkpoint that can never be restored: the match is
   * marked interrupted (state and history preserved, no result awarded) and a
   * still-playing room returns to waiting so it is not wedged forever. */
  private async quarantineMatch(id: string): Promise<{ matchId: string; roomId: string } | null> {
    return atomic(this.db, async tx => {
      const row = await tx.matchSnapshot.findUnique({ where: { id } });
      if (!row || row.status !== 'active') return null;
      await tx.matchSnapshot.update({ where: { id }, data: { status: 'interrupted', finishedAt: new Date(this.now()) } });
      const roomRow = await tx.roomSnapshot.findUnique({ where: { id: row.roomId } });
      if (roomRow && roomRow.status === 'playing' && roomRow.activeMatchId === id) {
        const { state } = await this.room(tx, row.roomId);
        // The checkpoint is unrestorable, so there is no result to reload:
        // detach it from the room instead of leaving a matchId clients cannot fetch.
        await tx.roomSnapshot.update({ where: { id: row.roomId }, data: { status: 'waiting', activeMatchId: null, state: json({ ...state, version: roomRow.version + 1, members: state.members.map(m => ({ ...m, ready: false })) }), version: roomRow.version + 1 } });
      }
      await tx.recoveryEvent.create({ data: { id: randomUUID(), roomId: row.roomId, matchId: id, kind: 'match_quarantined' } });
      return { matchId: id, roomId: row.roomId };
    });
  }
  async tickMatch(id: string): Promise<{ matchId: string; roomId: string } | null> {
    try {
      const done = await this.tickMatchAttempt(id);
      await this.noteTickOutcome(id, false);
      return done;
    } catch (error) {
      if (error instanceof DomainError || error instanceof z.ZodError) {
        const streak = await this.noteTickOutcome(id, true);
        if (streak >= PlatformService.QUARANTINE_STREAK) {
          const quarantined = await this.quarantineMatch(id);
          if (quarantined) return quarantined;
        }
      }
      throw error;
    }
  }
  private async tickMatchAttempt(id: string): Promise<{ matchId: string; roomId: string } | null> {
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
      try { const done = await this.tickMatch(match.id); if (done) { await this.settleMatch(done.matchId); finished.push(done); } }
      catch (error) {
        // One damaged checkpoint or clock anomaly must not stop every other table.
        // Never include checkpoint contents, credentials or raw error messages in logs.
        failures.push({ matchId: match.id, errorName: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
    // Crash recovery: reserved escrows whose matches reached a terminal state
    // are (re)settled here — bridge operations are idempotent.
    const pending = await this.db.economyOperation.findMany({ where: { kind: 'stake_hold', status: 'reserved' }, select: { matchId: true }, distinct: ['matchId'] });
    for (const entry of pending) await this.settleMatch(entry.matchId).catch(() => null);
    await this.reconcileEconomy();
    return { failures, finished };
  }
  /** Throttled economy reconciliation: orphan refunds + pending-credit claims. */
  private async reconcileEconomy(): Promise<void> {
    if (!this.economy || this.now() - this.lastStakeReconcile < 60000) return;
    this.lastStakeReconcile = this.now();
    await this.reconcileOrphanEscrows();
    await this.reconcilePendingCredits();
  }
  /** Escrows reserved on the bot but never committed to a match (process died
   * between the bridge call and the DB transaction) are refunded here. The
   * bot's escrow created_at must be older than the grace window so an
   * in-flight start is never refunded mid-commit. */
  private async reconcileOrphanEscrows(): Promise<void> {
    const bridge = this.economy;
    if (!bridge?.listReservedEscrows) return;
    const escrows = await bridge.listReservedEscrows().catch(() => null);
    if (!escrows) return;
    const cutoff = this.now() - 120000;
    for (const escrow of escrows) {
      if (!escrow.opId.startsWith('arcade-stake:') || new Date(escrow.createdAt).getTime() > cutoff) continue;
      const known = await this.db.economyOperation.findFirst({ where: { kind: 'stake_hold', externalReference: { contains: escrow.opId } }, select: { id: true } });
      if (known) continue;
      const refunded = await bridge.refund(escrow.opId);
      if (refunded.ok) {
        const roomId = escrow.opId.split(':')[1];
        await this.db.recoveryEvent.create({ data: { id: randomUUID(), roomId: roomId && /^[0-9a-f-]{36}$/i.test(roomId) ? roomId : null, kind: 'stake_orphan_refunded' } });
      }
    }
  }
  /** Overflow winnings parked as pending credits on the bot are claimed once
   * per reconciliation pass; whatever still exceeds the cap stays queued
   * bot-side until a later claim fits. */
  private async reconcilePendingCredits(): Promise<void> {
    const bridge = this.economy;
    if (!bridge?.claimPending) return;
    const overflowed = await this.db.economyOperation.findMany({
      where: { kind: 'stake_payout', status: 'settled', externalReference: { contains: '"overflow":' } },
      select: { externalReference: true },
    });
    const ops = new Set<string>();
    for (const row of overflowed) { const ref = stakeRef(row.externalReference); if (ref?.overflow) ops.add(ref.op); }
    for (const op of ops) await bridge.claimPending(op).catch(() => null);
  }
  /** Settle or refund a finished/interrupted match's pooled stake. Safe to call
   * repeatedly: bot-side escrow ops are idempotent and payout rows use
   * deterministic idempotency keys. Bridge outages leave rows pending for the
   * next tick; definitive rejections are recorded, never silently dropped. */
  async settleMatch(matchId: string): Promise<void> {
    if (!this.economy) return;
    const holds = await this.db.economyOperation.findMany({ where: { matchId, kind: 'stake_hold', status: 'reserved' } });
    if (!holds.length) return;
    const ref = stakeRef(holds[0]!.externalReference);
    if (!ref) { await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_hold' }, data: { status: 'settlement_failed' } }); return; }
    const match = await this.db.matchSnapshot.findUnique({ where: { id: matchId } });
    if (!match || (match.status !== 'finished' && match.status !== 'interrupted')) return;
    const players = holds.map(h => h.playerId); // creation order = seat order
    const pool = ref.stake * players.length;
    const result = match.status === 'finished' ? match.result as { winners: readonly string[]; losers: readonly string[]; draw: boolean } | null : null;
    const eligible = result && !result.draw ? players.filter(p => result.winners.includes(p)) : [];
    if (!result || result.draw || !eligible.length) {
      // Draw, interruption, or no eligible winners: documented void policy is
      // a full refund of every reservation, including surrendered players.
      const refunded = await this.economy.refund(ref.op);
      if (refunded.ok) await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_hold', status: 'reserved' }, data: { status: 'refunded' } });
      else if (!TRANSIENT_FAILURES.includes(refunded.reason)) {
        await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_hold', status: 'reserved' }, data: { status: 'settlement_failed' } });
        await this.db.recoveryEvent.create({ data: { id: randomUUID(), matchId, kind: 'stake_refund_rejected' } });
      }
      return;
    }
    const share = Math.floor(pool / eligible.length), remainder = pool % eligible.length;
    const payouts = eligible.map((playerId, index) => ({ userId: playerId, amount: share + (index < remainder ? 1 : 0) }));
    await atomic(this.db, async tx => {
      for (const payout of payouts) {
        await tx.economyOperation.upsert({
          where: { idempotencyKey: 'payout:' + matchId + ':' + payout.userId },
          create: { id: randomUUID(), idempotencyKey: 'payout:' + matchId + ':' + payout.userId, playerId: payout.userId, matchId, kind: 'stake_payout', status: 'pending', externalReference: JSON.stringify({ op: ref.op, stake: payout.amount }) },
          update: {},
        });
      }
    });
    const settled = await this.economy.settle(ref.op, payouts);
    if (settled.ok) {
      // Record any balance-cap overflow durably: the bot clamps credits at
      // MAX_BALANCE and reports the remainder — it is never silently lost.
      const overflowed = (settled.payouts ?? []).filter(p => p.overflow > 0);
      if (overflowed.length) await atomic(this.db, async tx => {
        for (const payout of overflowed) {
          const amount = payouts.find(p => p.userId === payout.userId)?.amount ?? 0;
          await tx.economyOperation.update({ where: { idempotencyKey: 'payout:' + matchId + ':' + payout.userId }, data: { externalReference: JSON.stringify({ op: ref.op, stake: amount, overflow: payout.overflow }) } });
        }
        await tx.recoveryEvent.create({ data: { id: randomUUID(), matchId, kind: 'stake_payout_overflow' } });
      });
      await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_payout', status: 'pending' }, data: { status: 'settled' } });
      await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_hold', status: 'reserved' }, data: { status: 'settled' } });
      await this.db.recoveryEvent.create({ data: { id: randomUUID(), matchId, kind: 'stake_settled' } });
    } else if (!TRANSIENT_FAILURES.includes(settled.reason)) {
      await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_payout', status: 'pending' }, data: { status: 'settlement_failed' } });
      await this.db.economyOperation.updateMany({ where: { matchId, kind: 'stake_hold', status: 'reserved' }, data: { status: 'settlement_failed' } });
      await this.db.recoveryEvent.create({ data: { id: randomUUID(), matchId, kind: 'stake_settle_rejected' } });
    }
    // Transient failures → rows stay pending for the next tick.
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
        await tx.roomSnapshot.update({ where: { id: row.roomId }, data: { status: 'waiting', state: json({ ...state, version: roomRow.version + 1, members: state.members.map(m => ({ ...m, ready: false })) }), version: roomRow.version + 1 } });
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
