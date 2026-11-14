import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Clock3, Crown, Eye, Menu, Shield, Skull, Swords, Users, WifiOff } from 'lucide-react';
import type { MatchView, RoomView } from '@rize/shared';
import type { CodenamesAction, CodenamesView } from '@rize/codenames';
import { Button } from '@rize/ui';
import { api, post } from '../api';
import { useArcade } from '../store';
import { Avatar } from './Avatar';
import './codenames.css';

type Team = 'red' | 'blue';
type CardColor = 'red' | 'blue' | 'neutral' | 'assassin';
const TEAM_NAME: Record<Team, string> = { red: 'Красные', blue: 'Синие' };

/** Remaining own-card guesses for the active turn (official +1 rule). */
function attemptText(turn: { count: number; used: number } | null, ruleSet?: string): string {
  if (!turn) return '';
  if (ruleSet === 'unlimited' || turn.count === 0) return ' · попыток: без лимита';
  return ` · осталось ${Math.max(0, turn.count + 1 - turn.used)}`;
}

interface ResultActions { ready: boolean; isHost: boolean; canStart: boolean; onToggleReady: () => void; onStart: () => void; onLeave: () => void }

export function CodenamesTable({ match, room, busy, run, resultActions }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; resultActions?: ResultActions | undefined }) {
  const { session, setMatch, preferences } = useArcade();
  const state = match.state as CodenamesView;
  const ownId = session?.player.id ?? '';
  const [clock, setClock] = useState(Date.now());
  const [hintWord, setHintWord] = useState('');
  const [hintCount, setHintCount] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { setConfirming(false); setMenuOpen(false); setHintWord(''); }, [match.version, match.status]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);

  const act = (action: CodenamesAction) => run(async () => {
    try {
      const value = await post<MatchView>('/matches/' + match.matchId + '/actions', { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: match.version, action });
      setMatch(value);
    } catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
  });

  const memberName = (id: string | null | undefined) => room.members.find(m => m.player.id === id)?.player.name ?? 'Игрок';
  const memberAvatar = (id: string | null | undefined) => room.members.find(m => m.player.id === id)?.player.avatar ?? null;

  const me = state.me;
  const inGame = state.phase === 'hint' || state.phase === 'guess';
  const key = 'key' in state ? state.key : null;
  const intel = 'intel' in state ? state.intel : null;
  const boardRoles = 'boardRoles' in state ? state.boardRoles : null;
  const traitors = 'traitors' in state ? state.traitors : null;
  const ended = match.status !== 'active';
  const time = state.deadline === null ? null : Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const current = state.currentTeam as Team;
  const canHint = state.phase === 'hint' && me.team === current && me.role === 'spymaster' && !state.paused;
  const canGuess = state.phase === 'guess' && me.team === current && me.role === 'operative' && !state.paused;
  const canEnd = state.legalActions.some(a => a.type === 'endTurn');
  const pickable = new Set(state.legalActions.flatMap(a => a.type === 'pick' ? [a.index] : []));
  const modeLabel = state.traitorMode ? 'Предатель' : state.timed ? 'На время' : state.ruleSet === 'unlimited' ? 'Без лимита' : 'Классика';

  const reasonText = (reason: string | null): string => {
    switch (reason) {
      case 'all-own': return 'Команда ' + TEAM_NAME[state.winner ?? current] + ' открыла все свои слова';
      case 'all-enemy': return 'Все слова команды ' + TEAM_NAME[state.winner ?? current] + ' открыты — победа ' + TEAM_NAME[state.winner ?? current];
      case 'assassin': return 'Выпала карта убийцы — ' + TEAM_NAME[current] + ' проиграла';
      case 'surrender': return 'Команда сдалась';
      default: return 'Партия завершена';
    }
  };

  const cardColor = (index: number): CardColor | null => {
    if (boardRoles) return boardRoles[index] ?? null;
    const card = state.board[index];
    if (card?.revealed && card.color) return card.color;
    if (key) return key[index] ?? null;
    if (intel && intel[index]) return intel[index] as CardColor;
    return null;
  };


  const choose = (team: Team | 'spectator', role?: 'spymaster' | 'operative') =>
    void act({ type: 'choose', team, ...(role ? { role } : {}) });

  return <section className="codenames-game" aria-label="Слова">
    <div className="codetop">
      <div className="codetop-info"><strong>Слова</strong><span className="codetop-mode">{modeLabel}</span></div>
      <div className="codetop-scores">
        <span className={'score-chip red' + (inGame && current === 'red' ? ' active' : '')}><i/>Красные · {state.remaining.red}</span>
        <span className={'score-chip blue' + (inGame && current === 'blue' ? ' active' : '')}><i/>Синие · {state.remaining.blue}</span>
      </div>
      <div className="codetop-tools">
        {time !== null && !ended && <span className={'turn-clock' + (time <= 10 ? ' urgent' : '')} role="timer"><Clock3 size={13}/>{time} c</span>}
        {!ended && <div className="game-menu-wrap" ref={menuRef}>
          <Button aria-expanded={menuOpen} aria-label="Меню партии" onClick={() => setMenuOpen(o => !o)}><Menu size={14}/>Меню</Button>
          {menuOpen && <div className="game-menu" role="menu">
            <div className="game-menu-players">
              {(['red', 'blue'] as const).map(team => <div key={team}>
                <p className="game-menu-team">{TEAM_NAME[team]}</p>
                {state.teams[team].members.map(id => {
                  const member = room.members.find(m => m.player.id === id);
                  return <div className="game-menu-player" key={id}>
                    <Avatar src={member?.player.avatar} name={memberName(id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar>
                    <div><strong>{memberName(id)}{id === ownId ? ' (вы)' : ''}</strong><small>{id === state.teams[team].spymasterId ? 'Руководитель' : 'Отгадывающий'}{traitors && traitors[team] === id ? ' · предатель' : ''}</small></div>
                  </div>;
                })}
              </div>)}
              {state.spectators.length > 0 && <div><p className="game-menu-team">Наблюдатели</p>{state.spectators.map(id => <div className="game-menu-player" key={id}><Avatar src={memberAvatar(id)} name={memberName(id)} className="opponent-avatar"/><div><strong>{memberName(id)}</strong><small>Смотрит</small></div></div>)}</div>}
            </div>
            <div className="game-menu-actions">
              {state.phase !== 'draft' && me.team !== 'spectator' && <Button className="danger-button" disabled={busy || confirming} onClick={() => confirming ? void act({ type: 'surrender' }) : setConfirming(true)}>{confirming ? 'Точно сдаться? Партия завершится' : 'Сдаться'}</Button>}
            </div>
          </div>}
        </div>}
      </div>
    </div>

    {state.phase === 'draft' ? <div className="codetab codetab-draft">
      <p className="eyebrow">КОМАНДЫ И РОЛИ</p>
      <h2>Распределитесь по командам</h2>
      <p className="muted">В каждой команде нужен один руководитель и хотя бы один отгадывающий{state.traitorMode ? '. В режиме предателя — минимум 3 игрока в команде' : ''}. Остальные могут наблюдать.</p>
      {(['red', 'blue'] as const).map(team => {
        const members = state.teams[team].members;
        return <div className={'draft-team ' + team} key={team}>
          <h3>{TEAM_NAME[team]}{state.teams[team].spymasterId ? ' · руководитель: ' + memberName(state.teams[team].spymasterId) : ''}</h3>
          <div className="draft-members">
            {members.length === 0 && <span className="muted">пока пусто</span>}
            {members.map(id => <span className="draft-member" key={id}><Avatar src={memberAvatar(id)} name={memberName(id)} className="opponent-avatar"/>{memberName(id)}{state.teams[team].spymasterId === id ? ' ★' : ''}</span>)}
          </div>
          {me.team !== team && <div className="button-row">
            <Button disabled={busy} onClick={() => choose(team, 'operative')}>{me.team === team ? '' : 'В ' + TEAM_NAME[team].toLowerCase()}</Button>
            <Button disabled={busy || state.teams[team].spymasterId !== null} onClick={() => choose(team, 'spymaster')}>Стать руководителем</Button>
          </div>}
        </div>;
      })}
      <div className="button-row">
        {me.team !== 'spectator' && <Button disabled={busy} onClick={() => choose('spectator')}>Наблюдать</Button>}
        {me.isHost && <Button disabled={busy || !state.canStart} onClick={() => void act({ type: 'start' })}>Начать партию</Button>}
      </div>
      {state.startBlockReason && me.isHost && <p className="codereason">{state.startBlockReason}</p>}
      {!me.isHost && <p className="muted">Организатор: {memberName(room.hostId)} — ждём его старта.</p>}
    </div> : <>
      <div className="codemid">
        <div className={'turn-banner ' + current} role="status">
          {state.turn ? <><strong>{TEAM_NAME[current]}</strong><span>подсказка: <b>«{state.turn.word}» — {state.turn.count === 0 ? '0 (без счёта)' : state.turn.count}</b>{attemptText(state.turn, state.ruleSet)}</span></> : <><strong>{TEAM_NAME[current]}</strong><span>задают подсказку</span></>}
        </div>
        {state.history.length > 0 && <div className="codehistory" aria-label="История подсказок">
          {state.history.slice(-4).map((h, i) => <span key={i} className={'history-chip ' + h.team}>{TEAM_NAME[h.team as Team]}: {h.word} — {h.count}{h.outcome === 'timeout' ? ' ⏱' : ''}</span>)}
        </div>}
        {canHint && <form className="codehint-form" onSubmit={event => { event.preventDefault(); if (hintWord.trim() && hintCount >= 0) void act({ type: 'hint', word: hintWord, count: hintCount }); }}>
          <label>Ваша подсказка<input value={hintWord} onChange={e => setHintWord(e.target.value)} maxLength={30} placeholder="Одно слово" autoComplete="off"/></label>
          <label>Число<input type="number" min={0} max={9} value={hintCount} onChange={e => setHintCount(Math.max(0, Math.min(9, Number(e.target.value) || 0)))} inputMode="numeric" title="0 — неограниченные попытки"/></label>
          <Button type="submit" disabled={busy || !hintWord.trim()}>Отправить</Button>
        </form>}
        {canGuess && <p className="codemid-note"><Swords size={13}/> Нажимайте на слова — хотя бы одна попытка обязательна.{attemptText(state.turn, state.ruleSet)}</p>}
        {canEnd && <div className="button-row codeend"><Button disabled={busy} onClick={() => void act({ type: 'endTurn' })}>Завершить ход</Button></div>}
      </div>
      <div className="codeboard" role="grid" aria-label="Игровое поле">
        {state.board.map(card => {
          const color = cardColor(card.index);
          const revealed = card.revealed;
          const secretMark = revealed ? null : color;
          return <motion.button
            key={card.index}
            type="button"
            role="gridcell"
            className={'codecard' + (revealed ? ' revealed ' + (card.color ?? 'neutral') : '') + (pickable.has(card.index) ? ' pickable' : '') + (!revealed && key && color ? ' keyed ' + color : '') + (!revealed && intel && color ? ' intel ' + color : '')}
            disabled={busy || !pickable.has(card.index)}
            onClick={() => { if (pickable.has(card.index)) void act({ type: 'pick', index: card.index }); }}
            initial={preferences.reducedMotion || !revealed ? false : { scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            aria-label={card.word + (revealed ? ' — открыто' : '')}
          >
            <span className="codecard-word">{card.word}</span>
            {revealed && <span className="codecard-color" aria-hidden="true">{card.color === 'assassin' ? <Skull size={14}/> : card.color === 'neutral' ? <Eye size={14}/> : <Shield size={14}/>}</span>}
            {!revealed && secretMark === 'assassin' && <Skull size={13} className="codecard-mark" aria-label="Убийца"/>}
          </motion.button>;
        })}
      </div>
      {me.role === 'spymaster' && inGame && <p className="codelegend"><Eye size={12}/> Вы видите ключ: красные и синие поля — слова команд, серые — нейтральные, череп — убийца.</p>}
      {me.isTraitor && inGame && <p className="codelegend traitor"><Skull size={12}/> Вы — предатель. Видны только карты соперника и убийца. Ваша цель — помочь им проиграть.</p>}
    </>}

    {ended ? <div className="codeboard-result" role="status">
      <Crown size={26}/>
      <h2>{match.status === 'interrupted' ? 'Партия прервана' : state.winner ? TEAM_NAME[state.winner] + ' — победа' : 'Партия завершена'}</h2>
      <p>{match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : reasonText(state.endReason)}</p>
      {state.traitorMode && traitors && <p className="codereason">Предатели: {traitors.red ? memberName(traitors.red) + ' (красные)' : '—'} · {traitors.blue ? memberName(traitors.blue) + ' (синие)' : '—'}</p>}
      <div className="result-standings">
        {(['red', 'blue'] as const).map(team => <div className={'result-standing' + (state.winner === team ? ' winner' : '')} key={team}>
          <strong>{TEAM_NAME[team]}</strong>
          <small>{state.teams[team].members.map(memberName).join(', ') || '—'}</small>
        </div>)}
      </div>
      {resultActions && <div className="button-row result-actions">
        <Button disabled={busy} onClick={resultActions.onToggleReady}>{resultActions.ready ? 'Отменить готовность' : 'Я готов — реванш'}</Button>
        {resultActions.isHost && <Button disabled={busy || !resultActions.canStart} onClick={resultActions.onStart}>Начать партию</Button>}
        <Button onClick={resultActions.onLeave}>Выйти в меню</Button>
      </div>}
    </div> : null}
    <div className="codefoot muted"><Users size={12}/>{state.teams.red.members.length + state.teams.blue.members.length} в командах · {state.spectators.length} наблюдателей · ход {state.turnCount}</div>
  </section>;
}
