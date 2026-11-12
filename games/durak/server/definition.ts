import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';
export const durakSettingsSchema = z.object({ mode: z.enum(['throw-in', 'transfer']).default('throw-in'), maxPlayers: z.number().int().min(2).max(6).default(6), stake: z.number().int().min(0).max(100000).default(0) }).strict();
export const durakDefinition = {
  info: {"id":"durak","name":"Дурак","description":"Знакомая классика за общим столом.","minPlayers":2,"maxPlayers":6,"status":"planned","modes":["Подкидной","Переводной"]},
  settingsSchema: durakSettingsSchema,
} satisfies GameDefinition;
