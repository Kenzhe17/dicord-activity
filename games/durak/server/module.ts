import type { GameModule } from '@rize/platform-core';
import { durakDefinition, durakSettingsSchema } from './definition';
import { stateSchema, actionSchema, createState, transition, invalidReason, playerView, result, assertInvariants, systemAction, applySystem } from '../engine';
import type { DurakState, DurakAction, DurakView } from '../engine';
import type { z } from 'zod';
export const durakModule: GameModule<DurakState, DurakAction, z.infer<typeof durakSettingsSchema>, DurakView> = {
  info: { ...durakDefinition.info, status: 'ready' }, stateVersion: 1,
  stateSchema, actionSchema, settingsSchema: durakSettingsSchema,
  getRoomCapacity: settings => settings.maxPlayers,
  createInitialState: createState,
  validateAction: (state, action, context) => { const reason = invalidReason(state, action, context.actorId, context.now); return reason ? { allowed: false, reason } : { allowed: true }; },
  applyAction: (state, action, context) => transition(state, action, context.actorId, context.now),
  getPlayerView: playerView, isFinished: state => state.phase === 'finished', getResult: result,
  serialize: state => JSON.stringify(state),
  restore: serialized => { const state = stateSchema.parse(JSON.parse(serialized)); assertInvariants(state); return state; },
  getSystemAction: (state, context) => context.recovering && state.phase !== 'finished' ? { type: 'recover' } : systemAction(state, context.now, context.online),
  applySystemAction: applySystem,
};
