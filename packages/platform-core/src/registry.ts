import { DomainError, gameInfoSchema } from '@rize/shared';
import type { GameInfo } from '@rize/shared';
import type { GameDefinition, GameModule } from './game-module';
export class GameRegistry {
  private readonly entries = new Map<string, GameDefinition>();
  private readonly modules = new Map<string, GameModule<unknown, unknown, unknown, unknown>>();
  register<Settings>(definition: GameDefinition<Settings>): this {
    if (definition.info.status !== 'planned') throw new DomainError('CONFLICT', 'Готовая игра требует registerModule');
    return this.addDefinition(definition);
  }
  private addDefinition<Settings>(definition: GameDefinition<Settings>): this {
    const info = gameInfoSchema.parse(definition.info);
    if (info.minPlayers > info.maxPlayers || this.entries.has(info.id)) throw new DomainError('CONFLICT', 'Некорректная или повторная регистрация игры');
    this.entries.set(info.id, { info: structuredClone(info), settingsSchema: definition.settingsSchema, ...(definition.getRoomCapacity ? { getRoomCapacity: (settings: unknown) => definition.getRoomCapacity!(definition.settingsSchema.parse(settings)) } : {}) });
    return this;
  }
  registerModule<S, A, C, V>(module: GameModule<S, A, C, V>): this {
    this.addDefinition(module);
    this.modules.set(module.info.id, {
      ...module,
      createInitialState: (settings, context) => module.createInitialState(module.settingsSchema.parse(settings), context),
      validateAction: (state, action, context) => module.validateAction(module.stateSchema.parse(state), module.actionSchema.parse(action), context),
      applyAction: (state, action, context) => module.applyAction(module.stateSchema.parse(state), module.actionSchema.parse(action), context),
      getPlayerView: (state, playerId) => module.getPlayerView(module.stateSchema.parse(state), playerId),
      isFinished: state => module.isFinished(module.stateSchema.parse(state)),
      getResult: state => module.getResult(module.stateSchema.parse(state)),
      serialize: state => module.serialize(module.stateSchema.parse(state)),
      ...(module.getRoomCapacity ? { getRoomCapacity: (settings: unknown) => module.getRoomCapacity!(module.settingsSchema.parse(settings)) } : {}),
      ...(module.getSystemAction ? { getSystemAction: (state: unknown, context: { now: number; online: boolean; recovering?: boolean }) => module.getSystemAction!(module.stateSchema.parse(state), context) } : {}),
      ...(module.applySystemAction ? { applySystemAction: (state: unknown, action: unknown, now: number) => module.applySystemAction!(module.stateSchema.parse(state), action, now) } : {}),
    });
    return this;
  }
  getModule(id: string): GameModule<unknown, unknown, unknown, unknown> {
    this.get(id);
    const module = this.modules.get(id);
    if (!module) throw new DomainError('GAME_UNAVAILABLE', 'Движок игры ещё не реализован');
    return module;
  }
  get(id: string): GameDefinition {
    const definition = this.entries.get(id);
    if (!definition) throw new DomainError('NOT_FOUND', 'Игра не найдена');
    return { ...definition, info: structuredClone(definition.info) };
  }
  list(): GameInfo[] { return [...this.entries.values()].map(({ info }) => structuredClone(info)); }
  parseSettings(id: string, input: unknown): unknown { return this.get(id).settingsSchema.parse(input); }
}
