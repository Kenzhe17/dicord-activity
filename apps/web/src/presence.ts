import type { GameInfo, MatchView, RoomView } from '@rize/shared';

export interface PresenceActivity {
  details: string;
  state?: string;
  largeImage: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
  party?: { id: string; size: [number, number] };
  startTimestamp?: number | undefined;
  endTimestamp?: number | undefined;
}

export type PresenceSend = (activity: Record<string, unknown> | null) => Promise<unknown>;

export type PresenceLogEvent =
  | 'presence_initialized' | 'presence_scope_granted' | 'presence_scope_missing'
  | 'presence_update_requested' | 'presence_update_succeeded' | 'presence_update_failed'
  | 'presence_retry_scheduled' | 'presence_cleared';
export type PresenceLog = (event: PresenceLogEvent, data?: Record<string, unknown>) => void;
export type PresenceScopeState = 'unknown' | 'granted' | 'missing';
export type PresenceErrorKind = 'permission' | 'payload' | 'rate_limit' | 'network' | 'unknown';

const noopLog: PresenceLog = () => {};

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; code?: unknown; name?: unknown };
    return [e.message, e.code, e.name].filter(v => typeof v === 'string' || typeof v === 'number').join(' ');
  }
  return '';
}

/** Best-effort classification of Discord RPC / transport failures. Never
 * includes payload contents or tokens — only the error's own metadata. */
export function classifyPresenceError(error: unknown): PresenceErrorKind {
  const text = errorText(error).toLowerCase();
  if (/scope|permission|denied|unauthor|forbidden|\b401\b|\b403\b|not allowed/.test(text)) return 'permission';
  if (/rate|429|too many|throttl/.test(text)) return 'rate_limit';
  if (/invalid|validation|payload|schema|malformed|zod/.test(text)) return 'payload';
  if (/timeout|timed out|network|fetch|econn|enotfound|eai_again|socket|abort/.test(text)) return 'network';
  return 'unknown';
}

export type PresenceAssetStage = 'main' | 'lobby' | 'playing';

/** Per-game Rich Presence art. Keys must match asset names in the Discord
 * Developer Portal exactly (file name without .png). */
const GAME_ASSETS: Record<string, Record<PresenceAssetStage, string>> = {
  durak: { main: 'durak_main', lobby: 'durak_lobby', playing: 'durak_playing' },
  uno: { main: 'uno_main', lobby: 'uno_lobby', playing: 'uno_playing' },
  mafia: { main: 'mafia_main', lobby: 'mafia_lobby', playing: 'mafia_playing' },
  codenames: { main: 'codenames_main', lobby: 'codenames_lobby', playing: 'codenames_playing' },
  monopoly: { main: 'monopoly_main', lobby: 'monopoly_lobby', playing: 'monopoly_playing' },
};
const SHARED_ASSETS = { home: 'arcade_main', victory: 'arcade_victory', defeat: 'arcade_defeat' } as const;

/** Art asset keys that must exist in the Discord Developer Portal. Missing
 * keys degrade to no image on Discord's side; they never break updates. */
export const PRESENCE_ASSET_KEYS: readonly string[] = [
  ...Object.values(SHARED_ASSETS),
  ...Object.values(GAME_ASSETS).flatMap(assets => [assets.main, assets.lobby, assets.playing]),
];

function toSdkPayload(input: PresenceActivity | null): Record<string, unknown> | null {
  if (!input) return null;
  const assets: Record<string, string> = { large_image: input.largeImage };
  if (input.largeText) assets['large_text'] = input.largeText;
  if (input.smallImage) assets['small_image'] = input.smallImage;
  if (input.smallText) assets['small_text'] = input.smallText;
  const activity: Record<string, unknown> = { type: 0, details: input.details, assets };
  if (input.state !== undefined) activity['state'] = input.state;
  if (input.party) {
    const [current, max] = input.party.size;
    activity['party'] = { id: input.party.id, size: [Math.min(current, max), max] };
  }
  const timestamps: Record<string, number> = {};
  if (input.startTimestamp !== undefined) timestamps['start'] = input.startTimestamp;
  if (input.endTimestamp !== undefined) timestamps['end'] = input.endTimestamp;
  if (Object.keys(timestamps).length > 0) activity['timestamps'] = timestamps;
  return activity;
}

interface ManagerOptions {
  maxRetries?: number;
  retryBaseMs?: number;
  log?: PresenceLog;
  now?: () => number;
}

// Serializes, deduplicates and rate-limits setActivity calls. Discord presence
// is best-effort: permission failures pause updates until scope is restored,
// transient failures retry with bounded backoff, and nothing here can break
// the game or flood the RPC channel.
export class PresenceManager {
  private signature: string | null = null;
  private pending: PresenceActivity | null | undefined;
  private lastInput: PresenceActivity | null | undefined;
  private inFlight = false;
  private disposed = false;
  private scopeState: PresenceScopeState = 'unknown';
  private retryCount = 0;
  private lastFlush = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly log: PresenceLog;
  private readonly now: () => number;
  constructor(private readonly send: PresenceSend, private readonly minIntervalMs = 2000, private readonly debounceMs = 400, options: ManagerOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.log = options.log ?? noopLog;
    this.now = options.now ?? Date.now;
    this.log('presence_initialized');
  }

  update(input: PresenceActivity | null): void {
    if (this.disposed) return;
    const signature = JSON.stringify(input);
    if (signature === this.signature) return;
    this.signature = signature;
    this.lastInput = input;
    this.retryCount = 0; // a genuinely new state gets a fresh retry budget
    if (this.scopeState === 'missing') return; // no permission — do not attempt
    this.pending = input;
    this.schedule();
  }

  /** Re-send the current state, bypassing deduplication (reconnect resync). */
  resend(): void {
    if (this.disposed || this.lastInput === undefined || this.scopeState === 'missing') return;
    this.pending = this.lastInput;
    this.schedule();
  }

  clear(): void {
    if (this.disposed) return;
    this.signature = JSON.stringify(null);
    this.lastInput = null;
    this.retryCount = 0;
    if (this.scopeState === 'missing') return;
    this.pending = null;
    this.schedule();
    this.log('presence_cleared');
  }

  /** Records whether rpc.activities.write is believed available. 'missing'
   * pauses all sends; 'granted' resumes with the last known state. */
  setScopeState(state: PresenceScopeState): void {
    if (this.disposed || state === this.scopeState) return;
    this.scopeState = state;
    if (state === 'missing') this.log('presence_scope_missing');
    else if (state === 'granted') {
      this.log('presence_scope_granted');
      this.retryCount = 0;
      this.pending = this.lastInput;
      this.schedule();
    }
  }

  get scope(): PresenceScopeState { return this.scopeState; }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = undefined;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, this.debounceMs);
  }

  private async pump(): Promise<void> {
    if (this.inFlight || this.disposed || this.pending === undefined || this.scopeState === 'missing') return;
    const wait = this.minIntervalMs - (this.now() - this.lastFlush);
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, wait);
      return;
    }
    const input = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    const assetKey = input ? (input.largeImage.split('/').pop() ?? input.largeImage) : null;
    this.log('presence_update_requested', { asset: assetKey ?? 'none', hasParty: !!input?.party, timed: input?.startTimestamp !== undefined });
    try {
      const result = await this.send(toSdkPayload(input));
      this.lastFlush = this.now();
      this.retryCount = 0;
      // Discord echoes the accepted activity back; a resolved promise alone is
      // not proof the presence was applied.
      const confirmed = result !== null && typeof result === 'object';
      this.log('presence_update_succeeded', { cleared: input === null, confirmed });
      if (!confirmed) this.log('presence_update_failed', { operation: 'setActivity', reason: 'unconfirmed_response' });
    } catch (error) {
      const kind = classifyPresenceError(error);
      this.log('presence_update_failed', { operation: 'setActivity', reason: kind, attempt: this.retryCount + 1 });
      if (kind === 'permission') {
        this.scopeState = 'missing';
        this.log('presence_scope_missing');
      } else if (kind === 'payload') {
        // A rejected payload will not fix itself — drop it, keep the manager alive.
      } else if (this.retryCount < this.maxRetries) {
        const delay = this.retryBaseMs * 2 ** this.retryCount;
        this.retryCount++;
        this.log('presence_retry_scheduled', { reason: kind, attempt: this.retryCount, delayMs: delay });
        this.timer = setTimeout(() => { this.timer = null; if (this.pending === undefined) this.pending = input; void this.pump(); }, delay);
      }
    } finally {
      this.inFlight = false;
      if (this.pending !== undefined && this.timer === null) this.schedule();
    }
  }
}

export interface PresenceContext {
  page: string;
  targetId?: string | undefined;
  games: GameInfo[];
  room: RoomView | null;
  match: MatchView | null;
  playerId?: string | undefined;
}

function gameName(games: GameInfo[], gameId: string): string {
  return games.find(g => g.id === gameId)?.name ?? gameId;
}

function durakMode(room: RoomView): string | null {
  const settings = room.settings as { mode?: unknown } | null;
  if (settings?.mode === 'throw-in') return 'Подкидной';
  if (settings?.mode === 'transfer') return 'Переводной';
  return null;
}

function gameAsset(gameId: string, stage: PresenceAssetStage): string {
  return GAME_ASSETS[gameId]?.[stage] ?? SHARED_ASSETS.home;
}

export function describePresence(context: PresenceContext): PresenceActivity | null {
  const { page, targetId, games, room, match, playerId } = context;
  if (!playerId) return null;
  if (room) {
    const name = gameName(games, room.gameId);
    const mode = room.gameId === 'durak' ? durakMode(room) : null;
    const details = name + (mode ? ' · ' + mode : '');
    const party = { id: 'arcade-room-' + room.id, size: [Math.min(room.members.length, room.maxPlayers), room.maxPlayers] as [number, number] };
    // The server returns the room to 'waiting' when a match ends, but the
    // finished MatchView stays on screen — the result must keep showing
    // until a new match replaces it. Only trust matches of this room.
    const current = match && match.roomId === room.id ? match : null;
    if (current && current.status !== 'active') {
      const result = current.result;
      const endTimestamp = current.finishedAt ? Math.floor(Date.parse(current.finishedAt) / 1000) : undefined;
      if (result?.draw) {
        return { details, state: 'Ничья', largeImage: gameAsset(room.gameId, 'main'), largeText: details + ' — ничья', party, endTimestamp };
      }
      if (result && result.winners.includes(playerId)) {
        return { details, state: 'Победа в партии', largeImage: SHARED_ASSETS.victory, largeText: details + ' — победа!', party, endTimestamp };
      }
      if (result && result.losers.includes(playerId)) {
        return { details, state: 'Поражение в партии', largeImage: SHARED_ASSETS.defeat, largeText: details + ' — поражение', party, endTimestamp };
      }
      return { details, state: 'Партия завершена', largeImage: gameAsset(room.gameId, 'main'), largeText: details + ' — партия завершена', party, endTimestamp };
    }
    if (current && room.phase === 'playing') {
      const startedAt = current.createdAt ? Math.floor(Date.parse(current.createdAt) / 1000) : undefined;
      return {
        details,
        state: 'Идёт партия',
        largeImage: gameAsset(room.gameId, 'playing'),
        largeText: details + ' — идёт партия',
        party,
        startTimestamp: startedAt,
      };
    }
    return {
      details,
      state: 'Ожидает игроков',
      largeImage: gameAsset(room.gameId, 'lobby'),
      largeText: details + ' — ожидание игроков',
      party,
    };
  }
  if ((page === 'game' || page === 'create') && targetId) {
    const game = games.find(g => g.id === targetId);
    if (!game) return { details: 'r!z3 Arcade', state: 'В игровом клубе', largeImage: SHARED_ASSETS.home };
    if (game.status === 'planned') return { details: game.name, state: 'Скоро в Arcade', largeImage: gameAsset(game.id, 'main'), largeText: game.name + ' — скоро в Arcade' };
    if (game.id === 'durak') return { details: game.name, state: 'Выбирает режим', largeImage: gameAsset(game.id, 'main'), largeText: game.name + ' — выбор режима' };
    return { details: game.name, state: 'Выбирает игру', largeImage: gameAsset(game.id, 'main') };
  }
  if (page === 'games') {
    return { details: 'r!z3 Arcade', state: 'Выбирает игру', largeImage: SHARED_ASSETS.home, largeText: 'r!z3 Arcade — библиотека игр' };
  }
  return { details: 'r!z3 Arcade', state: 'В игровом клубе', largeImage: SHARED_ASSETS.home };
}
