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

const ASSETS = {
  main: 'arcade_main',
  durakLobby: 'durak_lobby',
  durakPlaying: 'durak_playing',
  victory: 'arcade_victory',
  uno: 'uno_main',
  mafia: 'mafia_main',
} as const;

function toSdkPayload(input: PresenceActivity | null): Record<string, unknown> | null {
  if (!input) return null;
  const activity: Record<string, unknown> = {
    type: 0,
    details: input.details,
    assets: {
      large_image: input.largeImage,
      large_text: input.largeText ?? null,
      small_image: input.smallImage ?? null,
      small_text: input.smallText ?? null,
    },
  };
  if (input.state !== undefined) activity['state'] = input.state;
  if (input.party) activity['party'] = { id: input.party.id, size: [...input.party.size] };
  const timestamps: Record<string, number> = {};
  if (input.startTimestamp !== undefined) timestamps['start'] = input.startTimestamp;
  if (input.endTimestamp !== undefined) timestamps['end'] = input.endTimestamp;
  if (Object.keys(timestamps).length > 0) activity['timestamps'] = timestamps;
  return activity;
}

// Serializes, deduplicates and rate-limits setActivity calls. Discord presence
// is best-effort: repeated failures disable the manager instead of breaking
// the game or flooding the RPC channel.
export class PresenceManager {
  private signature: string | null = null;
  private pending: PresenceActivity | null | undefined;
  private inFlight = false;
  private disabled = false;
  private failures = 0;
  private lastFlush = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly send: PresenceSend, private readonly minIntervalMs = 2000, private readonly debounceMs = 400) {}

  update(input: PresenceActivity | null): void {
    if (this.disabled) return;
    const signature = JSON.stringify(input);
    if (signature === this.signature) return;
    this.signature = signature;
    this.pending = input;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, this.debounceMs);
  }

  private async pump(): Promise<void> {
    if (this.inFlight || this.disabled || this.pending === undefined) return;
    const wait = this.minIntervalMs - (Date.now() - this.lastFlush);
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, wait);
      return;
    }
    const input = this.pending;
    this.pending = undefined;
    this.inFlight = true;
    try {
      await this.send(toSdkPayload(input));
      this.failures = 0;
      this.lastFlush = Date.now();
    } catch {
      this.failures++;
      if (this.failures >= 3) this.disabled = true;
    } finally {
      this.inFlight = false;
      if (this.pending !== undefined) this.schedule();
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

function gameAsset(gameId: string, kind: 'lobby' | 'playing' | 'main'): string {
  if (gameId === 'durak') return kind === 'lobby' ? ASSETS.durakLobby : kind === 'playing' ? ASSETS.durakPlaying : ASSETS.main;
  if (gameId === 'uno') return ASSETS.uno;
  if (gameId === 'mafia') return ASSETS.mafia;
  return ASSETS.main;
}

export function describePresence(context: PresenceContext): PresenceActivity | null {
  const { page, targetId, games, room, match, playerId } = context;
  if (!playerId) return null;
  if (room) {
    const name = gameName(games, room.gameId);
    const mode = room.gameId === 'durak' ? durakMode(room) : null;
    const details = name + (mode ? ' · ' + mode : '');
    const party = { id: 'arcade-room-' + room.id, size: [room.members.length, room.maxPlayers] as [number, number] };
    if (room.phase === 'playing' && match) {
      if (match.status === 'finished') {
        const won = !!match.result && !match.result.draw && match.result.winners.includes(playerId);
        return {
          details: name,
          state: 'Партия завершена',
          largeImage: won ? ASSETS.victory : gameAsset(room.gameId, 'playing'),
          largeText: won ? 'Победа в партии!' : 'Партия завершена',
        };
      }
      const startedAt = match.createdAt ? Math.floor(Date.parse(match.createdAt) / 1000) : undefined;
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
    if (!game) return { details: 'r!z3 Arcade', state: 'В игровом клубе', largeImage: ASSETS.main };
    if (game.status === 'planned') return { details: game.name, state: 'Скоро в Arcade', largeImage: gameAsset(game.id, 'main'), largeText: game.name + ' — скоро в Arcade' };
    if (game.id === 'durak') return { details: 'Дурак', state: 'Выбирает режим', largeImage: ASSETS.main, largeText: 'Дурак — выбор режима' };
    return { details: game.name, state: 'Выбирает игру', largeImage: gameAsset(game.id, 'main') };
  }
  if (page === 'home' || page === 'games') {
    return { details: 'В игровом клубе', state: 'Выбирает игру', largeImage: ASSETS.main, largeText: 'r!z3 Arcade — игровой клуб' };
  }
  return { details: 'r!z3 Arcade', state: 'В игровом клубе', largeImage: ASSETS.main };
}
