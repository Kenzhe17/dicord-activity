import type { GameModule } from '@rize/platform-core';
import { DomainError } from '@rize/shared';
import { monopolyDefinition, monopolySettingsSchema } from './definition';
import { stateSchema, actionSchema, createState, transition, invalidReason, playerView, result, isFinished, assertInvariants, systemAction, applySystem } from '../engine';
import type { MonopolyState, MonopolyAction, MonopolyView } from '../engine';
import type { z } from 'zod';
export const monopolyModule: GameModule<MonopolyState, MonopolyAction, z.infer<typeof monopolySettingsSchema>, MonopolyView> = {
  info: { ...monopolyDefinition.info, status: 'ready' }, stateVersion: 1,
  stateSchema, actionSchema, settingsSchema: monopolySettingsSchema,
  getRoomCapacity: monopolyDefinition.getRoomCapacity,
  createInitialState: (settings, context) => {
    try { return createState(settings, context); }
    catch (error) { throw error instanceof DomainError ? error : new DomainError('INVALID_INPUT', error instanceof Error ? error.message : 'Некорректные настройки партии'); }
  },
  validateAction: (state, action, context) => { const reason = invalidReason(state, action, context.actorId, context.now); return reason ? { allowed: false, reason } : { allowed: true }; },
  applyAction: (state, action, context) => transition(state, action, context.actorId, context.now),
  getPlayerView: playerView, isFinished, getResult: result,
  serialize: state => JSON.stringify(state),
  restore: serialized => { const state = stateSchema.parse(JSON.parse(serialized)); assertInvariants(state); return state; },
  getSystemAction: (state, context) => context.recovering && state.phase !== 'finished' ? { type: 'recover' } : systemAction(state, context.now, context.online),
  applySystemAction: applySystem,
};
