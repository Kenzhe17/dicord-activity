import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { GameRegistry } from './registry';
import { RoomDirectory } from './rooms';
import type { Player } from '@rize/shared';
const definition = { info: { id: 'fixture', name: 'Fixture', description: 'Test only', minPlayers: 2, maxPlayers: 6, status: 'planned' as const, modes: [] }, settingsSchema: z.object({}).strict() };
const player = (n: number): Player => ({ id: 'dev:p' + n, name: 'Player ' + n, avatar: null });
function setup() { let sequence = 0; const games = new GameRegistry().register(definition); return { games, rooms: new RoomDirectory(games, () => String(++sequence)) }; }
describe('registry', () => {
  it('rejects duplicate ids, invalid settings and unavailable engines', () => {
    const { games } = setup();
    expect(() => games.register(definition)).toThrow();
    expect(() => games.parseSettings('fixture', { unknown: true })).toThrow();
    expect(() => games.getModule('fixture')).toThrow('Движок');
    expect(() => games.register({ ...definition, info: { ...definition.info, status: 'ready' } })).toThrow('registerModule');
    expect(() => games.get('missing')).toThrow();
  });
  it('does not expose mutable metadata', () => {
    const { games } = setup();
    games.get('fixture').info.maxPlayers = 1;
    expect(games.get('fixture').info.maxPlayers).toBe(6);
  });
});
describe('room invariants', () => {
  it('keeps private rooms out of discovery and prevents outsiders reading them', () => {
    const { rooms } = setup();
    const room = rooms.create(player(0), { gameId: 'fixture', name: 'Private', visibility: 'private' });
    expect(rooms.list()).toEqual([]);
    expect(() => rooms.view(room.id, player(1).id)).toThrow();
    expect(rooms.join(room.id, player(1)).members).toHaveLength(2);
  });
  it('requires membership and current version for readiness; restricts host transfer', () => {
    const { rooms } = setup();
    const room = rooms.create(player(0), { gameId: 'fixture', name: 'Room', visibility: 'public' });
    rooms.join(room.id, player(1));
    expect(() => rooms.ready(room.id, player(0).id, true, 0)).toThrow('изменилось');
    expect(() => rooms.ready(room.id, player(5).id, true, 1)).toThrow();
    expect(() => rooms.transferHost(room.id, player(1).id, player(0).id)).toThrow();
    expect(rooms.transferHost(room.id, player(0).id, player(1).id).hostId).toBe(player(1).id);
    expect(() => rooms.assertStartable(room.id, player(1).id)).toThrow('Движок');
  });
  it('returns defensive copies and removes empty rooms', () => {
    const { rooms } = setup();
    const room = rooms.create(player(0), { gameId: 'fixture', name: 'Room', visibility: 'public' });
    room.members[0]!.player.name = 'Tampered';
    expect(rooms.view(room.id, player(0).id).members[0]!.player.name).toBe('Player 0');
    expect(rooms.leave(room.id, player(0).id)).toBeNull();
    expect(rooms.list()).toEqual([]);
  });
  it('enforces capacity and one active room per player', () => {
    const { rooms } = setup();
    const room = rooms.create(player(0), { gameId: 'fixture', name: 'Room', visibility: 'public' });
    for (let i = 1; i < 6; i++) rooms.join(room.id, player(i));
    expect(() => rooms.join(room.id, player(6))).toThrow('заполнена');
    expect(() => rooms.create(player(0), { gameId: 'fixture', name: 'Other', visibility: 'public' })).toThrow('покиньте');
  });
  it('preserves unique membership, capacity and host membership over random commands', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 10 }), fc.boolean()), { maxLength: 100 }), commands => {
      const { rooms } = setup();
      const room = rooms.create(player(0), { gameId: 'fixture', name: 'Room', visibility: 'public' });
      for (const [n, join] of commands) {
        try { if (join) rooms.join(room.id, player(n)); else rooms.leave(room.id, player(n).id); } catch { /* Rejected domain commands leave state unchanged. */ }
        const current = rooms.view(room.id, player(0).id);
        expect(new Set(current.members.map(m => m.player.id)).size).toBe(current.members.length);
        expect(current.members.length).toBeLessThanOrEqual(6);
        expect(current.members.some(m => m.player.id === current.hostId)).toBe(true);
      }
    }), { numRuns: 200, seed: 4201 });
  });
});
