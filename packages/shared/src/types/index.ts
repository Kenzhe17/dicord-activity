export type GameType = 'durak' | 'uno' | 'mafia';

export type DurakMode = 'podkidnoy' | 'perevodnoy';

export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  discriminator: string;
  balance?: number;
}

export interface Player {
  id: string;
  discordUser: DiscordUser;
  isReady: boolean;
  isOwner: boolean;
  joinedAt: number;
  balance?: number;
}

export interface Room {
  id: string;
  code: string;
  gameType: GameType;
  gameSettings: Record<string, unknown>;
  players: Player[];
  maxPlayers: number;
  isPublic: boolean;
  createdAt: number;
  status: 'waiting' | 'playing' | 'finished';
  owner?: Player; // Optional field for convenience
}

export interface RoomState {
  room: Room;
  gameState: unknown;
}

export type SocketError = {
  code: string;
  message: string;
  details?: unknown;
};
