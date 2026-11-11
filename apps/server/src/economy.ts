import { z } from 'zod';

const balanceResponse = z.object({
  balance: z.number().int().nonnegative().nullable(),
  exists: z.boolean(),
}).strict();

export interface BalanceInfo { balance: number | null; exists: boolean }

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
}
