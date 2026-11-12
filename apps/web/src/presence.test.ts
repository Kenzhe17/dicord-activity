import { describe, expect, it, vi } from 'vitest';
import type { GameInfo, MatchView, RoomView } from '@rize/shared';
import { PresenceManager, describePresence, classifyPresenceError, PRESENCE_ASSET_KEYS } from './presence';
import type { PresenceActivity, PresenceLogEvent } from './presence';

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
    expect(describePresence(ctx())).toMatchObject({ details: 'r!z3 Arcade', state: 'В игровом клубе', largeImage: 'arcade_main' });
    expect(describePresence(ctx({ page: 'games' }))).toMatchObject({ details: 'r!z3 Arcade', state: 'Выбирает игру' });
    expect(describePresence(ctx({ page: 'game', targetId: 'durak' }))).toMatchObject({ details: 'Дурак', state: 'Выбирает режим' });
    expect(describePresence(ctx({ page: 'game', targetId: 'uno' }))).toMatchObject({ details: 'UNO', state: 'Скоро в Arcade', largeImage: 'uno_main' });
  });
  it('maps lobby with party size and mode', () => {
    const presence = describePresence(ctx({ page: 'room', room: room() }));
    expect(presence).toMatchObject({ details: 'Дурак · Подкидной', state: 'Ожидает игроков', largeImage: 'durak_lobby' });
    expect(presence?.party).toEqual({ id: 'arcade-room-room-1', size: [1, 4] });
  });
  it('clamps party size and maps active match with real start timestamp', () => {
    const crowded = room({ phase: 'playing', matchId: 'm1', members: Array.from({ length: 6 }, (_, i) => ({ player: { id: 'p' + i, name: 'P' + i, avatar: null }, ready: true })) });
    const presence = describePresence(ctx({ page: 'room', room: crowded, match: match() }));
    expect(presence).toMatchObject({ state: 'Идёт партия', largeImage: 'durak_playing' });
    expect(presence?.party?.size).toEqual([4, 4]);
    expect(presence?.startTimestamp).toBe(Date.parse('2026-11-11T12:00:00.000Z') / 1000);
    expect(presence?.endTimestamp).toBeUndefined();
  });
  it('distinguishes victory, defeat and draw on finished matches', () => {
    const won = match({ status: 'finished', result: { winners: ['p1'], losers: ['p2'], draw: false }, finishedAt: '2026-11-11T13:00:00.000Z' });
    const victory = describePresence(ctx({ page: 'room', room: room({ phase: 'playing' }), match: won }));
    expect(victory).toMatchObject({ state: 'Победа в партии', largeImage: 'arcade_victory' });
    expect(victory?.endTimestamp).toBe(Date.parse('2026-11-11T13:00:00.000Z') / 1000);
    const lost = match({ status: 'finished', result: { winners: ['p2'], losers: ['p1'], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing' }), match: lost }))).toMatchObject({ state: 'Партия завершена', largeImage: 'durak_playing' });
    const draw = match({ status: 'finished', result: { winners: [], losers: [], draw: true } });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing' }), match: draw }))).toMatchObject({ state: 'Партия завершена' });
  });
});

describe('classifyPresenceError', () => {
  it('classifies permission, payload, rate-limit, network and unknown errors', () => {
    expect(classifyPresenceError(new Error('Missing scope rpc.activities.write'))).toBe('permission');
    expect(classifyPresenceError({ code: 50006, message: 'Invalid Form Body' })).toBe('payload');
    expect(classifyPresenceError(new Error('rate limited 429'))).toBe('rate_limit');
    expect(classifyPresenceError(new Error('network timeout'))).toBe('network');
    expect(classifyPresenceError(new Error('something odd'))).toBe('unknown');
  });
});

describe('PresenceManager', () => {
  const input: PresenceActivity = { details: 'Дурак', state: 'Идёт партия', largeImage: 'durak_playing' };
  const events = () => { const log: [PresenceLogEvent, (Record<string, unknown> | undefined)?][] = []; return { log: (e: PresenceLogEvent, d?: Record<string, unknown>) => log.push([e, d]), events: log }; };
  it('deduplicates identical payloads and clears with null', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: 0 }));
    const manager = new PresenceManager(send, 0, 0);
    manager.update(input); manager.update(input); manager.update(input);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 0, details: 'Дурак' }));
    manager.update(null);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenLastCalledWith(null);
    expect(send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it('emits structured diagnostics for request, success and clear', async () => {
    vi.useFakeTimers();
    const { log, events: seen } = events();
    const manager = new PresenceManager(vi.fn(async () => ({ type: 0, details: 'Дурак' })), 0, 0, { log });
    manager.update(input);
    await vi.runAllTimersAsync();
    const names = seen.map(([e]) => e);
    expect(names).toEqual(['presence_initialized', 'presence_update_requested', 'presence_update_succeeded']);
    manager.clear();
    await vi.runAllTimersAsync();
    expect(seen.map(([e]) => e)).toContain('presence_cleared');
    vi.useRealTimers();
  });
  it('does not send while the RPC scope is missing and resumes on grant', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: 0 }));
    const manager = new PresenceManager(send, 0, 0);
    manager.setScopeState('missing');
    manager.update(input);
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
    manager.setScopeState('granted');
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('stops permanently on permission errors without retrying', async () => {
    vi.useFakeTimers();
    const { log, events: seen } = events();
    const send = vi.fn(async () => { throw new Error('Missing scope rpc.activities.write'); });
    const manager = new PresenceManager(send, 0, 0, { log, retryBaseMs: 1 });
    manager.update(input);
    await vi.runAllTimersAsync();
    manager.update({ ...input, state: 'changed' });
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(manager.scope).toBe('missing');
    expect(seen.map(([e]) => e)).toContain('presence_scope_missing');
    vi.useRealTimers();
  });
  it('retries transient failures with backoff and recovers', async () => {
    vi.useFakeTimers();
    const { log, events: seen } = events();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue({ type: 0 });
    const manager = new PresenceManager(send, 0, 0, { log, retryBaseMs: 10 });
    manager.update(input);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.filter(([e]) => e === 'presence_retry_scheduled')).toHaveLength(1);
    expect(seen.map(([e]) => e)).toContain('presence_update_succeeded');
    vi.useRealTimers();
  });
  it('does not retry payload rejections', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error('Invalid Form Body'); });
    const manager = new PresenceManager(send, 0, 0, { retryBaseMs: 1 });
    manager.update(input);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it('bounds retries and does not loop forever', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error('network timeout'); });
    const manager = new PresenceManager(send, 0, 0, { maxRetries: 2, retryBaseMs: 1 });
    manager.update(input);
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useRealTimers();
  });
  it('resend re-sends the current state after reconnect', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: 0 }));
    const manager = new PresenceManager(send, 0, 0);
    manager.update(input);
    await vi.runAllTimersAsync();
    manager.resend();
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
  it('dispose cancels pending work', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: 0 }));
    const manager = new PresenceManager(send, 0, 0);
    manager.update(input);
    manager.dispose();
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('presence assets', () => {
  it('declares the art asset keys for the developer portal', () => {
    expect(PRESENCE_ASSET_KEYS).toEqual(['arcade_main', 'durak_lobby', 'durak_playing', 'arcade_victory', 'uno_main', 'mafia_main']);
  });
});
