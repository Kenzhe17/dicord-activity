import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, playerSchema, preferencesSchema } from '@rize/shared';
import type { Player } from '@rize/shared';
import type { AuthSession } from '@rize/discord';
import type { PrismaClient, Prisma } from '@rize/database';
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export type Tx = Prisma.TransactionClient;
/** Cross-process serialization is DB-owned, not a process-local mutex.
 * Stage 2 serializes short platform writes; replace with ordered per-aggregate locks for scale. */
export function atomic<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(78039124)::text`;
    return fn(tx);
  }, { maxWait: 15000, timeout: 15000 });
}
export class PersistentSessions {
  constructor(private readonly db: PrismaClient, private readonly now = Date.now, private readonly ttl = 86400000) {}
  async create(player: Player): Promise<AuthSession> {
    const verified = playerSchema.parse(player);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttl;
    await this.db.$transaction(async tx => {
      await tx.player.upsert({ where: { discordId: verified.id }, create: { discordId: verified.id, name: verified.name, username: verified.username ?? verified.name, avatar: verified.avatar }, update: { name: verified.name, username: verified.username ?? verified.name, avatar: verified.avatar } });
      await tx.authSession.create({ data: { tokenHash: hash(token), playerId: verified.id, expiresAt: new Date(expiresAt) } });
    });
    return { token, expiresAt, player: verified };
  }
  async get(token: string | undefined): Promise<AuthSession> {
    if (!token || token.length > 128) throw new DomainError('UNAUTHORIZED', 'Необходима авторизация');
    const session = await this.db.authSession.findUnique({ where: { tokenHash: hash(token) }, include: { player: true } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= this.now()) throw new DomainError('UNAUTHORIZED', 'Сессия истекла. Войдите снова');
    return { token, expiresAt: session.expiresAt.getTime(), player: { id: session.playerId, name: session.player.name, username: session.player.username, avatar: session.player.avatar } };
  }
  async revoke(token: string): Promise<void> {
    await this.db.authSession.updateMany({ where: { tokenHash: hash(token), revokedAt: null }, data: { revokedAt: new Date(this.now()) } });
  }
  async challenge(): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.db.authChallenge.create({ data: { hash: hash(state), expiresAt: new Date(this.now() + 120000) } });
    return state;
  }
  async consumeChallenge(state: string): Promise<void> {
    const result = await this.db.authChallenge.updateMany({ where: { hash: hash(state), consumedAt: null, expiresAt: { gt: new Date(this.now()) } }, data: { consumedAt: new Date(this.now()) } });
    if (result.count !== 1) throw new DomainError('UNAUTHORIZED', 'Попытка входа истекла или уже использована');
  }
  async preferences(playerId: string, input?: unknown) {
    if (input !== undefined) {
      const preferences = preferencesSchema.parse(input);
      await this.db.player.update({ where: { discordId: playerId }, data: { preferences } });
      return preferences;
    }
    const player = await this.db.player.findUniqueOrThrow({ where: { discordId: playerId } });
    return preferencesSchema.parse(player.preferences);
  }
  async recovery(playerId: string, kind: string, roomId?: string, matchId?: string): Promise<void> {
    await this.db.recoveryEvent.create({ data: { id: randomUUID(), playerId, kind, ...(roomId ? { roomId } : {}), ...(matchId ? { matchId } : {}) } });
  }
}
export const requestSchema = z.object({ requestId: z.uuid() }).strict();
