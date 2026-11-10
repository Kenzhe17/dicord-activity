import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';
export const unoSettingsSchema = z.object({ stacking: z.boolean().default(false), jumpIn: z.boolean().default(false) }).strict();
export const unoDefinition = {
  info: {"id":"uno","name":"UNO-style","description":"Цвет, тактика и одна последняя карта.","minPlayers":2,"maxPlayers":10,"status":"planned","modes":["Классический"]},
  settingsSchema: unoSettingsSchema,
} satisfies GameDefinition;
