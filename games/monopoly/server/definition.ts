import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';
export const monopolySettingsSchema = z.object({
  mode: z.enum(['classic', 'quick', 'teams']).default('classic'),
  maxPlayers: z.number().int().min(2).max(6).default(6),
  startMoney: z.number().int().min(500).max(10000).default(1500),
  turnSeconds: z.number().int().min(10).max(180).default(30),
  auctionSeconds: z.number().int().min(5).max(120).default(20),
  tradeSeconds: z.number().int().min(15).max(900).default(120),
  evenBuild: z.boolean().default(true),
}).strict();
export const monopolyDefinition = {
  info: {"id":"monopoly","name":"Монополия","description":"Классическая экономическая стратегия: покупайте улицы, стройте, торгуйтесь и разоряйте соперников.","minPlayers":2,"maxPlayers":6,"status":"planned","modes":["Классика","Быстрая","Командная 2×2"]},
  settingsSchema: monopolySettingsSchema,
  getRoomCapacity: (settings: z.infer<typeof monopolySettingsSchema>) => settings.mode === 'teams' ? 4 : settings.maxPlayers,
} satisfies GameDefinition<z.infer<typeof monopolySettingsSchema>>;
