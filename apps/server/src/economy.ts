import { z } from 'zod';

const balanceResponse = z.object({
  balance: z.number().int().nonnegative().nullable(),
  exists: z.boolean(),
}).strict();

export interface BalanceInfo { balance: number | null; exists: boolean }

export interface StakesBridge {
  escrow(opId: string, stakes: { userId: string; amount: number }[]): Promise<{ ok: boolean; state?: string | undefined; userId?: string | undefined; replayed?: boolean | undefined } | null>;
  settle(opId: string, payouts: { userId: string; amount: number }[]): Promise<{ ok: boolean; payouts?: { userId: string; credited: number; overflow: number }[] | undefined } | null>;
  refund(opId: string): Promise<boolean | null>;
}

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

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T | null> {
    try {
      const response = await fetch(this.baseUrl + path + '?guild_id=' + this.guildId, {
        method: 'POST',
        headers: { 'x-bridge-token': this.token, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** All-or-nothing pooled stake reservation. `null` means the bridge could
   * not be reached — paid matches must treat that as unavailable, never free. */
  async escrow(opId: string, stakes: { userId: string; amount: number }[]): Promise<{ ok: boolean; state?: string | undefined; userId?: string | undefined; replayed?: boolean | undefined } | null> {
    const result = await this.post('/internal/economy/escrow', { op_id: opId, stakes: stakes.map(s => ({ user_id: s.userId, amount: s.amount })) },
      z.object({ ok: z.boolean(), state: z.string().optional(), user_id: z.string().optional(), error: z.string().optional(), replayed: z.boolean().optional() }).loose());
    if (!result) return null;
    if (!result.ok && result.error === 'insufficient') return { ok: false, userId: result.user_id };
    return { ok: result.ok, state: result.state, replayed: result.replayed };
  }

  /** Settle a reserved escrow into winner payouts. Idempotent by op_id. */
  async settle(opId: string, payouts: { userId: string; amount: number }[]): Promise<{ ok: boolean; payouts?: { userId: string; credited: number; overflow: number }[] | undefined } | null> {
    const result = await this.post('/internal/economy/settle', { op_id: opId, payouts: payouts.map(p => ({ user_id: p.userId, amount: p.amount })) },
      z.object({ ok: z.boolean(), payouts: z.array(z.object({ user_id: z.string(), credited: z.number().int(), overflow: z.number().int() })).optional() }).loose());
    if (!result) return null;
    return { ok: result.ok, payouts: result.payouts?.map(p => ({ userId: p.user_id, credited: p.credited, overflow: p.overflow })) };
  }

  /** Refund a reserved escrow in full. Idempotent by op_id. */
  async refund(opId: string): Promise<boolean | null> {
    const result = await this.post('/internal/economy/refund', { op_id: opId }, z.object({ ok: z.boolean() }).loose());
    return result ? result.ok : null;
  }
}
