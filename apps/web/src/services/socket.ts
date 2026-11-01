import { io, Socket } from 'socket.io-client';
import { z } from 'zod';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  CreateRoomSchema,
  JoinRoomSchema,
  LeaveRoomSchema,
  PlayerReadySchema,
  StartGameSchema,
  GameActionSchema,
  ReconnectRoomSchema,
} from '@rize3-arcade/shared';

let socket: Socket<ClientToServerEvents, ServerToClientEvents> | null = null;

export function initializeSocket(token: string): Socket<ClientToServerEvents, ServerToClientEvents> {
  if (socket) {
    socket.disconnect();
  }

  socket = io(import.meta.env.VITE_SERVER_URL || 'http://localhost:3001', {
    auth: { token },
    transports: ['websocket'],
  });

  return socket;
}

export function getSocket(): Socket<ClientToServerEvents, ServerToClientEvents> | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export const socketService = {
  createRoom: (data: z.infer<typeof CreateRoomSchema>) => {
    socket?.emit('create_room', data);
  },

  joinRoom: (data: z.infer<typeof JoinRoomSchema>) => {
    socket?.emit('join_room', data);
  },

  leaveRoom: (data: z.infer<typeof LeaveRoomSchema>) => {
    socket?.emit('leave_room', data);
  },

  playerReady: (data: z.infer<typeof PlayerReadySchema>) => {
    socket?.emit('player_ready', data);
  },

  startGame: (data: z.infer<typeof StartGameSchema>) => {
    socket?.emit('start_game', data);
  },

  gameAction: (data: z.infer<typeof GameActionSchema>) => {
    socket?.emit('game_action', data);
  },

  reconnectRoom: (data: z.infer<typeof ReconnectRoomSchema>) => {
    socket?.emit('reconnect_room', data);
  },
};
