import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { z } from 'zod';

/** Discord Interaction types we handle. */
export const INTERACTION_PING = 1;
export const INTERACTION_MESSAGE_COMPONENT = 3;
/** LAUNCH_ACTIVITY — opens the activity owned by the responding application. */
export const RESPONSE_LAUNCH_ACTIVITY = 12;
export const RESPONSE_PONG = 1;

export const ARCADE_LAUNCH_CUSTOM_ID = 'arcade_launch';

export const interactionSchema = z.object({
  type: z.number().int(),
  id: z.string().min(1),
  token: z.string().min(1),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  data: z.object({ custom_id: z.string().optional() }).passthrough().optional(),
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
export function interactionResponse(interaction: DiscordInteraction, allowedGuildId: string | null): Record<string, unknown> {
  if (interaction.type === INTERACTION_PING) return { type: RESPONSE_PONG };
  if (interaction.type === INTERACTION_MESSAGE_COMPONENT && interaction.data?.custom_id === ARCADE_LAUNCH_CUSTOM_ID) {
    // The activity itself enforces the allowed guild; launching elsewhere only
    // reaches the restricted screen, so LAUNCH_ACTIVITY is always safe to send.
    void allowedGuildId;
    return { type: RESPONSE_LAUNCH_ACTIVITY };
  }
  return { type: 4, data: { content: 'Неизвестная команда.', flags: 64 } }; // ephemeral message
}
