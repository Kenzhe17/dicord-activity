import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';
export const unoSettingsSchema = z.object({
  mode: z.enum(['quick', 'points']).default('points'),
  target: z.number().int().min(100).max(10000).default(500),
  maxPlayers: z.number().int().min(2).max(10).default(10),
}).strict();
export const unoDefinition = {
  info: {"id":"uno","name":"UNO","description":"Цвет, тактика и одна последняя карта.","minPlayers":2,"maxPlayers":10,"status":"planned","modes":["Очки до цели","Быстрая партия"]},
  settingsSchema: unoSettingsSchema,
} satisfies GameDefinition;
