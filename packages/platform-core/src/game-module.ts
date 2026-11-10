import type { z } from 'zod';
import type { GameInfo } from '@rize/shared';

export interface GameContext { readonly players: readonly string[]; readonly seed: number; readonly startedAt: number }
export interface ActionContext { readonly actorId: string; readonly now: number }
export interface GameResult { readonly winners: readonly string[]; readonly losers: readonly string[]; readonly draw: boolean }
export type Legality = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
/** Pure deterministic rules. Time and randomness come exclusively from context/state. */
export interface GameModule<State, Action, Settings, View> {
  readonly info: GameInfo & { status: 'ready' };
  readonly stateVersion: number;
  readonly settingsSchema: z.ZodType<Settings>;
  readonly actionSchema: z.ZodType<Action>;
  readonly stateSchema: z.ZodType<State>;
  createInitialState(settings: Settings, context: GameContext): State;
  validateAction(state: Readonly<State>, action: Action, context: ActionContext): Legality;
  applyAction(state: Readonly<State>, action: Action, context: ActionContext): State;
  getPlayerView(state: Readonly<State>, playerId: string): View;
  isFinished(state: Readonly<State>): boolean;
  getResult(state: Readonly<State>): GameResult | null;
  serialize(state: Readonly<State>): string;
  restore(serialized: string): State;
  getRoomCapacity?(settings: Settings): number;
  getSystemAction?(state: Readonly<State>, context: { now: number; online: boolean; recovering?: boolean }): unknown | null;
  applySystemAction?(state: Readonly<State>, action: unknown, now: number): State;
}
export interface GameDefinition<Settings = unknown> {
  readonly info: GameInfo;
  readonly settingsSchema: z.ZodType<Settings>;
  getRoomCapacity?(settings: Settings): number;
}
