import type { GameModule } from '@rize/platform-core';
import { unoDefinition, unoSettingsSchema } from './definition';
import { stateSchema, actionSchema, createState, transition, invalidReason, playerView, result, assertInvariants, systemAction, applySystem } from '../engine';
import type { UnoState, UnoAction, UnoView } from '../engine';
import type { z } from 'zod';
export const unoModule: GameModule<UnoState, UnoAction, z.infer<typeof unoSettingsSchema>, UnoView> = {
  info: { ...unoDefinition.info, status: 'ready' }, stateVersion: 1,
  stateSchema, actionSchema, settingsSchema: unoSettingsSchema,
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
