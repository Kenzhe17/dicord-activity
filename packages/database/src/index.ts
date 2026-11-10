import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';
export { Prisma } from './generated/client';
export type { PrismaClient } from './generated/client';
export function createArcadeDatabase(connectionString: string): PrismaClient {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URL');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema: 'arcade' }) });
}
export interface SnapshotRepository<T> {
  load(id: string): Promise<{ version: number; state: T } | null>;
  compareAndSwap(id: string, expectedVersion: number, next: T): Promise<boolean>;
}
export interface EconomyPort {
  getBalance(discordId: string): Promise<{ amount: bigint; currencyLabel: string }>;
  grantMatchReward(input: { matchId: string; discordId: string; rewardPolicyId: string; idempotencyKey: string }): Promise<{ externalReference: string }>;
}
