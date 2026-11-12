import { z } from 'zod';
const schema = z.object({
  ARCADE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ARCADE_AUTH_MODE: z.enum(['disabled', 'mock', 'discord']).default('disabled'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  ARCADE_HOST: z.string().default('127.0.0.1'),
  ARCADE_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  ARCADE_DATABASE_URL: z.string().min(1).optional(),
  ARCADE_DISCORD_CLIENT_ID: z.string().regex(/^[0-9]{17,20}$/).optional(),
  ARCADE_DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  ARCADE_DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  // Single-guild lockdown: when set (Discord auth mode), sessions are only
  // issued inside this guild, verified server-side via the Activity Instances API.
  ARCADE_ALLOWED_GUILD_ID: z.string().regex(/^[0-9]{17,20}$/).default('1196165488565289012'),
  ARCADE_SERVER_INVITE_URL: z.string().max(300).optional(),
  ARCADE_ENABLE_TEST_GAME: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  ARCADE_SERVE_WEB: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  ARCADE_ROOM_IDLE_MS: z.coerce.number().int().min(60000).default(1800000),
  ARCADE_HOST_GRACE_MS: z.coerce.number().int().min(45000).default(120000),
  ARCADE_ECONOMY_BRIDGE_URL: z.url().optional(),
  ARCADE_ECONOMY_BRIDGE_TOKEN: z.string().min(32).optional(),
  ARCADE_ECONOMY_GUILD_ID: z.string().regex(/^[0-9]{17,20}$/).optional(),
  // Paid stakes stay disabled until this is explicitly turned on; the
  // read-only balance bridge works regardless.
  ARCADE_STAKES_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
}).superRefine((c, ctx) => {
  if (c.ARCADE_ENV === 'production' && (c.ARCADE_AUTH_MODE === 'mock' || c.ARCADE_ENABLE_TEST_GAME)) ctx.addIssue({ code: 'custom', message: 'Mock authentication and test games are forbidden in production' });
  if (c.ARCADE_AUTH_MODE === 'discord' && (!c.ARCADE_DISCORD_CLIENT_ID || !c.ARCADE_DISCORD_CLIENT_SECRET)) ctx.addIssue({ code: 'custom', message: 'Discord credentials required' });
  const bridge = [c.ARCADE_ECONOMY_BRIDGE_URL, c.ARCADE_ECONOMY_BRIDGE_TOKEN, c.ARCADE_ECONOMY_GUILD_ID];
  if (bridge.some(v => v !== undefined) && bridge.some(v => v === undefined)) ctx.addIssue({ code: 'custom', message: 'Economy bridge requires URL, token and guild ID together' });
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse({ ...env, ARCADE_ENV: env['NODE_ENV'] === 'production' ? 'production' : env['ARCADE_ENV'] });
  if (!result.success) throw new Error('Invalid Arcade configuration: ' + result.error.issues.map(i => i.path.join('.') || i.message).join(', '));
  return result.data;
}
