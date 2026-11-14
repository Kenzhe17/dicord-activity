import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BadgeCheck, Clock3, Crown, DoorOpen, HeartPulse, Menu, Moon, Send, Skull, Sunrise, Sun, Users, Vote, WifiOff } from 'lucide-react';
import type { MatchView, RoomView } from '@rize/shared';
import { Button } from '@rize/ui';
import { api, post } from '../api';
import { useArcade } from '../store';
import { Avatar } from './Avatar';
import { memberName, PACE_LABEL, PHASE_LABEL, ROLE_HINT, ROLE_LABEL, ROLE_TEAM } from './mafia/contracts';
import type { MafiaAction, MafiaChatChannel, MafiaRole, MafiaView } from './mafia/contracts';
import './mafia.css';

interface ResultActions { ready: boolean; isHost: boolean; canStart: boolean; onToggleReady: () => void; onStart: () => void; onLeave: () => void }

const ROLE_ICON: Record<MafiaRole, typeof Skull> = { mafia: Skull, town: Users, sheriff: BadgeCheck, doctor: HeartPulse };
const ROLE_TONE: Record<MafiaRole, string> = { mafia: 'mafia', town: 'town', sheriff: 'sheriff', doctor: 'doctor' };
const PHASE_ICON: Record<MafiaView['phase'], typeof Moon> = { reveal: Moon, night: Moon, dawn: Sunrise, discussion: Sun, voting: Vote, runoff: Vote, finished: Crown };
type NightAction = 'nightKill' | 'sheriffCheck' | 'doctorHeal';

function RoleBadge({ role, size = 13 }: { role: MafiaRole; size?: number }) {
  const Icon = ROLE_ICON[role];
  return <span className={'mafia-role mafia-role-' + ROLE_TONE[role]} title={ROLE_LABEL[role]}><Icon size={size}/>{ROLE_LABEL[role]}</span>;
}

export function MafiaTable({ match, room, busy, run, onForfeitExit, resultActions }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onForfeitExit: () => void; resultActions?: ResultActions | undefined }) {
  const { session, setMatch, preferences } = useArcade();
  const state = match.state as MafiaView;
  const [clock, setClock] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [channel, setChannel] = useState<MafiaChatChannel>('town');
  const [draft, setDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, []);
  // Reset transient UI only on phase/status changes — NOT on every match.version
  // bump (chat messages, timer persists, other players' actions). Otherwise an
  // in-progress night target or chat draft is wiped by unrelated updates.
  const resetKey = match.status + '|' + state.phase + '|' + state.night + '|' + state.day;
  useEffect(() => { setConfirming(false); setMenuOpen(false); setTarget(null); setDraft(''); }, [resetKey]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }); }, [state.chat.town.length, state.chat.mafia.length, state.chat.dead.length, channel]);

  const ownId = session?.player.id ?? '', you = state.you, ownSeat = you.seat;
  const ended = match.status !== 'active';
  const time = Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const timeUp = state.deadline > 0 && time === 0 && !ended;
  const nightActionType: NightAction | null = you.abilities.canNightKill ? 'nightKill' : you.abilities.canSheriffCheck ? 'sheriffCheck' : you.abilities.canDoctorHeal ? 'doctorHeal' : null;
  const nightDone = nightActionType === 'nightKill' ? you.nightAction.kill !== null : nightActionType === 'sheriffCheck' ? you.nightAction.check !== null : nightActionType === 'doctorHeal' ? you.nightAction.heal !== null : false;

  const seatByIndex = (seat: number) => state.players.find(p => p.seat === seat);
  const nameOfSeat = (seat: number | null | undefined) => seat === null || seat === undefined ? '—' : memberName(room, seatByIndex(seat)?.id);
  const nightEligible = (seat: number) => {
    const p = seatByIndex(seat);
    if (!p?.alive) return false;
    if (nightActionType === 'nightKill') return seat !== ownSeat && p.role !== 'mafia';
    if (nightActionType === 'sheriffCheck') return seat !== ownSeat;
    return true;
  };
  const pickNight = (seat: number) => { if (busy || nightDone || !nightEligible(seat)) return; setTarget(t => t === seat ? null : seat); };

  const voteSeats = state.phase === 'runoff' && state.runoff ? state.runoff.filter(s => s !== ownSeat) : state.players.filter(p => p.alive && p.seat !== ownSeat).map(p => p.seat);
  const canPickVote = !ended && you.abilities.canVote;
  const vote = (seat: number | 'skip') => { if (!canPickVote || busy) return; void act({ type: 'vote', target: seat }); };

  const act = (action: MafiaAction) => run(async () => {
    const send = (version: number) => post<MatchView>('/matches/' + match.matchId + '/actions', { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: version, action });
    try {
      const value = await send(match.version);
      setTarget(null); setMatch(value);
    } catch (error) {
      const fresh = await api<MatchView>('/matches/' + match.matchId);
      setMatch(fresh);
      // Server-side timers can advance the version mid-click; retry once against
      // the fresh state — the server still validates the action itself.
      if (fresh.status === 'active' && fresh.version !== match.version) {
        try {
          const value = await send(fresh.version);
          setTarget(null); setMatch(value);
          return;
        } catch { /* fall through and surface the original error */ }
      }
      throw error;
    }
  });
  const sendChat = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft('');
    void run(async () => {
      const payload = (version: number) => ({ protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: version, action: { type: 'chat' as const, channel, text: trimmed } });
      try { setMatch(await post<MatchView>('/matches/' + match.matchId + '/actions', payload(match.version))); }
      catch {
        const fresh = await api<MatchView>('/matches/' + match.matchId); setMatch(fresh);
        try { setMatch(await post<MatchView>('/matches/' + match.matchId + '/actions', payload(fresh.version))); }
        catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
      }
    });
  };

  const phase = state.phase;
  const PhaseIcon = PHASE_ICON[phase];
  const phaseLabel = phase === 'night' ? 'Ночь ' + state.night : phase === 'discussion' ? 'День ' + state.day : PHASE_LABEL[phase];
  const role = you.role.kind;
  const allies = role === 'mafia' ? (you.role.allies ?? []).map(seatByIndex).filter(Boolean) : [];
  const channels: { id: MafiaChatChannel; label: string }[] = you.alive && !you.forfeited
    ? [
      { id: 'town', label: 'Общий' },
      ...(you.abilities.canChatMafia ? [{ id: 'mafia' as const, label: 'Мафия' }] : []),
    ]
    : [{ id: 'dead', label: 'Выбывшие' }];
  const activeChannel = channels.some(c => c.id === channel) ? channel : channels[0]?.id ?? 'town';
  const messages = state.chat[activeChannel];
  const chatAllowed = activeChannel === 'town' ? you.abilities.canChatTown : activeChannel === 'mafia' ? you.abilities.canChatMafia : you.abilities.canChatDead;
  const feed = state.feed.slice(-6);
  const duration = match.createdAt && match.finishedAt ? Math.max(0, Math.round((Date.parse(match.finishedAt) - Date.parse(match.createdAt)) / 1000)) : null;
  const fmtDuration = (seconds: number) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const winnerText = match.status === 'interrupted' ? 'Партия прервана' : state.winner === 'town' ? 'Город победил' : state.winner === 'mafia' ? 'Мафия победила' : 'Ничья';
  const winnerSub = match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : state.winner === 'town' ? 'Мафия обезврежена.' : state.winner === 'mafia' ? 'Город не смог её вычислить.' : 'Три тихих цикла без потерь.';
  const pollRows = state.poll ? Object.entries(state.poll.counts).map(([seat, count]) => ({ seat: Number(seat), count })).sort((a, b) => b.count - a.count || a.seat - b.seat) : [];
  const nightHint = nightActionType === 'nightKill' ? 'Мафия: выберите цель — живого игрока не из мафии.' : nightActionType === 'sheriffCheck' ? 'Комиссар: проверьте любого живого игрока, кроме себя.' : nightActionType === 'doctorHeal' ? 'Доктор: выберите, кого лечить этой ночью.' : null;

  return <section className="mafia-game" aria-label="Партия в мафию" data-phase={phase} data-match-version={match.version}>
    <div className="mafia-topbar">
      <div className="mafia-topbar-info"><strong>Мафия</strong><span className="mafia-pace">{PACE_LABEL[state.pace]}</span><span className="mafia-phase"><PhaseIcon size={13}/>{phaseLabel}</span></div>
      <div className="mafia-topbar-actions">
        {state.deadline > 0 && !ended && <span className={'mafia-clock' + (time <= 10 ? ' urgent' : '')} role="timer" aria-label="Время до смены фазы"><Clock3 size={13}/>{time} c</span>}
        {!ended && <div className="game-menu-wrap" ref={menuRef}><Button aria-expanded={menuOpen} aria-label="Меню партии" onClick={() => setMenuOpen(o => !o)}><Menu size={14}/>Меню</Button>{menuOpen && <div className="game-menu" role="menu">
          <div className="game-menu-players">{state.players.map(p => { const member = room.members.find(m => m.player.id === p.id); return <div className="game-menu-player" key={p.id}><Avatar src={member?.player.avatar} name={memberName(room, p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar><div><strong>{memberName(room, p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{p.alive ? 'Жив' : 'Выбыл'}</small></div></div>; })}</div>
          <div className="game-menu-actions">{you.abilities.canForfeit && <Button className="danger-button" disabled={busy} onClick={() => confirming ? void act({ type: 'forfeit' }) : setConfirming(true)}>{confirming ? 'Точно покинуть партию?' : 'Покинуть партию'}</Button>}{you.forfeited && !ended && <Button onClick={onForfeitExit}><DoorOpen size={14}/>Покинуть комнату</Button>}</div>
        </div>}</div>}
      </div>
    </div>
    {ended ? <div className="mafia-result" role="status">
      <Crown size={26}/><h2>{winnerText}</h2>
      <p>{winnerSub}{duration !== null && ' · ' + fmtDuration(duration)} · дней {state.day} · ночей {state.night}</p>
      <div className="mafia-roster">{state.players.map(p => { const member = room.members.find(m => m.player.id === p.id); const role = p.role; const stats = state.stats?.find(s => s.seat === p.seat); return <div className={'mafia-roster-row' + (p.id === ownId ? ' mine' : '')} key={p.id}>
        <Avatar src={member?.player.avatar} name={memberName(room, p.id)} className="opponent-avatar"/>
        <div className="mafia-roster-main"><strong>{memberName(room, p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{p.alive ? 'Выжил' : 'Выбыл'}</small></div>
        {role && <RoleBadge role={role}/>}
        {stats && <div className="mafia-stats">{([['Лечений', stats.heals], ['Спасений', stats.saves], ['Проверок', stats.checks], ['Верных проверок', stats.checksCorrect], ['Точных голосов', stats.voteKills]] as const).map(([label, value]) => value > 0 ? <span key={label} title={label}>{value}<i>{label}</i></span> : null)}</div>}
      </div>; })}</div>
      {resultActions && <div className="button-row result-actions"><Button disabled={busy} onClick={resultActions.onToggleReady}>{resultActions.ready ? 'Отменить готовность' : 'Я готов — реванш'}</Button>{resultActions.isHost && <Button disabled={busy || !resultActions.canStart} onClick={resultActions.onStart}>Начать партию</Button>}<Button onClick={resultActions.onLeave}>Выйти в меню</Button></div>}
    </div> : <>
      <div className="mafia-scroll">
        <details className="mafia-rolecard" open={phase === 'reveal'}>
          <summary><RoleBadge role={role}/><span>{ROLE_TEAM[role]}</span></summary>
          <p>{ROLE_HINT[role]}</p>
          {allies.length > 0 && <p className="mafia-allies">Союзники: {allies.map(p => memberName(room, p?.id)).join(', ')}</p>}
          {role === 'sheriff' && you.sheriffResult && <p className="mafia-allies">Последняя проверка (ночь {you.sheriffResult.night}): {nameOfSeat(you.sheriffResult.target)} — {you.sheriffResult.isMafia ? 'МАФИЯ' : 'чист'}</p>}
        </details>
        {phase === 'night' && <div className="mafia-night-banner"><Moon size={15}/><span>Ночь. Не раскрывайте роли голосом — пишите только в игре.</span></div>}
        <div className="mafia-seats" role="list">
          {state.players.map(p => {
            const member = room.members.find(m => m.player.id === p.id);
            const selectable = nightActionType ? nightEligible(p.seat) : canPickVote && voteSeats.includes(p.seat);
            const picked = nightActionType ? target === p.seat : canPickVote && you.vote === p.seat;
            const voted = canPickVote && you.vote === p.seat;
            return <button type="button" key={p.id} role="listitem" className={'mafia-seat' + (p.alive ? '' : ' dead') + (p.seat === ownSeat ? ' own' : '') + (selectable ? ' pickable' : '') + (picked || voted ? ' picked' : '')} disabled={!selectable || busy}
              aria-pressed={picked || voted} onClick={() => nightActionType ? pickNight(p.seat) : vote(p.seat)}>
              <span className="mafia-seat-avatar"><Avatar src={member?.player.avatar} name={memberName(room, p.id)} className="opponent-avatar"/></span>
              <span className="mafia-seat-name">{memberName(room, p.id)}{p.id === ownId ? ' · вы' : ''}</span>
              <span className="mafia-seat-status">{p.alive ? (p.seat === ownSeat ? 'вы' : '') : 'выбыл'}</span>
              {p.role && <RoleBadge role={p.role} size={11}/>}
              {canPickVote && you.vote === p.seat && <Vote size={12}/>}
            </button>;
          })}
        </div>
        {phase === 'voting' || phase === 'runoff' ? <div className="mafia-votebar">
          <p>{phase === 'runoff' ? 'Повторное голосование — выбирайте только из равных кандидатов.' : 'Выберите, кого исключить из города.'}</p>
          {canPickVote && <Button disabled={busy || !canPickVote} onClick={() => vote('skip')}>Пропустить</Button>}
          {state.poll && <div className="mafia-poll">{state.poll.skips > 0 && <span className="mafia-poll-row skip"><em>Пропуск</em><b>{state.poll.skips}</b></span>}{pollRows.map(row => <span className="mafia-poll-row" key={row.seat}><em>{nameOfSeat(row.seat)}</em><b>{row.count}</b></span>)}</div>}
        </div> : null}
        {phase === 'dawn' && <p className="mafia-phase-note">{state.lastNight && state.lastNight.victim !== null ? 'Прошлой ночью погиб(ла) ' + nameOfSeat(state.lastNight.victim) + '.' : 'Ночь прошла тихо — жертв не было.'}</p>}
        {phase === 'discussion' && <p className="mafia-phase-note">День {state.day}. Обсуждайте наблюдения — роли пока скрыты.</p>}
        {phase === 'reveal' && <p className="mafia-phase-note">Роли розданы. Запомните свою и не показывайте её.</p>}
        <div className="mafia-feed" aria-label="Объявления ведущего">{feed.map(f => <p key={f.seq} className={'mafia-feed-item kind-' + f.kind}>{f.text}</p>)}</div>
        <div className="mafia-chat">
          <div className="mafia-chat-tabs" role="tablist">{channels.map(c => <button key={c.id} role="tab" aria-selected={activeChannel === c.id} className={activeChannel === c.id ? 'active' : ''} onClick={() => setChannel(c.id)}>{c.label}{c.id === 'mafia' && <Skull size={11}/>}</button>)}</div>
          <div className="mafia-chat-log" role="log" aria-live="polite">
            {messages.length === 0 && <p className="mafia-chat-empty">{activeChannel === 'mafia' ? 'Секретный чат мафии — только ночью.' : activeChannel === 'dead' ? 'Чат выбывших игроков.' : 'Общий чат города.'}</p>}
            {messages.map(m => <div className={'mafia-msg' + (m.seat === ownSeat ? ' mine' : '')} key={m.id}><strong>{nameOfSeat(m.seat)}</strong><span>{m.text}</span></div>)}
            <div ref={chatEndRef}/>
          </div>
          <form className="mafia-chat-form" onSubmit={event => { event.preventDefault(); sendChat(draft); }}>
            <input value={draft} onChange={event => setDraft(event.target.value)} maxLength={300} placeholder={chatAllowed ? 'Сообщение…' : 'Чат недоступен'} disabled={!chatAllowed || busy || ended} aria-label="Сообщение"/>
            <button type="submit" className="mafia-send" disabled={!chatAllowed || busy || ended || !draft.trim()} aria-label="Отправить"><Send size={16}/></button>
          </form>
        </div>
      </div>
      {nightActionType && !ended ? <div className="mafia-actionbar">
        <p className="mafia-action-hint">{nightDone ? 'Ваше действие принято. Ожидайте рассвета.' : nightHint}{target !== null && !nightDone ? ' · Цель: ' + nameOfSeat(target) : ''}</p>
        <Button disabled={busy || nightDone || target === null} onClick={() => { if (target !== null && nightActionType) void act({ type: nightActionType, target }); }}>Подтвердить</Button>
      </div> : phase === 'night' && !ended ? <div className="mafia-actionbar">
        <p className="mafia-action-hint">Ночь. Не раскрывайте роли голосом.</p>
      </div> : null}
    </>}
    {timeUp && !ended && <div className="mafia-timeup" role="status"><AnimatePresence><motion.p initial={preferences.reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}>Фаза сменяется…</motion.p></AnimatePresence></div>}
  </section>;
}
