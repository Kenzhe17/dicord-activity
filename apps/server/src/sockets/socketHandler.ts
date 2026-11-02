import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import {
  CreateRoomSchema,
  JoinRoomSchema,
  LeaveRoomSchema,
  PlayerReadySchema,
  StartGameSchema,
  GameActionSchema,
  ReconnectRoomSchema,
  ClientToServerEvents,
  ServerToClientEvents,
  DiscordUser,
  JoinSuccessEvent,
  JoinErrorEvent,
} from '@rize3-arcade/shared';
import { RoomManager } from '../rooms/RoomManager';

export function setupSocketIO(io: Server<ClientToServerEvents, ServerToClientEvents>) {
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', socket.id);

    socket.on('create_room', async (data) => {
      try {
        const validated = CreateRoomSchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        const room = RoomManager.createRoom(
          validated.gameType,
          user,
          validated.gameSettings,
          validated.maxPlayers,
          validated.isPublic
        );

        socket.join(room.id);
        socket.data.roomId = room.id;

        socket.emit('room_created', {
          roomId: room.id,
          roomCode: room.code,
          room,
        });

        console.log(`Room created: ${room.code} by ${user.username}`);
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        } else {
          socket.emit('error', {
            code: 'INTERNAL_ERROR',
            message: 'Failed to create room',
          });
        }
      }
    });

    socket.on('join_room', async (data) => {
      try {
        const validated = JoinRoomSchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        const room = RoomManager.getRoomByCode(validated.roomCode);
        if (!room) {
          socket.emit('error', {
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found',
          });
          return;
        }

        const updatedRoom = RoomManager.joinRoom(room.id, user);
        if (!updatedRoom) {
          const errorData: JoinErrorEvent = {
            code: 'ROOM_FULL',
            message: 'Room is full',
          };
          socket.emit('join_error', errorData);
          return;
        }

        socket.join(room.id);
        socket.data.roomId = room.id;

        io.to(room.id).emit('player_joined', {
          player: updatedRoom.players[updatedRoom.players.length - 1],
          room: updatedRoom,
        });

        const successData: JoinSuccessEvent = { room: updatedRoom };
        socket.emit('join_success', successData);

        console.log(`User ${user.username} joined room ${room.code}`);
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        } else {
          socket.emit('error', {
            code: 'INTERNAL_ERROR',
            message: 'Failed to join room',
          });
        }
      }
    });

    socket.on('leave_room', async (data) => {
      try {
        const validated = LeaveRoomSchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        const room = RoomManager.leaveRoom(validated.roomId, user.id);
        if (!room) {
          socket.leave(validated.roomId);
          socket.data.roomId = null;
          return;
        }

        socket.leave(validated.roomId);
        socket.data.roomId = null;

        io.to(validated.roomId).emit('player_left', {
          playerId: user.id,
          room,
        });

        console.log(`User ${user.username} left room ${room.code}`);
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        }
      }
    });

    socket.on('player_ready', async (data) => {
      try {
        const validated = PlayerReadySchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        const room = RoomManager.setPlayerReady(validated.roomId, user.id, validated.isReady);
        if (!room) {
          socket.emit('error', {
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found',
          });
          return;
        }

        io.to(validated.roomId).emit('room_updated', { room });
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        }
      }
    });

    socket.on('start_game', async (data) => {
      try {
        const validated = StartGameSchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        const room = RoomManager.getRoomById(validated.roomId);
        if (!room) {
          socket.emit('error', {
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found',
          });
          return;
        }

        const owner = room.players.find(p => p.isOwner);
        if (owner?.id !== user.id) {
          socket.emit('error', {
            code: 'NOT_OWNER',
            message: 'Only the room owner can start the game',
          });
          return;
        }

        const allReady = room.players.every(p => p.isReady);
        if (!allReady) {
          socket.emit('error', {
            code: 'NOT_ALL_READY',
            message: 'All players must be ready to start the game',
          });
          return;
        }

        RoomManager.setRoomStatus(validated.roomId, 'playing');

        io.to(validated.roomId).emit('game_started', {
          room,
          initialState: null,
        });

        console.log(`Game started in room ${room.code}`);
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        }
      }
    });

    socket.on('game_action', async (data) => {
      try {
        const validated = GameActionSchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        socket.emit('error', {
          code: 'NOT_IMPLEMENTED',
          message: 'Game actions will be implemented in Stage 2',
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        }
      }
    });

    socket.on('reconnect_room', async (data) => {
      try {
        const validated = ReconnectRoomSchema.parse(data);
        const user = socket.data.user as DiscordUser | undefined;

        if (!user) {
          socket.emit('error', {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated',
          });
          return;
        }

        const room = RoomManager.getRoomById(validated.roomId);
        if (!room) {
          socket.emit('error', {
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found',
          });
          return;
        }

        const player = room.players.find(p => p.id === user.id);
        if (!player) {
          socket.emit('error', {
            code: 'NOT_IN_ROOM',
            message: 'You are not in this room',
          });
          return;
        }

        socket.join(room.id);
        socket.data.roomId = room.id;

        socket.emit('room_updated', { room });

        console.log(`User ${user.username} reconnected to room ${room.code}`);
      } catch (error) {
        if (error instanceof z.ZodError) {
          socket.emit('error', {
            code: 'VALIDATION_ERROR',
            message: 'Invalid data',
            details: error.errors,
          });
        }
      }
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId as string | undefined;
      const user = socket.data.user as DiscordUser | undefined;

      if (roomId && user) {
        const room = RoomManager.getRoomById(roomId);
        if (room) {
          io.to(roomId).emit('player_disconnected', {
            playerId: user.id,
            room,
          });
          console.log(`User ${user.username} disconnected from room ${room.code}`);
        }
      }
    });
  });
}
