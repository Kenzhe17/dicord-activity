import { z } from 'zod';
import type { GameModule } from '@rize/platform-core';
const stateSchema = z.object({ players: z.array(z.string()), scores: z.record(z.string(), z.number()), secrets: z.record(z.string(), z.string()), turn: z.number().int(), target: z.number().int(), winner: z.string().nullable() });
const actionSchema = z.object({ type: z.literal('advance'), steps: z.union([z.literal(1), z.literal(2)]) }).strict();
const settingsSchema = z.object({ target: z.number().int().min(3).max(12).default(4) }).strict();
type State = z.infer<typeof stateSchema>;
export const sandboxModule: GameModule<State, z.infer<typeof actionSchema>, z.infer<typeof settingsSchema>, { scores: Record<string, number>; turnId: string | null; ownSecret: string; winner: string | null; target: number }> = {
  info: { id: 'sandbox', name: 'Испытательный стол', description: 'Проверка инфраструктуры. Только для разработки.', minPlayers: 2, maxPlayers: 4, status: 'ready', modes: ['Тестовый'] },
  stateVersion: 1, stateSchema, actionSchema, settingsSchema,
  createInitialState: (settings, context) => ({
    players: [...context.players], scores: Object.fromEntries(context.players.map(id => [id, 0])),
    secrets: Object.fromEntries(context.players.map((id, index) => [id, 'seat-' + context.seed + '-' + index])),
    turn: 0, target: settings.target, winner: null,
  }),
  validateAction: (state, _action, context) => !state.winner && state.players[state.turn] === context.actorId ? { allowed: true } : { allowed: false, reason: 'Сейчас ход другого игрока' },
  applyAction: (state, action, context) => {
    const scores = { ...state.scores, [context.actorId]: (state.scores[context.actorId] ?? 0) + action.steps };
    return { ...state, scores, turn: (state.turn + 1) % state.players.length, winner: (scores[context.actorId] ?? 0) >= state.target ? context.actorId : null };
  },
  getPlayerView: (state, playerId) => ({ scores: { ...state.scores }, turnId: state.winner ? null : state.players[state.turn] ?? null, ownSecret: state.secrets[playerId] ?? '', winner: state.winner, target: state.target }),
  isFinished: state => state.winner !== null,
  getResult: state => state.winner ? { winners: [state.winner], losers: state.players.filter(id => id !== state.winner), draw: false } : null,
  serialize: state => JSON.stringify(state),
  restore: serialized => stateSchema.parse(JSON.parse(serialized)),
};
