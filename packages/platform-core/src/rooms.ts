import { DomainError, createRoomSchema } from '@rize/shared';
import type { Player, RoomView, RoomSummary } from '@rize/shared';
import type { GameRegistry } from './registry';
export class RoomDirectory {
  private readonly rooms = new Map<string, RoomView>();
  constructor(private readonly games: GameRegistry, private readonly nextId: () => string, private readonly limit = 1000) {}
  static restore(games: GameRegistry, nextId: () => string, rooms: readonly RoomView[]): RoomDirectory {
    const directory = new RoomDirectory(games, nextId);
    for (const room of rooms) directory.rooms.set(room.id, structuredClone(room));
    return directory;
  }
  create(player: Player, input: unknown): RoomView {
    if (this.rooms.size >= this.limit) throw new DomainError('CONFLICT', 'Лимит комнат достигнут');
    if ([...this.rooms.values()].some(room => room.members.some(member => member.player.id === player.id))) throw new DomainError('CONFLICT', 'Сначала покиньте текущую комнату');
    const options = createRoomSchema.parse(input);
    const game = this.games.get(options.gameId);
    const settings = game.settingsSchema.parse(options.settings);
    const capacity = game.getRoomCapacity?.(settings) ?? game.info.maxPlayers;
    if (!Number.isInteger(capacity) || capacity < game.info.minPlayers || capacity > game.info.maxPlayers) throw new DomainError('INVALID_INPUT', 'Некорректная вместимость');
    const room: RoomView = {
      id: this.nextId(), name: options.name, gameId: options.gameId, hostId: player.id,
      visibility: options.visibility, members: [{ player: structuredClone(player), ready: false }],
      maxPlayers: capacity, version: 0, settings,
    };
    this.rooms.set(room.id, room);
    return structuredClone(room);
  }
  list(): RoomSummary[] {
    return [...this.rooms.values()].filter(r => r.visibility === 'public').map(r => ({ id: r.id, name: r.name, gameId: r.gameId, players: r.members.length, maxPlayers: r.maxPlayers }));
  }
  private get(id: string): RoomView {
    const room = this.rooms.get(id);
    if (!room) throw new DomainError('NOT_FOUND', 'Комната не найдена');
    return room;
  }
  view(id: string, actorId: string): RoomView {
    const room = this.get(id);
    this.assertMember(room, actorId);
    return structuredClone(room);
  }
  private assertMember(room: RoomView, actorId: string): void {
    if (!room.members.some(m => m.player.id === actorId)) throw new DomainError('FORBIDDEN', 'Вы не участник комнаты');
  }
  join(id: string, player: Player): RoomView {
    const room = this.get(id);
    if (room.members.some(m => m.player.id === player.id)) return structuredClone(room);
    if ([...this.rooms.values()].some(r => r.members.some(m => m.player.id === player.id))) throw new DomainError('CONFLICT', 'Сначала покиньте текущую комнату');
    if (room.members.length >= room.maxPlayers) throw new DomainError('CONFLICT', 'Комната заполнена');
    const next = { ...room, version: room.version + 1, members: [...room.members, { player: structuredClone(player), ready: false }] };
    this.rooms.set(id, next);
    return structuredClone(next);
  }
  ready(id: string, actorId: string, ready: boolean, expectedVersion: number): RoomView {
    const room = this.get(id);
    this.assertMember(room, actorId);
    if (room.version !== expectedVersion) throw new DomainError('CONFLICT', 'Состояние комнаты изменилось');
    const next = { ...room, version: room.version + 1, members: room.members.map(m => m.player.id === actorId ? { ...m, ready } : m) };
    this.rooms.set(id, next);
    return structuredClone(next);
  }
  transferHost(id: string, actorId: string, targetId: string): RoomView {
    const room = this.get(id);
    if (room.hostId !== actorId) throw new DomainError('FORBIDDEN', 'Только хост может передать управление');
    this.assertMember(room, targetId);
    const next = { ...room, hostId: targetId, version: room.version + 1 };
    this.rooms.set(id, next);
    return structuredClone(next);
  }
  leave(id: string, actorId: string): RoomView | null {
    const room = this.get(id);
    this.assertMember(room, actorId);
    const members = room.members.filter(m => m.player.id !== actorId);
    const first = members[0];
    if (!first) { this.rooms.delete(id); return null; }
    const next = { ...room, members, hostId: room.hostId === actorId ? first.player.id : room.hostId, version: room.version + 1 };
    this.rooms.set(id, next);
    return structuredClone(next);
  }
  assertStartable(id: string, actorId: string): RoomView {
    const room = this.view(id, actorId);
    if (room.hostId !== actorId) throw new DomainError('FORBIDDEN', 'Только хост может начать матч');
    const game = this.games.get(room.gameId);
    if (game.info.status !== 'ready') throw new DomainError('GAME_UNAVAILABLE', 'Движок игры ещё не реализован');
    if (room.members.length < game.info.minPlayers || room.members.some(m => !m.ready)) throw new DomainError('CONFLICT', 'Не все игроки готовы');
    return room;
  }
}
