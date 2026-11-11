import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, MatchView, RoomView, Reply } from '@rize/shared';
import { connectRoom } from './realtime';

const room: RoomView = { id: 'room', name: 'Room', gameId: 'durak', hostId: 'player', visibility: 'private', members: [], maxPlayers: 2, version: 1, settings: {}, matchId: 'match' };
const match: MatchView = { roomId: room.id, matchId: 'match', gameId: 'durak', status: 'active', version: 7, state: { hand: [1] }, result: null };
function setup() {
  const events = new EventEmitter(), manager = new EventEmitter();
  const acknowledgments: ((error: Error | null, reply: Reply<RoomView>) => void)[] = [];
  const socket = {
    connected: false, active: true, io: manager,
    on: events.on.bind(events), off: events.off.bind(events),
    connect() { this.connected = true; events.emit('connect'); },
    disconnect() { this.connected = false; this.active = false; events.emit('disconnect', 'io client disconnect'); },
    volatile: { timeout: () => ({ emit: (_event: string, _input: unknown, ack: typeof acknowledgments[number]) => { acknowledgments.push(ack); } }) },
  };
  const handlers = { room: vi.fn(), match: vi.fn(), closed: vi.fn(), connection: vi.fn(), error: vi.fn(), diagnostic: vi.fn() };
  const stop = connectRoom(socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>, room.id, handlers);
  return { events, manager, socket, acknowledgments, handlers, stop };
}
afterEach(() => vi.useRealTimers());
it.each(['ack-first', 'state-first'])('reports ready only after subscription acknowledgment AND personal state (%s)', order => {
  const s = setup();
  try {
    expect(s.handlers.connection).toHaveBeenLastCalledWith('Синхронизация…');
    if (order === 'ack-first') s.acknowledgments[0]!(null, { ok: true, data: room });
    else s.events.emit('match:state', match);
    expect(s.handlers.connection).not.toHaveBeenCalledWith('Подключено');
    s.events.emit('match:state', { ...match, roomId: 'another-room' });
    expect(s.handlers.connection).not.toHaveBeenCalledWith('Подключено');
    if (order === 'ack-first') s.events.emit('match:state', match);
    else s.acknowledgments[0]!(null, { ok: true, data: room });
    expect(s.handlers.connection).toHaveBeenLastCalledWith('Подключено');
    expect(s.handlers.match).toHaveBeenCalledWith(match);
  } finally { s.stop(); }
});
it('discards old acknowledgments/state on reconnect and does not log raw connection errors', () => {
  const s = setup();
  try {
    s.events.emit('match:state', match);
    s.socket.connected = false; s.events.emit('disconnect', 'transport close');
    s.events.emit('connect_error', new Error('private-token-in-error'));
    s.manager.emit('reconnect_attempt', 1);
    s.socket.connect();
    s.acknowledgments[0]!(null, { ok: true, data: room });
    expect(s.handlers.connection).not.toHaveBeenCalledWith('Подключено');
    s.acknowledgments[1]!(null, { ok: true, data: room });
    expect(s.handlers.connection).not.toHaveBeenCalledWith('Подключено');
    s.events.emit('match:state', { ...match, version: 8 });
    expect(s.handlers.connection).toHaveBeenLastCalledWith('Подключено');
    expect(JSON.stringify(s.handlers.diagnostic.mock.calls)).not.toContain('private-token-in-error');
    expect(s.handlers.diagnostic).toHaveBeenCalledWith({ event: 'reconnect_attempt', attempt: 1 });
  } finally { s.stop(); }
});
it('retries only a timed-out subscription and cancels pending retries on disposal', () => {
  vi.useFakeTimers();
  const s = setup();
  s.acknowledgments[0]!(new Error('private timeout details'), { ok: true, data: room });
  vi.advanceTimersByTime(1000);
  expect(s.acknowledgments).toHaveLength(2);
  s.acknowledgments[1]!(new Error('private timeout details'), { ok: true, data: room });
  s.stop(); vi.advanceTimersByTime(10000);
  expect(s.acknowledgments).toHaveLength(2);
  expect(s.manager.listenerCount('reconnect_attempt')).toBe(0);
  expect(JSON.stringify(s.handlers.diagnostic.mock.calls)).not.toContain('private timeout details');
});
