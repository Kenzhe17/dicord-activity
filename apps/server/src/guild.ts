import { z } from 'zod';

/** Result of a successful Activity-instance verification. */
export interface GuildVerification { guildId: string; instanceId: string }
export interface GuildVerifier {
  /** Returns the verified guild id, or null when the instance cannot be
   * confirmed to belong to the allowed guild (fail closed). */
  verify(input: { applicationId: string; instanceId: string; userId: string }): Promise<GuildVerification | null>;
}

export type GuildRejectReason =
  | 'invalid_bot_token' | 'discord_http_401' | 'discord_http_403' | 'discord_http_404'
  | 'instance_mismatch' | 'guild_mismatch' | 'user_not_present'
  | 'api_timeout' | 'invalid_response' | 'verifier_not_configured';

const activityInstanceSchema = z.object({
  application_id: z.string(),
  instance_id: z.string(),
  guild_id: z.string().nullable().optional(),
  location: z.object({
    kind: z.string(),
    guild_id: z.string().nullable().optional(),
  }).passthrough().optional(),
  users: z.array(z.string()).default([]),
}).passthrough();

const RETRY_DELAYS_MS = [400, 1200, 2500];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Verifies Discord Activity instances through the official
 * GET /applications/{id}/activity-instances/{instance_id} endpoint using the
 * bot token of the Arcade Discord application. Never trusts client-supplied
 * guildId/instanceId/userId — every field is re-checked against Discord.
 *
 * Diagnostics: every rejection is reported through onReject with a stable
 * reason code and safe metadata (HTTP status, location kind). Tokens, codes
 * and secrets are never logged. */
export class DiscordGuildVerifier implements GuildVerifier {
  private appCheck: Promise<boolean> | null = null;
  constructor(
    private readonly botToken: string,
    private readonly allowedGuildId: string,
    private readonly request: typeof fetch = fetch,
    private readonly onReject?: (reason: GuildRejectReason, detail?: Record<string, unknown>) => void,
    private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {}

  private reject(reason: GuildRejectReason, detail?: Record<string, unknown>): null {
    this.onReject?.(reason, detail);
    return null;
  }

  /** One-time check that the bot token belongs to the Arcade application
   * itself (GET /oauth2/applications/@me). Cached for the process lifetime. */
  private botTokenMatchesApp(applicationId: string): Promise<boolean> {
    this.appCheck ??= (async () => {
      try {
        const response = await this.request('https://discord.com/api/v10/oauth2/applications/@me', {
          headers: { authorization: 'Bot ' + this.botToken, accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (response.status === 401 || response.status === 403) { this.reject('invalid_bot_token', { step: 'app_check', status: response.status }); return false; }
        if (!response.ok) return false;
        const body: unknown = await response.json();
        const app = z.object({ id: z.string() }).safeParse(body);
        return app.success && app.data.id === applicationId;
      } catch { return false; }
    })();
    return this.appCheck;
  }

  async verify(input: { applicationId: string; instanceId: string; userId: string }): Promise<GuildVerification | null> {
    if (!input.applicationId || !input.instanceId || !input.userId) return this.reject('invalid_response', { step: 'input' });
    if (!(await this.botTokenMatchesApp(input.applicationId))) {
      return this.reject('invalid_bot_token', { step: 'app_check' });
    }
    const url = 'https://discord.com/api/v10/applications/' + encodeURIComponent(input.applicationId) + '/activity-instances/' + encodeURIComponent(input.instanceId);
    // Bounded retry: a fresh Activity launch can lag before Discord registers
    // the instance and populates users[]. Only transient outcomes retry.
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.request(url, {
          headers: { authorization: 'Bot ' + this.botToken, accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        if (attempt < this.retryDelaysMs.length) { await sleep(this.retryDelaysMs[attempt]!); continue; }
        return this.reject('api_timeout', { step: 'instance', attempt });
      }
      if (response.status === 404 || response.status >= 500) {
        if (attempt < this.retryDelaysMs.length) { await sleep(this.retryDelaysMs[attempt]!); continue; }
        return this.reject(response.status === 404 ? 'discord_http_404' : 'invalid_response', { step: 'instance', status: response.status, attempt });
      }
      if (response.status === 401 || response.status === 403) return this.reject(response.status === 401 ? 'discord_http_401' : 'discord_http_403', { step: 'instance', status: response.status });
      if (!response.ok) return this.reject('invalid_response', { step: 'instance', status: response.status });
      let parsed: z.infer<typeof activityInstanceSchema>;
      try { parsed = activityInstanceSchema.parse(await response.json()); } catch { return this.reject('invalid_response', { step: 'instance_parse' }); }
      if (parsed.application_id !== input.applicationId || parsed.instance_id !== input.instanceId) {
        return this.reject('instance_mismatch', { step: 'instance_fields' });
      }
      const locationGuild = parsed.location?.guild_id ?? parsed.guild_id ?? null;
      const locationKind = parsed.location?.kind ?? 'unknown';
      if (parsed.location?.kind !== undefined && parsed.location.kind !== 'gc') {
        return this.reject('guild_mismatch', { step: 'location_kind', kind: locationKind });
      }
      if (locationGuild !== this.allowedGuildId) {
        return this.reject('guild_mismatch', { step: 'guild_id', kind: locationKind });
      }
      if (!parsed.users.includes(input.userId)) {
        // users[] can lag right after launch — retry before giving up.
        if (attempt < this.retryDelaysMs.length) { await sleep(this.retryDelaysMs[attempt]!); continue; }
        return this.reject('user_not_present', { step: 'users', kind: locationKind, users: parsed.users.length });
      }
      return { guildId: this.allowedGuildId, instanceId: input.instanceId };
    }
  }
}
