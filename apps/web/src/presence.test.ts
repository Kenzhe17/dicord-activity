import { describe, expect, it, vi } from 'vitest';
import type { GameInfo, MatchView, RoomView } from '@rize/shared';
import { PresenceManager, describePresence } from './presence';
import type { PresenceActivity } from './presence';

const games: GameInfo[] = [
  { id: 'durak', name: 'Дурак', description: '', minPlayers: 2, maxPlayers: 6, status: 'ready', modes: ['throw-in', 'transfer'] },
  { id: 'uno', name: 'UNO', description: '', minPlayers: 2, maxPlayers: 10, status: 'planned', modes: [] },
];
const room = (over: Partial<RoomView> = {}): RoomView => ({
  id: 'room-1', name: 'Стол', gameId: 'durak', hostId: 'p1', visibility: 'private',
  members: [{ player: { id: 'p1', name: 'One', avatar: null }, ready: true }],
  maxPlayers: 4, version: 1, settings: { mode: 'throw-in' }, phase: 'waiting', matchId: null, ...over,
});
const match = (over: Partial<MatchView> = {}): MatchView => ({
  matchId: 'm1', roomId: 'room-1', gameId: 'durak', status: 'active', version: 1, state: {}, result: null,
  createdAt: '2026-11-11T12:00:00.000Z', ...over,
});
const ctx = (over: Partial<Parameters<typeof describePresence>[0]> = {}) => ({
  page: 'home', games, room: null, match: null, playerId: 'p1', ...over,
});

describe('describePresence', () => {
  it('returns null without a player and maps menu states', () => {
    expect(describePresence(ctx({ playerId: undefined }))).toBeNull();
    expect(describePresence(ctx())).toMatchObject({ details: 'В игровом клубе', state: 'Выбирает игру', largeImage: 'arcade_main' });
    expect(describePresence(ctx({ page: 'game', targetId: 'durak' }))).toMatchObject({ details: 'Дурак', state: 'Выбирает режим' });
    expect(describePresence(ctx({ page: 'game', targetId: 'uno' }))).toMatchObject({ details: 'UNO', state: 'Скоро в Arcade', largeImage: 'uno_main' });
  });
  it('maps lobby with party size and mode', () => {
    const presence = describePresence(ctx({ page: 'room', room: room() }));
    expect(presence).toMatchObject({ details: 'Дурак · Подкидной', state: 'Ожидает игроков', largeImage: 'durak_lobby' });
    expect(presence?.party).toEqual({ id: 'arcade-room-room-1', size: [1, 4] });
  });
  it('maps active match with real start timestamp', () => {
    const presence = describePresence(ctx({ page: 'room', room: room({ phase: 'playing', matchId: 'm1' }), match: match() }));
    expect(presence).toMatchObject({ state: 'Идёт партия', largeImage: 'durak_playing' });
    expect(presence?.startTimestamp).toBe(Date.parse('2026-11-11T12:00:00.000Z') / 1000);
  });
  it('shows victory asset only for winners', () => {
    const finished = match({ status: 'finished', result: { winners: ['p1'], losers: ['p2'], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing' }), match: finished }))?.largeImage).toBe('arcade_victory');
    const lost = match({ status: 'finished', result: { winners: ['p2'], losers: ['p1'], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing' }), match: lost }))?.largeImage).toBe('durak_playing');
    const draw = match({ status: 'finished', result: { winners: [], losers: [], draw: true } });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing' }), match: draw }))?.largeImage).toBe('durak_playing');
  });
});

describe('PresenceManager', () => {
  const input: PresenceActivity = { details: 'Дурак', state: 'Идёт партия', largeImage: 'durak_playing' };
  it('deduplicates identical payloads and clears with null', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({}));
    const manager = new PresenceManager(send, 0, 0);
    manager.update(input); manager.update(input); manager.update(input);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    manager.update(null);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenLastCalledWith(null);
    expect(send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it('disables after repeated failures without throwing', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error('rpc denied'); });
    const manager = new PresenceManager(send, 0, 0);
    manager.update(input);
    await vi.runAllTimersAsync();
    manager.update({ ...input, state: 'changed' });
    await vi.runAllTimersAsync();
    manager.update({ ...input, state: 'changed again' });
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(3);
    manager.update({ ...input, state: 'more' });
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
