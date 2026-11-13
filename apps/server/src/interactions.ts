import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';

/** Discord Interaction types we handle. */
export const INTERACTION_PING = 1;
export const INTERACTION_APPLICATION_COMMAND = 2;
export const INTERACTION_MESSAGE_COMPONENT = 3;
/** LAUNCH_ACTIVITY — opens the activity owned by the responding application. */
export const RESPONSE_LAUNCH_ACTIVITY = 12;
export const RESPONSE_PONG = 1;
export const RESPONSE_CHANNEL_MESSAGE = 4;
export const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;

export const ARCADE_LAUNCH_CUSTOM_ID = 'arcade_launch';
export const NEWS_COMMAND_NAME = 'news';

const snowflake = z.string().regex(/^[0-9]{17,20}$/);
const interactionUser = z.object({ id: snowflake }).passthrough();

export const interactionSchema = z.object({
  type: z.number().int(),
  id: z.string().min(1),
  token: z.string().min(1),
  guild_id: snowflake.optional(),
  channel_id: snowflake.optional(),
  user: interactionUser.optional(),
  member: z.object({
    user: interactionUser,
    permissions: z.string().optional(),
  }).passthrough().optional(),
  data: z.object({
    custom_id: z.string().optional(),
    name: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
export type DiscordInteraction = z.infer<typeof interactionSchema>;

/** Verifies the Ed25519 signature Discord attaches to every interaction:
 * signature over `timestamp + rawBody` with the application's public key. */
export function verifyDiscordSignature(publicKeyHex: string, timestamp: string, rawBody: string, signatureHex: string): boolean {
  try {
    if (!/^[0-9a-fA-F]{128}$/.test(signatureHex) || !/^[0-9]{1,20}$/.test(timestamp)) return false;
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') };
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    return cryptoVerify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(rawBody, 'utf8')]), key, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

/** Decides the interaction response. Only the arcade_launch button on a guild
 * component produces LAUNCH_ACTIVITY; everything else is acknowledged safely. */
export function interactionResponse(interaction: DiscordInteraction, allowedGuildIds: readonly string[] | null): Record<string, unknown> {
  if (interaction.type === INTERACTION_PING) return { type: RESPONSE_PONG };
  if (interaction.type === INTERACTION_MESSAGE_COMPONENT && interaction.data?.custom_id === ARCADE_LAUNCH_CUSTOM_ID) {
    // The activity itself enforces the allowed guild; launching elsewhere only
    // reaches the restricted screen, so LAUNCH_ACTIVITY is always safe to send.
    void allowedGuildIds;
    return { type: RESPONSE_LAUNCH_ACTIVITY };
  }
  return { type: RESPONSE_CHANNEL_MESSAGE, data: { content: 'Неизвестная команда.', flags: 64 } }; // ephemeral message
}

/** /news is restricted to Discord administrators or the configured allowlist. */
export function interactionCallerId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user.id ?? interaction.user?.id ?? null;
}
export function interactionIsAdmin(interaction: DiscordInteraction, adminIds: ReadonlySet<string>): boolean {
  const permissions = interaction.member?.permissions;
  // ADMINISTRATOR permission bit (1 << 3)
  if (permissions && (BigInt(permissions) & 8n) === 8n) return true;
  const caller = interactionCallerId(interaction);
  return caller !== null && adminIds.has(caller);
}

/** Announcement payload: banner on top, then a clean embed plus the launch
 * button. No emojis. The banner is a publicly reachable URL served by the
 * web bundle (apps/web/public/assets/news_durak.png). */
export function announcementPayload(imageUrl: string | null = null): { content: string; allowed_mentions: { parse: string[] }; embeds: unknown[]; components: unknown[] } {
  const embeds: unknown[] = [];
  if (imageUrl) embeds.push({ image: { url: imageUrl } });
  embeds.push({
    title: 'r!z3 Arcade — Дурак',
    description: 'На сервере доступна собственная Discord-активность Дурак.',
    color: 0xa83fff,
    fields: [
      { name: 'Режимы', value: 'Подкидной и переводной', inline: true },
      { name: 'Игроки', value: 'от 2 до 6', inline: true },
      { name: 'Запуск', value: 'Через активности в голосовом канале', inline: true },
    ],
    footer: { text: 'Новые игры уже в разработке.' },
  });
  return {
    content: '@everyone',
    allowed_mentions: { parse: ['everyone'] },
    embeds,
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Запустить r!z3 Arcade', custom_id: ARCADE_LAUNCH_CUSTOM_ID }] }],
  };
}

/** Posts the announcement as a regular channel message via the bot token —
 * completely separate from the interaction, so no "used /news" line appears. */
export async function publishAnnouncementToChannel(channelId: string, botToken: string, imageUrl: string | null = null): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { authorization: 'Bot ' + botToken, 'content-type': 'application/json' },
    body: JSON.stringify(announcementPayload(imageUrl)),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('announcement post failed: ' + response.status);
}

/** Edits the ephemeral /news reply after the channel post finishes. */
export async function patchNewsReply(applicationId: string, interactionToken: string, content: string): Promise<void> {
  await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}
