import { DomainError, actionEnvelopeSchema } from '@rize/shared';
import type { GameModule, GameContext } from '@rize/platform-core';
import { z } from 'zod';

const checkpointSchema = z.object({
  gameId: z.string(), stateVersion: z.number().int().positive(), version: z.number().int().nonnegative(),
  roomId: z.uuid(), matchId: z.uuid(), settings: z.unknown(), serialized: z.string(),
  context: z.object({ players: z.array(z.string()).min(2).max(32), seed: z.number().int(), startedAt: z.number().finite().nonnegative() }),
  actions: z.array(z.object({ requestId: z.uuid(), actorId: z.string(), version: z.number().int().positive(), now: z.number().finite().nonnegative(), action: z.unknown(), system: z.boolean().optional() })).max(100000),
});
export type MatchCheckpoint = z.infer<typeof checkpointSchema>;

export interface ActionRecord { requestId: string; actorId: string; version: number; now: number; action: unknown; system?: boolean }
/** Pure executor; PlatformService wraps restoration and dispatch in a database transaction. */
export class MatchRuntime<State, Action, Settings, View> {
  private state: State;
  private version = 0;
  private readonly requests = new Map<string, string>();
  private readonly log: ActionRecord[] = [];
  private readonly settings: Settings;
  constructor(
    private readonly module: GameModule<State, Action, Settings, View>,
    settings: unknown, private readonly context: GameContext,
    readonly roomId: string, readonly matchId: string,
  ) {
    if (context.players.length < module.info.minPlayers || context.players.length > module.info.maxPlayers || new Set(context.players).size !== context.players.length) throw new DomainError('INVALID_INPUT', 'Некорректный состав игроков');
    if (!Number.isInteger(context.seed) || !Number.isFinite(context.startedAt) || context.startedAt < 0) throw new DomainError('INVALID_INPUT', 'Некорректный контекст матча');
    this.context = structuredClone(context);
    this.settings = module.settingsSchema.parse(settings);
    this.state = module.stateSchema.parse(module.createInitialState(structuredClone(this.settings), structuredClone(this.context)));
  }
  view(actorId: string): { version: number; state: View } {
    this.assertPlayer(actorId);
    return { version: this.version, state: structuredClone(this.module.getPlayerView(structuredClone(this.state), actorId)) };
  }
  private assertPlayer(actorId: string): void {
    if (!this.context.players.includes(actorId)) throw new DomainError('FORBIDDEN', 'Игрок не участвует в матче');
  }
  dispatch(actorId: string, raw: unknown, now: number): { version: number; state: View } {
    this.assertPlayer(actorId);
    const envelope = actionEnvelopeSchema.parse(raw);
    if (envelope.roomId !== this.roomId || envelope.matchId !== this.matchId) throw new DomainError('FORBIDDEN', 'Неверный матч');
    const action = this.module.actionSchema.parse(envelope.action);
    const fingerprint = JSON.stringify({ actorId, action, expectedVersion: envelope.expectedVersion });
    const previous = this.requests.get(envelope.requestId);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new DomainError('CONFLICT', 'Повторный requestId с другим содержимым');
      return this.view(actorId);
    }
    if (envelope.expectedVersion !== this.version) throw new DomainError('CONFLICT', 'Устаревшая версия состояния');
    if (!Number.isFinite(now) || now < (this.log.at(-1)?.now ?? this.context.startedAt)) throw new DomainError('INVALID_INPUT', 'Некорректное время действия');
    if (this.module.isFinished(this.state)) throw new DomainError('CONFLICT', 'Матч завершён');
    if (this.log.length >= 100000) throw new DomainError('CONFLICT', 'Превышен лимит действий матча');
    const actionContext = { actorId, now };
    const legality = this.module.validateAction(structuredClone(this.state), action, actionContext);
    if (!legality.allowed) throw new DomainError('INVALID_INPUT', legality.reason);
    const next = this.module.stateSchema.parse(this.module.applyAction(structuredClone(this.state), action, actionContext));
    this.state = next;
    this.version += 1;
    this.requests.set(envelope.requestId, fingerprint);
    this.log.push({ requestId: envelope.requestId, actorId, version: this.version, now, action: structuredClone(action) });
    return this.view(actorId);
  }
  /** Server-only data: never emit this snapshot or action log to clients. */
  nextSystemAction(now: number, online: boolean, recovering = false): unknown | null {
    return this.module.getSystemAction?.(structuredClone(this.state), { now, online, recovering }) ?? null;
  }
  dispatchSystem(requestId: string, action: unknown, now: number): void {
    if (!this.module.applySystemAction || this.module.isFinished(this.state)) throw new DomainError('CONFLICT', 'Системное действие недоступно');
    if (this.log.length >= 100000 || !Number.isFinite(now) || now < (this.log.at(-1)?.now ?? this.context.startedAt)) throw new DomainError('CONFLICT', 'Некорректное системное событие');
    if (this.requests.has(requestId)) throw new DomainError('CONFLICT', 'Повторное системное событие');
    const next = this.module.stateSchema.parse(this.module.applySystemAction(structuredClone(this.state), action, now));
    this.state = next; this.version++;
    this.requests.set(requestId, 'system');
    this.log.push({ requestId, actorId: 'system', version: this.version, now, action: structuredClone(action), system: true });
  }
  result() { return this.module.getResult(structuredClone(this.state)); }
  snapshot(): MatchCheckpoint {
    return { gameId: this.module.info.id, stateVersion: this.module.stateVersion, version: this.version, roomId: this.roomId, matchId: this.matchId, context: { ...this.context, players: [...this.context.players] }, settings: structuredClone(this.settings), serialized: this.module.serialize(structuredClone(this.state)), actions: structuredClone(this.log) };
  }
}

/** Replays and validates a server-owned checkpoint, including its hidden state. */
export function restoreMatch<S, A, C, V>(module: GameModule<S, A, C, V>, raw: unknown): MatchRuntime<S, A, C, V> {
  const snapshot = checkpointSchema.parse(raw);
  if (snapshot.gameId !== module.info.id || snapshot.stateVersion !== module.stateVersion) throw new DomainError('CONFLICT', 'Неподдерживаемая версия движка');
  const runtime = new MatchRuntime(module, snapshot.settings, snapshot.context, snapshot.roomId, snapshot.matchId);
  for (const [index, record] of snapshot.actions.entries()) {
    if (record.version !== index + 1) throw new DomainError('CONFLICT', 'Повреждён журнал действий');
    if (record.system) runtime.dispatchSystem(record.requestId, record.action, record.now);
    else runtime.dispatch(record.actorId, { protocol: 1, roomId: snapshot.roomId, matchId: snapshot.matchId, requestId: record.requestId, expectedVersion: index, action: record.action }, record.now);
  }
  module.stateSchema.parse(module.restore(snapshot.serialized));
  const replayed = runtime.snapshot();
  // Compare canonical parses, not raw strings: checkpoints written before a
  // schema field gained a default must not fail replay forever.
  const canonical = (serialized: string) => JSON.stringify(module.stateSchema.parse(JSON.parse(serialized)));
  if (replayed.version !== snapshot.version || canonical(replayed.serialized) !== canonical(snapshot.serialized)) throw new DomainError('CONFLICT', 'Состояние не соответствует журналу');
  return runtime;
}
