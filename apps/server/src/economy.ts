import { z } from 'zod';

const balanceResponse = z.object({
  balance: z.number().int().nonnegative().nullable(),
  exists: z.boolean(),
}).strict();

export interface BalanceInfo { balance: number | null; exists: boolean }

/** Definitive vs transient bridge outcomes. `unavailable`, `rate_limited` and
 * `invalid_response` are retryable; everything else is a final answer. */
export type BridgeFailure = 'insufficient' | 'conflict' | 'unauthorized' | 'bad_request' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid_response';
export const TRANSIENT_FAILURES: readonly BridgeFailure[] = ['rate_limited', 'unavailable', 'invalid_response'];

export type EscrowResult = { ok: true; state?: string | undefined; userId?: string | undefined; replayed?: boolean | undefined } | { ok: false; reason: BridgeFailure; userId?: string | undefined };
export type SettleResult = { ok: true; payouts?: { userId: string; credited: number; overflow: number }[] | undefined } | { ok: false; reason: BridgeFailure };
export type RefundResult = { ok: true; replayed?: boolean | undefined } | { ok: false; reason: BridgeFailure };
export interface ReservedEscrow { opId: string; createdAt: string }

export interface StakesBridge {
  escrow(opId: string, stakes: { userId: string; amount: number }[]): Promise<EscrowResult>;
  settle(opId: string, payouts: { userId: string; amount: number }[]): Promise<SettleResult>;
  refund(opId: string): Promise<RefundResult>;
  /** Read-only reconciliation feed: escrows still 'reserved' on the bot side.
   * Optional so partial implementations remain valid; Arcade skips the
   * orphan scan when absent. */
  listReservedEscrows?(): Promise<ReservedEscrow[] | null>;
  /** Claim overflow winnings parked as pending credits on the bot. */
  claimPending?(opId: string): Promise<{ ok: boolean; reason?: BridgeFailure | undefined } | null>;
}

const failure = (reason: BridgeFailure): { ok: false; reason: BridgeFailure } => ({ ok: false, reason });

/** Server-to-server client for the bot's internal economy endpoint.
 * The shared token is only ever sent in a header — never logged or returned. */
export class EconomyBridge {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly guildId: string,
    private readonly timeoutMs = 3000,
  ) {}

  static fromConfig(config: { ARCADE_ECONOMY_BRIDGE_URL?: string | undefined; ARCADE_ECONOMY_BRIDGE_TOKEN?: string | undefined; ARCADE_ECONOMY_GUILD_ID?: string | undefined }): EconomyBridge | null {
    const { ARCADE_ECONOMY_BRIDGE_URL: url, ARCADE_ECONOMY_BRIDGE_TOKEN: token, ARCADE_ECONOMY_GUILD_ID: guildId } = config;
    if (!url || !token || !guildId) return null;
    return new EconomyBridge(url.replace(/\/+$/, ''), token, guildId);
  }

  get enabled(): boolean { return true; }

  /** Read-only balance lookup. Returns null when the bridge is unreachable
   * or answers unexpectedly — callers must treat null as "unavailable". */
  async getBalance(discordUserId: string): Promise<BalanceInfo | null> {
    if (!/^[0-9]{17,20}$/.test(discordUserId)) return null;
    try {
      const response = await fetch(this.baseUrl + '/internal/economy/balance?guild_id=' + this.guildId + '&user_id=' + discordUserId, {
        headers: { 'x-bridge-token': this.token, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      const parsed = balanceResponse.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** POST with classified outcomes: HTTP status + error body map to a
   * BridgeFailure so callers can tell insufficient funds from outages. */
  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; reason: BridgeFailure; error?: string | undefined; userId?: string | undefined }> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path + '?guild_id=' + this.guildId, {
        method: 'POST',
        headers: { 'x-bridge-token': this.token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const reason = (status: number): BridgeFailure =>
      status === 400 ? 'bad_request' :
      status === 401 || status === 403 ? 'unauthorized' :
      status === 404 ? 'not_found' :
      status === 409 ? 'conflict' :
      status === 429 ? 'rate_limited' : 'unavailable';
    if (!response.ok) {
      let error: string | undefined, userId: string | undefined;
      try {
        const parsed = z.object({ error: z.string().optional(), user_id: z.string().optional() }).loose().safeParse(await response.json());
        if (parsed.success) { error = parsed.data.error; userId = parsed.data.user_id; }
      } catch { /* body may be empty */ }
      // The bot reports insufficient funds as 409 + error=insufficient.
      if (response.status === 409 && error === 'insufficient') return { ok: false, reason: 'insufficient', error, userId };
      return { ok: false, reason: reason(response.status), error, userId };
    }
    try {
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: 'invalid_response' };
    } catch {
      return { ok: false, reason: 'invalid_response' };
    }
  }

  /** All-or-nothing pooled stake reservation, idempotent by opId. */
  async escrow(opId: string, stakes: { userId: string; amount: number }[]): Promise<EscrowResult> {
    const result = await this.post('/internal/economy/escrow', { op_id: opId, stakes: stakes.map(s => ({ user_id: s.userId, amount: s.amount })) },
      z.object({ ok: z.boolean(), state: z.string().optional(), user_id: z.string().optional(), error: z.string().optional(), replayed: z.boolean().optional() }).loose());
    if (!result.ok) return { ok: false, reason: result.reason, ...(result.userId !== undefined ? { userId: result.userId } : {}) };
    const data = result.data;
    if (!data.ok) return failure(data.error === 'insufficient' ? 'insufficient' : 'conflict');
    return { ok: true, state: data.state, userId: data.user_id, replayed: data.replayed };
  }

  /** Settle a reserved escrow into winner payouts. Idempotent by op_id. */
  async settle(opId: string, payouts: { userId: string; amount: number }[]): Promise<SettleResult> {
    const result = await this.post('/internal/economy/settle', { op_id: opId, payouts: payouts.map(p => ({ user_id: p.userId, amount: p.amount })) },
      z.object({ ok: z.boolean(), payouts: z.array(z.object({ user_id: z.string(), credited: z.number().int(), overflow: z.number().int() })).optional(), error: z.string().optional() }).loose());
    if (!result.ok) return failure(result.reason);
    const data = result.data;
    if (!data.ok) return failure(data.error === 'payout_exceeds_pool' ? 'bad_request' : 'conflict');
    return { ok: true, payouts: data.payouts?.map(p => ({ userId: p.user_id, credited: p.credited, overflow: p.overflow })) };
  }

  /** Refund a reserved escrow in full. Idempotent by op_id. */
  async refund(opId: string): Promise<RefundResult> {
    const result = await this.post('/internal/economy/refund', { op_id: opId }, z.object({ ok: z.boolean(), error: z.string().optional() }).loose());
    if (!result.ok) return failure(result.reason);
    const data = result.data;
    if (!data.ok) return failure('conflict');
    return { ok: true };
  }

  /** Reserved escrows on the bot side, for orphan reconciliation. */
  async listReservedEscrows(): Promise<ReservedEscrow[] | null> {
    try {
      const response = await fetch(this.baseUrl + '/internal/economy/escrows?guild_id=' + this.guildId, {
        headers: { 'x-bridge-token': this.token, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      const parsed = z.object({ escrows: z.array(z.object({ op_id: z.string(), created_at: z.string() })) }).safeParse(await response.json());
      return parsed.success ? parsed.data.escrows.map(e => ({ opId: e.op_id, createdAt: e.created_at })) : null;
    } catch {
      return null;
    }
  }

  /** Ask the bot to credit pending overflow for an escrow, up to the cap. */
  async claimPending(opId: string): Promise<{ ok: boolean; reason?: BridgeFailure | undefined } | null> {
    const result = await this.post('/internal/economy/claim_pending', { op_id: opId }, z.object({ ok: z.boolean() }).loose());
    if (!result.ok) return { ok: false, reason: result.reason };
    return result.data.ok ? { ok: true } : { ok: false, reason: 'conflict' };
  }
}
