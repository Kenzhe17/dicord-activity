export type GameType = 'durak' | 'uno' | 'mafia';

export type DurakMode = 'podkidnoy' | 'perevodnoy';

export type CardSuit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type CardRank = '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  suit: CardSuit;
  rank: CardRank;
  id: string; // Unique identifier for the card
}

export interface DurakGameState {
  deck: Card[];
  table: Card[];
  trumpCard: Card | null;
  trumpSuit: CardSuit | null;
  currentTurn: string; // Player ID whose turn it is
  attacker: string | null; // Player ID who is attacking
  defender: string | null; // Player ID who is defending
  gamePhase: 'waiting' | 'attacking' | 'defending' | 'finished';
  winner: string | null;
}

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
  bet: number; // Entry bet amount
  password: string; // Room password
  bank: number; // Total bank from entry bets
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
