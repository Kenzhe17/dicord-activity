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
  ARCADE_ENABLE_TEST_GAME: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  ARCADE_SERVE_WEB: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  ARCADE_ROOM_IDLE_MS: z.coerce.number().int().min(60000).default(1800000),
  ARCADE_HOST_GRACE_MS: z.coerce.number().int().min(45000).default(120000),
}).superRefine((c, ctx) => {
  if (c.ARCADE_ENV === 'production' && (c.ARCADE_AUTH_MODE === 'mock' || c.ARCADE_ENABLE_TEST_GAME)) ctx.addIssue({ code: 'custom', message: 'Mock authentication and test games are forbidden in production' });
  if (c.ARCADE_AUTH_MODE === 'discord' && (!c.ARCADE_DISCORD_CLIENT_ID || !c.ARCADE_DISCORD_CLIENT_SECRET)) ctx.addIssue({ code: 'custom', message: 'Discord credentials required' });
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse({ ...env, ARCADE_ENV: env['NODE_ENV'] === 'production' ? 'production' : env['ARCADE_ENV'] });
  if (!result.success) throw new Error('Invalid Arcade configuration: ' + result.error.issues.map(i => i.path.join('.') || i.message).join(', '));
  return result.data;
}
