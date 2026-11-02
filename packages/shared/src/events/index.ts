import { z } from 'zod';
import { GameType, DiscordUser, Room, Player } from '../types';

// Client -> Server events
export const CreateRoomSchema = z.object({
  gameType: z.enum(['durak', 'uno', 'mafia']),
  gameSettings: z.record(z.unknown()).optional(),
  maxPlayers: z.number().min(2).max(12).optional(),
  isPublic: z.boolean().optional(),
});

export const JoinRoomSchema = z.object({
  roomCode: z.string().min(4).max(8),
});

export const LeaveRoomSchema = z.object({
  roomId: z.string(),
});

export const PlayerReadySchema = z.object({
  roomId: z.string(),
  isReady: z.boolean(),
});

export const StartGameSchema = z.object({
  roomId: z.string(),
});

export const GameActionSchema = z.object({
  roomId: z.string(),
  action: z.string(),
  data: z.record(z.unknown()).optional(),
});

export const ReconnectRoomSchema = z.object({
  roomId: z.string(),
});

// Server -> Client events
export interface RoomCreatedEvent {
  roomId: string;
  roomCode: string;
  room: Room;
}

export interface RoomUpdatedEvent {
  room: Room;
}

export interface PlayerJoinedEvent {
  player: Player;
  room: Room;
}

export interface JoinSuccessEvent {
  room: Room;
}

export interface JoinErrorEvent {
  code: string;
  message: string;
}

export interface PlayerLeftEvent {
  playerId: string;
  room: Room;
}

export interface GameStartedEvent {
  room: Room;
  initialState: unknown;
}

export interface GameStateUpdatedEvent {
  roomId: string;
  gameState: unknown;
  playerView: unknown;
}

export interface PlayerDisconnectedEvent {
  playerId: string;
  room: Room;
}

export interface GameFinishedEvent {
  roomId: string;
  winner: Player | null;
  results: unknown;
}

export interface ErrorEvent {
  code: string;
  message: string;
  details?: unknown;
}

// Socket event types
export type ClientToServerEvents = {
  create_room: (data: z.infer<typeof CreateRoomSchema>) => void;
  join_room: (data: z.infer<typeof JoinRoomSchema>) => void;
  leave_room: (data: z.infer<typeof LeaveRoomSchema>) => void;
  player_ready: (data: z.infer<typeof PlayerReadySchema>) => void;
  start_game: (data: z.infer<typeof StartGameSchema>) => void;
  game_action: (data: z.infer<typeof GameActionSchema>) => void;
  reconnect_room: (data: z.infer<typeof ReconnectRoomSchema>) => void;
};

export type ServerToClientEvents = {
  room_created: (data: RoomCreatedEvent) => void;
  room_updated: (data: RoomUpdatedEvent) => void;
  player_joined: (data: PlayerJoinedEvent) => void;
  player_left: (data: PlayerLeftEvent) => void;
  game_started: (data: GameStartedEvent) => void;
  game_state_updated: (data: GameStateUpdatedEvent) => void;
  player_disconnected: (data: PlayerDisconnectedEvent) => void;
  game_finished: (data: GameFinishedEvent) => void;
  error: (data: ErrorEvent) => void;
  join_success: (data: JoinSuccessEvent) => void;
  join_error: (data: JoinErrorEvent) => void;
};
