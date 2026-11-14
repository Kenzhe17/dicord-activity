import { useRef, useState } from 'react';
import { ArrowLeft, Coins, Copy, Lock, Users } from 'lucide-react';
import { Panel, Button } from '@rize/ui';
import type { GameInfo, RoomView, MatchView } from '@rize/shared';
import { useArcade } from '../store';
import { api, post, ApiError } from '../api';
import { Avatar } from './Avatar';
import { BalanceNote } from './BalanceNote';
import { DurakTable } from './DurakTable';
import { CodenamesTable } from './CodenamesTable';
export interface DiscordInviteActions { channel: () => Promise<string> }
export function Lobby({ games, run, busy, onLeft, discordInvite }: { games: GameInfo[]; run: (action: () => Promise<void>) => Promise<void>; busy: boolean; onLeft: () => void; discordInvite?: DiscordInviteActions | undefined }) {
  const { session, room, match, setRoom, setMatch } = useArcade();
  const [invite, setInvite] = useState('');
  const [notice, setNotice] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);
  if (!session || !room) return null;
  const game = games.find(g => g.id === room.gameId);
  const host = room.hostId === session.player.id;
  const ready = room.members.find(m => m.player.id === session.player.id)?.ready ?? false;
  const sandbox = match?.gameId === 'sandbox' ? match.state as { scores: Record<string, number>; turnId: string | null; winner: string | null; target: number } : null;
  async function refresh() { setRoom(await api('/rooms/' + room!.id)); }
  async function copyInvite() {
    setNotice('');
    try {
      await navigator.clipboard.writeText(invite);
      setNotice('Скопировано!');
      return;
    } catch { /* Clipboard API unavailable or denied — try selection fallback. */ }
    const field = codeRef.current;
    if (field) { field.focus(); field.select(); }
    try {
      if (field && document.execCommand('copy')) setNotice('Скопировано!');
      else setNotice('Не удалось скопировать автоматически — код выделен, нажмите Ctrl+C');
    } catch {
      setNotice('Буфер обмена недоступен — код выделен, скопируйте его вручную (Ctrl+C)');
    }
  }
  async function toggleReady() {
    const desired = !ready;
    let current = room!;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { setRoom(await post<RoomView>('/rooms/' + current.id + '/ready', { ready: desired, expectedVersion: current.version, requestId: crypto.randomUUID() })); return; }
      catch (error) {
        current = await api<RoomView>('/rooms/' + current.id); setRoom(current);
        if (!(error instanceof ApiError) || error.status !== 409 || attempt === 1 || current.phase === 'playing') throw error;
      }
    }
  }
  async function startMatch() { setMatch(await post<MatchView>('/rooms/' + room!.id + '/start', { requestId: crypto.randomUUID() })); await refresh(); }
  function leaveRoom() { void run(async () => { await api('/rooms/' + room!.id + '/membership', { method: 'DELETE' }); setRoom(null); setMatch(null); onLeft(); }); }
  const canStart = game?.status === 'ready' && room.members.length >= game.minPlayers && !room.members.some(m => !m.ready);
  return <section className={'room-screen' + (room.phase === 'playing' && room.gameId === 'durak' ? ' playing-durak' : '')}>
    <button className="text-button" disabled={busy || room.phase === 'playing'} onClick={leaveRoom}><ArrowLeft size={16}/>Покинуть комнату</button>
    <p className="eyebrow">ЛОББИ · {game?.name} {room.visibility === 'private' ? '· ПО ПРИГЛАШЕНИЮ' : ''}</p><h1>{room.name}</h1>
    <p className="subtitle">Ваш стол сохранён. После отключения можно вернуться в ту же партию.</p>
    {match?.gameId === 'codenames' && <CodenamesTable key={match.matchId} match={match} room={room} busy={busy} run={run} resultActions={match.status !== 'active' ? { ready, isHost: host, canStart, onToggleReady: () => void run(toggleReady), onStart: () => void run(startMatch), onLeave: leaveRoom } : undefined}/>}
    {match?.gameId === 'durak' && <DurakTable key={match.matchId} match={match} room={room} busy={busy} run={run} onForfeitExit={leaveRoom} resultActions={match.status !== 'active' ? { ready, isHost: host, canStart, onToggleReady: () => void run(toggleReady), onStart: () => void run(startMatch), onLeave: leaveRoom } : undefined}/>}
    {match && sandbox && <Panel className="match-panel"><div className="panel-heading"><h2>{match.status === 'finished' ? 'Партия завершена' : 'Испытательный стол'}</h2><span>Версия {match.version}</span></div><div className="score-grid">{room.members.map(m => <div className={sandbox.turnId === m.player.id ? 'score active-score' : 'score'} key={m.player.id}><span>{m.player.name}</span><strong>{sandbox.scores[m.player.id] ?? 0}</strong><small>из {sandbox.target}</small></div>)}</div>{match.status === 'finished' ? <p className="result-text">{match.result?.winners.includes(session.player.id) ? 'Вы победили' : 'Победитель: ' + (room.members.find(m => m.player.id === sandbox.winner)?.player.name ?? 'участник')} · Результат сохранён</p> : <><p>{sandbox.turnId === session.player.id ? 'Ваш ход' : 'Ходит ' + (room.members.find(m => m.player.id === sandbox.turnId)?.player.name ?? 'участник')}</p><div className="button-row">{([1, 2] as const).map(steps => <Button key={steps} disabled={busy || sandbox.turnId !== session.player.id} onClick={() => void run(async () => {
      const payload = { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: match.version, action: { type: 'advance', steps } };
      try { setMatch(await post<MatchView>('/matches/' + match.matchId + '/actions', payload)); }
      catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
    })}>Ход +{steps}</Button>)}</div></>}</Panel>}
    <details className="room-tools" open={room.phase !== 'playing'}><summary>Участники и приглашения</summary>
    <Panel><div className="panel-heading"><h2><Users size={18}/> За столом</h2><span>{room.members.length} / {room.maxPlayers}</span></div>
      {(() => { const stake = (room.settings as { stake?: number } | undefined)?.stake ?? 0; return stake > 0 ? <p className="stake-line"><Coins size={14}/> Ставка: <strong>{stake.toLocaleString('ru')} монет</strong> с каждого · банк при полном столе: <strong>{(stake * room.maxPlayers).toLocaleString('ru')}</strong> · сейчас: <strong>{(stake * room.members.length).toLocaleString('ru')}</strong></p> : null; })()}
      <BalanceNote stake={(room.settings as { stake?: number } | undefined)?.stake ?? 0}/>
      {room.members.map(member => <div className="member" key={member.player.id}><Avatar src={member.player.avatar} name={member.player.name} className="avatar"/><strong>{member.player.name}</strong><small>{member.player.id === room.hostId ? 'Хост' : member.connected ? 'В сети' : 'Отключён'}</small><span className={member.ready ? 'ready' : 'muted'}>{member.ready ? 'Готов' : 'Ожидает'}</span>{host && member.player.id !== room.hostId && <Button disabled={busy} onClick={() => void run(async () => setRoom(await post('/rooms/' + room.id + '/host', { targetId: member.player.id })))}>Передать хоста</Button>}</div>)}
      {room.phase !== 'playing' && <div className="button-row"><Button disabled={busy} onClick={() => void run(toggleReady)}>{ready ? 'Отменить готовность' : 'Я готов'}</Button>{host && game?.status === 'ready' && <Button disabled={busy || !canStart} onClick={() => void run(startMatch)}>Начать партию</Button>}</div>}
      {game?.status === 'planned' && <p className="foundation-note">Игра «Скоро»: лобби доступно, запуск партии появится после реализации и проверки движка.</p>}
    </Panel>
    <Panel><h2><Lock size={16}/> Приглашение</h2><p className="muted">{host ? 'Создайте приглашение на 24 часа. Новое приглашение отменяет предыдущее.' : 'Попросите хоста выдать приглашение друзьям.'}</p>{host && <Button disabled={busy} onClick={() => void run(async () => { setNotice(''); setInvite((await post<{ code: string }>('/rooms/' + room.id + '/invite')).code); })}>Создать приглашение</Button>}{invite && <div className="invite-panel"><input ref={codeRef} className="invite-code" readOnly value={invite} onFocus={event => event.currentTarget.select()} aria-label="Код приглашения"/><div className="invite-actions">{discordInvite && <Button disabled={busy} onClick={() => void run(async () => setNotice(await discordInvite.channel()))}>Пригласить в канал</Button>}<Button onClick={() => void copyInvite()}><Copy size={14}/> Копировать код</Button></div></div>}{notice && <p className="invite-notice" role="status">{notice}</p>}</Panel>
    {host && <button className="danger-button" disabled={busy || room.phase === 'playing'} onClick={() => void run(async () => { await api('/rooms/' + room.id, { method: 'DELETE' }); setRoom(null); setMatch(null); onLeft(); })}>Закрыть комнату</button>}
    </details>
  </section>;
}
