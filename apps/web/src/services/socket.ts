import { io, Socket } from 'socket.io-client';
import { z } from 'zod';
import {
  CreateRoomSchema,
  JoinRoomSchema,
  LeaveRoomSchema,
  PlayerReadySchema,
  StartGameSchema,
  GameActionSchema,
  ReconnectRoomSchema,
} from '@rize3-arcade/shared/dist/index.js';

let socket: Socket | null = null;

export function initializeSocket(token: string): Socket {
  if (socket) {
    socket.disconnect();
  }

  // Use build-time constant
  const serverUrl = __SERVER_URL__;
  
  console.log('Connecting to Socket.IO at:', serverUrl);

  socket = io(serverUrl, {
    auth: { token },
    transports: ['websocket'],
  });

  return socket;
}

export function getSocket(): Socket | null {
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
