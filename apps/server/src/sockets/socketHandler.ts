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
} from '@rize3-arcade/shared';
import { RoomManager } from '../rooms/RoomManager';
import { DurakGame } from '../games/durak/DurakGame';

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

        const room = await RoomManager.createRoom(
          validated.gameType,
          user,
          validated.gameSettings,
          validated.maxPlayers,
          validated.isPublic,
          validated.bet,
          validated.password
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
          socket.emit('join_error', {
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found',
          });
          return;
        }

        const updatedRoom = await RoomManager.joinRoom(room.id, user, validated.password);
        if (!updatedRoom) {
          socket.emit('join_error', {
            code: 'JOIN_FAILED',
            message: 'Invalid password, room full, or insufficient balance',
          });
          return;
        }

        socket.join(room.id);
        socket.data.roomId = room.id;

        io.to(room.id).emit('player_joined', {
          player: updatedRoom.players[updatedRoom.players.length - 1],
          room: updatedRoom,
        });

        socket.emit('join_success', { room: updatedRoom });

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

        const room = await RoomManager.leaveRoom(validated.roomId, user.id);
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

        // Prevent starting game if already started
        if (room.status === 'playing') {
          socket.emit('error', {
            code: 'GAME_ALREADY_STARTED',
            message: 'Game has already started',
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

        // Initialize Durak game
        const playerIds = room.players.map(p => p.id);
        const gameState = DurakGame.initializeGame(playerIds, 'podkidnoy');

        // Update room with game state
        room.gameSettings.gameState = gameState;
        const updatedRoom = RoomManager.setRoomStatus(validated.roomId, 'playing');

        // Emit both events to ensure UI updates
        io.to(validated.roomId).emit('room_updated', { room: updatedRoom || room });
        io.to(validated.roomId).emit('game_started', {
          room: updatedRoom || room,
          gameState,
        });

        console.log(`Durak game started in room ${room.code}, status: ${updatedRoom?.status}`);
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

        const room = RoomManager.getRoomById(validated.roomId);
        if (!room) {
          socket.emit('error', {
            code: 'ROOM_NOT_FOUND',
            message: 'Room not found',
          });
          return;
        }

        // Handle Durak game actions
        if (room.gameType === 'durak' && validated.action === 'play_card') {
          const card = validated.data as any;
          const gameState = room.gameSettings.gameState as any;
          
          if (!gameState) {
            socket.emit('error', {
              code: 'GAME_NOT_STARTED',
              message: 'Game has not started',
            });
            return;
          }

          const newGameState = DurakGame.playCard(card, gameState, user.id);
          
          // Update room with new game state
          room.gameSettings.gameState = newGameState;
          
          io.to(validated.roomId).emit('game_state_updated', {
            roomId: validated.roomId,
            gameState: newGameState,
            playerView: { playerId: user.id, hand: gameState.deck },
          });

          // Check for win condition
          if (gameState.deck.length === 0 || gameState.gamePhase === 'finished') {
            const winnerId = DurakGame.calculateWinner(gameState, room.players.map(p => p.id));
            
            if (winnerId) {
              // Distribute 90% of bank to winner
              const winnerShare = Math.floor(room.bank * 0.9);
              const winner = room.players.find(p => p.id === winnerId);
              
              let updatedWinner = null;
              
              if (winner) {
                // Update winner's balance in database
                // Note: This would need to be async in real implementation
                updatedWinner = {
                  ...winner,
                  balance: (winner.balance ?? 0) + winnerShare,
                };
                
                // Update winner in room
                const winnerIndex = room.players.findIndex(p => p.id === winnerId);
                if (winnerIndex !== -1) {
                  room.players[winnerIndex] = updatedWinner;
                }
              }

              RoomManager.setRoomStatus(validated.roomId, 'finished');

              io.to(validated.roomId).emit('game_finished', {
                roomId: validated.roomId,
                winner: updatedWinner,
                results: { winnerShare, totalBank: room.bank },
              });

              console.log(`Game finished in room ${room.code}, winner: ${winnerId}, won: ${winnerShare}`);
            }
          }
        } else {
          socket.emit('error', {
            code: 'NOT_IMPLEMENTED',
            message: 'Game action not implemented',
          });
        }
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
          // Check if disconnecting user is the owner
          const owner = room.players.find(p => p.isOwner);
          if (owner?.id === user.id) {
            // Close the room if owner disconnects
            RoomManager.deleteRoom(roomId);
            io.to(roomId).emit('room_closed', {
              reason: 'owner_disconnected',
            });
            console.log(`Room ${room.code} closed because owner ${user.username} disconnected`);
          } else {
            io.to(roomId).emit('player_disconnected', {
              playerId: user.id,
              room,
            });
            console.log(`User ${user.username} disconnected from room ${room.code}`);
          }
        }
      }
    });
  });
}
