import { describe, expect, it, vi } from 'vitest';
import type { GameInfo, MatchView, RoomView } from '@rize/shared';
import { PresenceManager, describePresence, classifyPresenceError, PRESENCE_ASSET_KEYS } from './presence';
import type { PresenceActivity, PresenceLogEvent } from './presence';

const games: GameInfo[] = [
  { id: 'durak', name: 'Дурак', description: '', minPlayers: 2, maxPlayers: 6, status: 'ready', modes: ['throw-in', 'transfer'] },
  { id: 'uno', name: 'UNO', description: '', minPlayers: 2, maxPlayers: 10, status: 'ready', modes: [] },
  { id: 'mafia', name: 'Мафия', description: '', minPlayers: 5, maxPlayers: 12, status: 'ready', modes: [] },
  { id: 'codenames', name: 'Кодовые имена', description: '', minPlayers: 4, maxPlayers: 8, status: 'ready', modes: [] },
  { id: 'monopoly', name: 'Монополия', description: '', minPlayers: 2, maxPlayers: 6, status: 'ready', modes: [] },
  { id: 'future', name: 'Будущая игра', description: '', minPlayers: 2, maxPlayers: 4, status: 'planned', modes: [] },
];
const GAME_IDS = ['durak', 'uno', 'mafia', 'codenames', 'monopoly'] as const;
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
    expect(describePresence(ctx({ page: 'games' }))).toMatchObject({ details: 'r!z3 Arcade', state: 'Выбирает игру', largeImage: 'arcade_main' });
    expect(describePresence(ctx({ page: 'game', targetId: 'durak' }))).toMatchObject({ details: 'Дурак', state: 'Выбирает режим', largeImage: 'durak_main' });
    expect(describePresence(ctx({ page: 'game', targetId: 'future' }))).toMatchObject({ details: 'Будущая игра', state: 'Скоро в Arcade', largeImage: 'arcade_main' });
    expect(describePresence(ctx({ page: 'game', targetId: 'unknown-id' }))).toMatchObject({ details: 'r!z3 Arcade', state: 'В игровом клубе', largeImage: 'arcade_main' });
  });
  it('maps game selection to each game main asset', () => {
    for (const id of GAME_IDS) {
      const expected = games.find(g => g.id === id)!;
      expect(describePresence(ctx({ page: 'game', targetId: id }))).toMatchObject({ details: expected.name, largeImage: id + '_main' });
    }
  });
  it('maps lobby with party size and durak mode for every game', () => {
    for (const id of GAME_IDS) {
      const presence = describePresence(ctx({ page: 'room', room: room({ gameId: id, settings: id === 'durak' ? { mode: 'throw-in' } : {} }) }));
      expect(presence).toMatchObject({ state: 'Ожидает игроков', largeImage: id + '_lobby' });
      expect(presence?.party).toEqual({ id: 'arcade-room-room-1', size: [1, 4] });
    }
    const durak = describePresence(ctx({ page: 'room', room: room({ gameId: 'durak', settings: { mode: 'transfer' } }) }));
    expect(durak).toMatchObject({ details: 'Дурак · Переводной' });
  });
  it('maps active match to playing asset with real start timestamp for every game', () => {
    for (const id of GAME_IDS) {
      const presence = describePresence(ctx({ page: 'room', room: room({ gameId: id, phase: 'playing', matchId: 'm1' }), match: match({ gameId: id }) }));
      expect(presence).toMatchObject({ state: 'Идёт партия', largeImage: id + '_playing' });
      expect(presence?.startTimestamp).toBe(Date.parse('2026-11-11T12:00:00.000Z') / 1000);
      expect(presence?.endTimestamp).toBeUndefined();
    }
  });
  it('clamps party size on crowded rooms', () => {
    const crowded = room({ phase: 'playing', matchId: 'm1', members: Array.from({ length: 6 }, (_, i) => ({ player: { id: 'p' + i, name: 'P' + i, avatar: null }, ready: true })) });
    const presence = describePresence(ctx({ page: 'room', room: crowded, match: match() }));
    expect(presence?.party?.size).toEqual([4, 4]);
  });
  it('distinguishes victory, defeat, draw and neutral finish', () => {
    const playing = room({ phase: 'playing' });
    const won = match({ status: 'finished', result: { winners: ['p1'], losers: ['p2'], draw: false }, finishedAt: '2026-11-11T13:00:00.000Z' });
    const victory = describePresence(ctx({ page: 'room', room: playing, match: won }));
    expect(victory).toMatchObject({ state: 'Победа в партии', largeImage: 'arcade_victory' });
    expect(victory?.endTimestamp).toBe(Date.parse('2026-11-11T13:00:00.000Z') / 1000);
    const lost = match({ status: 'finished', result: { winners: ['p2'], losers: ['p1'], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: playing, match: lost }))).toMatchObject({ state: 'Поражение в партии', largeImage: 'arcade_defeat' });
    const draw = match({ status: 'finished', result: { winners: [], losers: [], draw: true } });
    expect(describePresence(ctx({ page: 'room', room: playing, match: draw }))).toMatchObject({ state: 'Ничья', largeImage: 'durak_main' });
    const neutral = match({ status: 'finished', result: { winners: [], losers: [], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: playing, match: neutral }))).toMatchObject({ state: 'Партия завершена', largeImage: 'durak_main' });
    const noResult = match({ status: 'interrupted', result: null });
    expect(describePresence(ctx({ page: 'room', room: playing, match: noResult }))).toMatchObject({ state: 'Партия завершена' });
  });
  it('shows the result after the room returns to waiting and clears it on a new match', () => {
    const waiting = room({ phase: 'waiting', matchId: null });
    const finished = match({ status: 'finished', result: { winners: ['p2'], losers: ['p1'], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: waiting, match: finished }))).toMatchObject({ state: 'Поражение в партии', largeImage: 'arcade_defeat' });
    const next = match({ matchId: 'm2', status: 'active', result: null });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing', matchId: 'm2' }), match: next }))).toMatchObject({ state: 'Идёт партия', largeImage: 'durak_playing' });
  });
  it('walks the full session: lobby → playing → victory/defeat → waiting result → new match → lobby', () => {
    const lobbyRoom = room({ phase: 'waiting', matchId: null });
    const playingRoom = room({ phase: 'playing', matchId: 'm1' });
    const active = match({ matchId: 'm1', status: 'active', result: null });
    // Lobby for every game uses its own lobby asset.
    for (const id of GAME_IDS) {
      expect(describePresence(ctx({ page: 'room', room: room({ gameId: id }), match: null }))?.largeImage).toBe(id + '_lobby');
      expect(describePresence(ctx({ page: 'room', room: room({ gameId: id, phase: 'playing', matchId: 'm1' }), match: match({ gameId: id }) }))?.largeImage).toBe(id + '_playing');
    }
    // Active match: playing asset + start timestamp, no result image yet.
    expect(describePresence(ctx({ page: 'room', room: playingRoom, match: active }))).toMatchObject({ state: 'Идёт партия', largeImage: 'durak_playing' });
    // Match finishes; the server flips the room back to waiting but keeps the
    // finished MatchView — the result must replace the playing state.
    const victory = match({ status: 'finished', result: { winners: ['p1', 'p2'], losers: ['p3'], draw: false }, finishedAt: '2026-11-11T13:00:00.000Z' });
    const afterWin = describePresence(ctx({ page: 'room', room: lobbyRoom, match: victory }));
    expect(afterWin).toMatchObject({ state: 'Победа в партии', largeImage: 'arcade_victory' });
    expect(afterWin?.startTimestamp).toBeUndefined();
    expect(afterWin?.endTimestamp).toBe(Date.parse('2026-11-11T13:00:00.000Z') / 1000);
    // Same flow for a defeat and a draw on another game.
    const defeat = match({ gameId: 'uno', status: 'finished', result: { winners: ['p2'], losers: ['p1'], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: room({ gameId: 'uno' }), match: defeat }))).toMatchObject({ state: 'Поражение в партии', largeImage: 'arcade_defeat' });
    const draw = match({ gameId: 'mafia', status: 'finished', result: { winners: [], losers: [], draw: true } });
    expect(describePresence(ctx({ page: 'room', room: room({ gameId: 'mafia' }), match: draw }))).toMatchObject({ state: 'Ничья', largeImage: 'mafia_main' });
    // A new match in the same room immediately replaces the old result.
    const rematch = match({ matchId: 'm2', status: 'active', result: null, createdAt: '2026-11-11T14:00:00.000Z' });
    expect(describePresence(ctx({ page: 'room', room: room({ phase: 'playing', matchId: 'm2' }), match: rematch }))).toMatchObject({ state: 'Идёт партия', largeImage: 'durak_playing' });
    // Leaving the room drops back to the shared arcade asset.
    expect(describePresence(ctx({ page: 'home', room: null, match: null }))).toMatchObject({ largeImage: 'arcade_main' });
  });
  it('ignores matches that belong to another room', () => {
    const foreign = match({ roomId: 'other-room', status: 'finished', result: { winners: ['p1'], losers: [], draw: false } });
    expect(describePresence(ctx({ page: 'room', room: room(), match: foreign }))).toMatchObject({ state: 'Ожидает игроков', largeImage: 'durak_lobby' });
  });
  it('falls back to arcade_main for unknown game ids', () => {
    const unknown = room({ gameId: 'sandbox', phase: 'playing', matchId: 'm1' });
    const presence = describePresence(ctx({ page: 'room', room: unknown, match: match({ gameId: 'sandbox' }) }));
    expect(presence).toMatchObject({ state: 'Идёт партия', largeImage: 'arcade_main' });
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
  it('converts PresenceActivity into the Discord SDK payload', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: 0 }));
    const manager = new PresenceManager(send, 0, 0);
    manager.update({
      details: 'UNO', state: 'Идёт партия', largeImage: 'uno_playing', largeText: 'UNO — идёт партия',
      party: { id: 'arcade-room-room-1', size: [3, 4] }, startTimestamp: 1762838400,
    });
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledWith({
      type: 0,
      details: 'UNO',
      state: 'Идёт партия',
      assets: { large_image: 'uno_playing', large_text: 'UNO — идёт партия' },
      party: { id: 'arcade-room-room-1', size: [3, 4] },
      timestamps: { start: 1762838400 },
    });
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
  it('handles rapid screen transitions without dropping the latest state', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ type: 0 }));
    const manager = new PresenceManager(send, 100, 10);
    manager.update({ details: 'A', largeImage: 'arcade_main' });
    manager.update({ details: 'B', largeImage: 'uno_main' });
    manager.update({ details: 'C', largeImage: 'mafia_lobby' });
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ details: 'C', assets: { large_image: 'mafia_lobby' } }));
    vi.useRealTimers();
  });
});

describe('presence assets', () => {
  it('declares every game stage asset plus shared assets, uniquely', () => {
    expect(PRESENCE_ASSET_KEYS).toHaveLength(18);
    expect(new Set(PRESENCE_ASSET_KEYS).size).toBe(PRESENCE_ASSET_KEYS.length);
    for (const shared of ['arcade_main', 'arcade_victory', 'arcade_defeat']) expect(PRESENCE_ASSET_KEYS).toContain(shared);
    for (const id of GAME_IDS) for (const stage of ['main', 'lobby', 'playing']) expect(PRESENCE_ASSET_KEYS).toContain(id + '_' + stage);
  });
});
