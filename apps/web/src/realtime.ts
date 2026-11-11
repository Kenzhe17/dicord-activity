import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, RoomView, MatchView } from '@rize/shared';

type ArcadeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Diagnostic = { event: 'connected' | 'disconnected' | 'connect_error' | 'reconnect_attempt' | 'reconnect_failed' | 'subscribe_timeout' | 'subscribe_rejected' | 'synchronized'; attempt?: number; automatic?: boolean; reason?: string };
interface Handlers {
  connection: (status: string) => void;
  room: (room: RoomView) => void;
  match: (match: MatchView) => void;
  closed: () => void;
  error: (message: string) => void;
  diagnostic?: (event: Diagnostic) => void;
}
const disconnectReasons = new Set(['io server disconnect', 'io client disconnect', 'ping timeout', 'transport close', 'transport error', 'parse error']);

/** Binds one room to a non-connected socket. A reconnect always resubscribes;
 * game actions are never queued/replayed here. Diagnostics contain only allowlisted metadata. */
export function connectRoom(socket: ArcadeSocket, roomId: string, handlers: Handlers): () => void {
  const log = handlers.diagnostic ?? (event => console.info('[arcade:realtime]', JSON.stringify(event)));
  let disposed = false, generation = 0, acknowledged: RoomView | null = null, personal: MatchView | null = null, synchronized = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const clearRetry = () => { if (retry) clearTimeout(retry); retry = undefined; };
  const ready = () => {
    if (synchronized || !socket.connected || !acknowledged || acknowledged.matchId && personal?.matchId !== acknowledged.matchId) return;
    synchronized = true;
    log({ event: 'synchronized' });
    handlers.connection('Подключено');
  };
  const subscribe = (epoch: number) => {
    if (disposed || epoch !== generation || !socket.connected) return;
    // A subscription is safe to retry; volatile prevents buffering it across a disconnect.
    socket.volatile.timeout(5000).emit('room:subscribe', { roomId }, (error, reply) => {
      if (disposed || epoch !== generation || !socket.connected) return;
      if (error) {
        log({ event: 'subscribe_timeout' });
        handlers.connection('Синхронизация…');
        retry = setTimeout(() => subscribe(epoch), 1000);
      } else if (!reply.ok) {
        log({ event: 'subscribe_rejected' });
        handlers.error('Не удалось восстановить доступ к комнате. Войдите снова.');
        socket.disconnect();
      } else {
        acknowledged = reply.data;
        handlers.room(reply.data);
        ready();
      }
    });
  };
  const connected = () => {
    clearRetry(); generation++; acknowledged = null; personal = null; synchronized = false;
    log({ event: 'connected' });
    handlers.connection('Синхронизация…');
    subscribe(generation);
  };
  const disconnected = (reason: string) => {
    clearRetry(); generation++; acknowledged = null; personal = null; synchronized = false;
    log({ event: 'disconnected', automatic: socket.active, reason: disconnectReasons.has(reason) ? reason : 'other' });
    handlers.connection(socket.active ? 'Переподключение…' : 'Соединение закрыто');
    // Explicit server disconnects are still used for logout/revocation. Do not bypass them.
  };
  const failed = () => {
    log({ event: 'connect_error', automatic: socket.active });
    handlers.connection(socket.active ? 'Соединение недоступно' : 'Необходим повторный вход');
    if (!socket.active) handlers.error('Сессия недоступна. Войдите снова.');
  };
  const attempt = (value: number) => log({ event: 'reconnect_attempt', attempt: Number.isSafeInteger(value) && value > 0 ? value : 0 });
  const exhausted = () => { log({ event: 'reconnect_failed' }); handlers.connection('Соединение недоступно'); };
  const roomState = (value: RoomView) => { if (value.id === roomId) handlers.room(value); };
  const matchState = (value: MatchView) => { if (value.roomId === roomId) { personal = value; handlers.match(value); ready(); } };
  const closed = (value: { roomId: string }) => { if (value.roomId === roomId) handlers.closed(); };
  socket.on('connect', connected); socket.on('disconnect', disconnected); socket.on('connect_error', failed);
  socket.on('room:state', roomState); socket.on('match:state', matchState); socket.on('room:closed', closed);
  socket.io.on('reconnect_attempt', attempt); socket.io.on('reconnect_failed', exhausted);
  handlers.connection('Соединение…');
  socket.connect();
  return () => {
    disposed = true; generation++; clearRetry();
    socket.off('connect', connected); socket.off('disconnect', disconnected); socket.off('connect_error', failed);
    socket.off('room:state', roomState); socket.off('match:state', matchState); socket.off('room:closed', closed);
    socket.io.off('reconnect_attempt', attempt); socket.io.off('reconnect_failed', exhausted);
    socket.disconnect();
  };
}
