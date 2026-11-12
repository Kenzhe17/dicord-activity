import { z } from 'zod';

/** Result of a successful Activity-instance verification. */
export interface GuildVerification { guildId: string; instanceId: string }
export interface GuildVerifier {
  /** Returns the verified guild id, or null when the instance cannot be
   * confirmed to belong to the allowed guild (fail closed). */
  verify(input: { applicationId: string; instanceId: string; userId: string }): Promise<GuildVerification | null>;
}

const activityInstanceSchema = z.object({
  application_id: z.string(),
  instance_id: z.string(),
  location: z.object({
    kind: z.string(),
    guild_id: z.string().nullable().optional(),
  }).passthrough(),
  users: z.array(z.string()).default([]),
}).passthrough();

/** Verifies Discord Activity instances through the official
 * GET /applications/{id}/activity-instances/{instance_id} endpoint using the
 * bot token of the Arcade Discord application. Never trusts client-supplied
 * guildId/instanceId/userId — every field is re-checked against Discord. */
export class DiscordGuildVerifier implements GuildVerifier {
  constructor(
    private readonly botToken: string,
    private readonly allowedGuildId: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async verify(input: { applicationId: string; instanceId: string; userId: string }): Promise<GuildVerification | null> {
    if (!input.applicationId || !input.instanceId || !input.userId) return null;
    let response: Response;
    try {
      response = await this.request(
        'https://discord.com/api/v10/applications/' + encodeURIComponent(input.applicationId) + '/activity-instances/' + encodeURIComponent(input.instanceId),
        { headers: { authorization: 'Bot ' + this.botToken, accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
      );
    } catch { return null; }
    if (!response.ok) return null;
    let parsed: z.infer<typeof activityInstanceSchema>;
    try { parsed = activityInstanceSchema.parse(await response.json()); } catch { return null; }
    if (parsed.application_id !== input.applicationId) return null;
    if (parsed.instance_id !== input.instanceId) return null;
    if (parsed.location.kind !== 'gc') return null;
    if (parsed.location.guild_id !== this.allowedGuildId) return null;
    if (!parsed.users.includes(input.userId)) return null;
    return { guildId: this.allowedGuildId, instanceId: input.instanceId };
  }
}
