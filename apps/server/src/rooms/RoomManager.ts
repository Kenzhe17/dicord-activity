import { Room, Player, GameType, DiscordUser } from '@rize3-arcade/shared';

export class RoomManager {
  private static rooms: Map<string, Room> = new Map();
  private static codeToRoomId: Map<string, string> = new Map();
  private static roomIdByPlayer: Map<string, string> = new Map();

  static generateRoomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  static createRoom(
    gameType: GameType,
    owner: DiscordUser,
    settings: Record<string, unknown> = {},
    maxPlayers: number = 6,
    isPublic: boolean = true
  ): Room {
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const roomCode = this.generateRoomCode();

    const player: Player = {
      id: owner.id,
      discordUser: owner,
      isReady: false,
      isOwner: true,
      joinedAt: Date.now(),
      balance: owner.balance,
    };

    const room: Room = {
      id: roomId,
      code: roomCode,
      gameType,
      gameSettings: settings,
      players: [player],
      maxPlayers,
      isPublic,
      createdAt: Date.now(),
      status: 'waiting',
    };

    this.rooms.set(roomId, room);
    this.codeToRoomId.set(roomCode, roomId);
    this.roomIdByPlayer.set(owner.id, roomId);

    return room;
  }

  static getRoomById(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  static getRoomByCode(code: string): Room | undefined {
    const roomId = this.codeToRoomId.get(code);
    if (!roomId) return undefined;
    return this.rooms.get(roomId);
  }

  static getRoomByPlayerId(playerId: string): Room | undefined {
    const roomId = this.roomIdByPlayer.get(playerId);
    if (!roomId) return undefined;
    return this.rooms.get(roomId);
  }

  static joinRoom(roomId: string, user: DiscordUser): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.players.length >= room.maxPlayers) {
      return null;
    }

    if (room.players.some(p => p.id === user.id)) {
      return room;
    }

    const player: Player = {
      id: user.id,
      discordUser: user,
      isReady: false,
      isOwner: false,
      joinedAt: Date.now(),
      balance: user.balance,
    };

    room.players.push(player);
    this.roomIdByPlayer.set(user.id, roomId);

    return room;
  }

  static leaveRoom(roomId: string, playerId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const playerIndex = room.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return null;

    const player = room.players[playerIndex];
    room.players.splice(playerIndex, 1);
    this.roomIdByPlayer.delete(playerId);

    if (player.isOwner && room.players.length > 0) {
      room.players[0].isOwner = true;
    }

    if (room.players.length === 0) {
      this.deleteRoom(roomId);
      return null;
    }

    return room;
  }

  static setPlayerReady(roomId: string, playerId: string, isReady: boolean): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return null;

    player.isReady = isReady;
    return room;
  }

  static setRoomStatus(roomId: string, status: Room['status']): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.status = status;
    return room;
  }

  static deleteRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    room.players.forEach(p => this.roomIdByPlayer.delete(p.id));
    this.codeToRoomId.delete(room.code);
    this.rooms.delete(roomId);

    return true;
  }

  static getPublicRooms(): Room[] {
    return Array.from(this.rooms.values()).filter(r => r.isPublic && r.status === 'waiting');
  }

  static getActiveRoomCount(): number {
    return this.rooms.size;
  }

  static getTotalPlayerCount(): number {
    return Array.from(this.rooms.values()).reduce((sum, room) => sum + room.players.length, 0);
  }

  static cleanupInactiveRooms(maxAge: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [roomId, room] of this.rooms.entries()) {
      if (now - room.createdAt > maxAge) {
        this.deleteRoom(roomId);
      }
    }
  }
}
