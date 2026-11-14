import type { GameModule } from '@rize/platform-core';
import { codenamesDefinition, codenamesSettingsSchema } from './definition';
import { stateSchema, actionSchema, createState, transition, invalidReason, playerView, result, assertInvariants, systemAction, applySystem } from '../engine';
import type { CodenamesState, CodenamesAction, CodenamesView } from '../engine';
import type { z } from 'zod';
export const codenamesModule: GameModule<CodenamesState, CodenamesAction, z.infer<typeof codenamesSettingsSchema>, CodenamesView> = {
  info: { ...codenamesDefinition.info, status: 'ready' }, stateVersion: 1,
  stateSchema, actionSchema, settingsSchema: codenamesSettingsSchema,
  getRoomCapacity: () => 12,
  createInitialState: createState,
  validateAction: (state, action, context) => { const reason = invalidReason(state, action, context.actorId, context.now); return reason ? { allowed: false, reason } : { allowed: true }; },
  applyAction: (state, action, context) => transition(state, action, context.actorId, context.now),
  getPlayerView: playerView, isFinished: state => state.phase === 'finished', getResult: result,
  serialize: state => JSON.stringify(state),
  restore: serialized => { const state = stateSchema.parse(JSON.parse(serialized)); assertInvariants(state); return state; },
  getSystemAction: (state, context) => systemAction(state, context.now, context.online, context.recovering ?? false),
  applySystemAction: applySystem,
};
