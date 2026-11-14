import { z } from 'zod';
import type { GameDefinition } from '@rize/platform-core';

export const mafiaPaceSchema = z.enum(['classic', 'short', 'blitz']);
export type MafiaPace = z.infer<typeof mafiaPaceSchema>;

/** Phase durations in seconds per preset. All timers are server-side. */
export const MAFIA_PACE: Record<MafiaPace, { reveal: number; night: number; dawn: number; discussion: number; vote: number; runoff: number }> = {
  classic: { reveal: 20, night: 45, dawn: 8, discussion: 120, vote: 45, runoff: 30 },
  short: { reveal: 15, night: 35, dawn: 6, discussion: 90, vote: 35, runoff: 25 },
  blitz: { reveal: 10, night: 25, dawn: 5, discussion: 60, vote: 25, runoff: 20 },
};

export const mafiaSettingsSchema = z.object({ pace: mafiaPaceSchema.default('classic') }).strict();
export type MafiaSettings = z.infer<typeof mafiaSettingsSchema>;

export const mafiaDefinition = {
  info: {"id":"mafia","name":"Мафия","description":"Ночь скрывает роли. День раскрывает характеры.","minPlayers":6,"maxPlayers":12,"status":"planned","modes":["Классика","Short","Blitz"]},
  settingsSchema: mafiaSettingsSchema,
} satisfies GameDefinition<MafiaSettings>;
