import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';
export const codenamesSettingsSchema = z.object({
  ruleSet: z.enum(['classic', 'unlimited']).default('unlimited'),
  timed: z.boolean().default(false),
  traitor: z.boolean().default(false),
  hintSeconds: z.number().int().min(10).max(600).default(60),
  guessSeconds: z.number().int().min(15).max(900).default(180),
  dictionary: z.string().regex(/^[a-z]{2,12}$/).default('ru'),
}).strict();
export const codenamesDefinition = {
  info: {"id":"codenames","name":"Слова","description":"Две команды. Один шпион. Двадцать пять слов и одна тайна.","minPlayers":4,"maxPlayers":12,"status":"planned","modes":["Классика","Без лимита","На время","Предатель"]},
  settingsSchema: codenamesSettingsSchema,
  getRoomCapacity: () => 12,
} satisfies GameDefinition<z.infer<typeof codenamesSettingsSchema>>;
