import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';
export const mafiaSettingsSchema = z.object({ discussionSeconds: z.number().int().min(30).max(600).default(120) }).strict();
export const mafiaDefinition = {
  info: {"id":"mafia","name":"Мафия","description":"Ночь скрывает роли. День раскрывает характеры.","minPlayers":6,"maxPlayers":16,"status":"planned","modes":["Classic"]},
  settingsSchema: mafiaSettingsSchema,
} satisfies GameDefinition;
