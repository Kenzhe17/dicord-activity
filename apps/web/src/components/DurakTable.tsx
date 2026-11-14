import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Clock3, Shield, Crown, WifiOff, Menu, DoorOpen, Coins } from 'lucide-react';
import type { MatchView, RoomView } from '@rize/shared';
import { Button } from '@rize/ui';
import { rank } from '@rize/durak/cards';
import { api, post } from '../api';
import { useArcade } from '../store';
import { PlayingCard, playingCardLabel } from './PlayingCard';
import { Avatar } from './Avatar';
import { DurakHand } from './durak/DurakHand';
import { useDurakFx, DurakFxLayer } from './durak/durakFx';
import { DurakSeat } from './durak/DurakSeat';
import { playDurakSound, unlockDurakAudio } from './durak/durakSound';
import { seatOf, type DurakAction, type DurakView } from './durak/contracts';
import { DURAK_SORT_MODES, loadDurakSort, saveDurakSort } from './durakSort';
import type { DurakSortMode } from './durakSort';
import './durak.css';

interface ResultActions { ready: boolean; isHost: boolean; canStart: boolean; onToggleReady: () => void; onStart: () => void; onLeave: () => void; onCloseRoom?: (() => void) | undefined }
const SORT_LABELS: Record<DurakSortMode, string> = { suit: 'По мастям', rank: 'По достоинству', received: 'Как получены' };
export function DurakTable({ match, room, busy, run, onForfeitExit, resultActions }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onForfeitExit: () => void; resultActions?: ResultActions | undefined }) {
  const { session, setMatch, preferences } = useArcade();
  const state = match.state as DurakView;
  const fx = useDurakFx();
  useEffect(() => { fx.observe(state, match.version); });
  const [selected, setSelected] = useState<number[]>([]), [target, setTarget] = useState<number | null>(null), [clock, setClock] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const [sortMode, setSortMode] = useState<DurakSortMode>(() => loadDurakSort());
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { setConfirming(false); setMenuOpen(false); setSelected([]); setTarget(null); }, [match.version, match.status]);
  useEffect(() => {
    const unlock = () => unlockDurakAudio();
    document.addEventListener('pointerdown', unlock, { once: true });
    return () => document.removeEventListener('pointerdown', unlock);
  }, []);
  const ownId = session?.player.id ?? '', ownSeat = seatOf(state, ownId);
  const choices = state.legalActions;
  const picked = selected.filter(c => state.hand.includes(c));
  const valid = choices.filter(a => 'cards' in a ? a.cards.length === picked.length && a.cards.every(c => picked.includes(c)) : a.type === 'defend' ? picked.length === 1 && picked[0] === a.card && target === a.target : true);
  const playable = new Set<number>(choices.flatMap(a => 'cards' in a ? a.cards : a.type === 'defend' ? [a.card] : []));
  const defendChoices = choices.filter((a): a is Extract<DurakAction, { type: 'defend' }> => a.type === 'defend');
  const memberName = (id: string | null) => room.members.find(m => m.player.id === id)?.player.name ?? 'Игрок';
  const time = Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const ended = match.status !== 'active';
  const ownOut = state.players.find(p => p.id === ownId)?.out ?? false;
  const ownTurn = state.actorId === ownId && !ended && !state.paused;
  const finishSounded = useRef<string | null>(null);
  useEffect(() => {
    if (!ended || match.status === 'interrupted') return;
    const key = match.matchId + ':' + match.version;
    if (finishSounded.current === key) return;
    finishSounded.current = key;
    const losers = match.result?.losers ?? [];
    if (losers.includes(ownId)) playDurakSound('lose');
    else if (match.result?.draw || (match.result?.winners.length ?? 0) > 0) playDurakSound('win');
  }, [ended, match, ownId]);
  const prevActor = useRef<string | null>(null);
  useEffect(() => {
    if (ended || state.paused) { prevActor.current = state.actorId; return; }
    if (prevActor.current !== null && prevActor.current !== state.actorId) playDurakSound('turn');
    prevActor.current = state.actorId;
  }, [state.actorId, state.paused, ended]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);
  const act = (action: DurakAction) => run(async () => {
    const send = (version: number) => post<MatchView>('/matches/' + match.matchId + '/actions', { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: version, action });
    try {
      const value = await send(match.version);
      setSelected([]); setTarget(null); setMatch(value);
    } catch (error) {
      const fresh = await api<MatchView>('/matches/' + match.matchId);
      setMatch(fresh);
      // Server-side timers can advance the version mid-click; retry once against
      // the fresh state — the server still validates the action itself.
      if (fresh.status === 'active' && fresh.version !== match.version) {
        try {
          const value = await send(fresh.version);
          setSelected([]); setTarget(null); setMatch(value);
          return;
        } catch { /* fall through and surface the original error */ }
      }
      throw error;
    }
  });
  const button = (type: DurakAction['type'], label: string) => {
    if (!choices.some(a => a.type === type)) return null;
    const action = valid.find(a => a.type === type);
    return <Button key={type} disabled={busy || !action} onClick={() => { if (action) void act(action); }}>{label}</Button>;
  };
  const isGroupCard = (card: number) => choices.some(a => 'cards' in a && a.cards.includes(card));
  const freePick = state.phase === 'throwing' || state.phase === 'taking';
  const toggleCard = (card: number) => {
    if (!state.hand.includes(card)) return;
    setSelected(prev => {
      const cur = prev.filter(c => state.hand.includes(c));
      if (freePick) return cur.includes(card) ? cur.filter(c => c !== card) : [...cur, card];
      if (!isGroupCard(card)) return cur.length === 1 && cur[0] === card ? [] : [card];
      if (cur.includes(card)) return cur.filter(c => c !== card);
      const r = rank(card);
      return [...cur.filter(c => rank(c) === r), card];
    });
  };
  const tapAttack = (attack: number, covered: boolean) => {
    if (covered || busy || !choices.some(a => a.type === 'defend')) return;
    setTarget(t => t === attack ? null : attack);
  };
  const dropCard = (card: number, targetAttack: number | null) => {
    if (!state.hand.includes(card)) return;
    if (targetAttack !== null) {
      const defend = defendChoices.find(a => a.card === card && a.target === targetAttack);
      if (defend) { setSelected([card]); setTarget(targetAttack); void act(defend); return; }
    }
    const single = choices.find(a => 'cards' in a && a.cards.length === 1 && a.cards[0] === card);
    if (single) { setSelected([card]); setTarget(null); void act(single); return; }
    const defend = defendChoices.find(a => a.card === card);
    if (defend) { setSelected([card]); setTarget(defend.target); void act(defend); }
  };
  const throwSingles = choices.filter(a => a.type === 'throw' && 'cards' in a && a.cards.length === 1);
  const canThrowPicked = picked.length > 0 && state.table.length + picked.length <= state.limit && picked.every(c => throwSingles.some(a => 'cards' in a && a.cards[0] === c));
  const clearPick = () => { setSelected([]); setTarget(null); };
  const changeSort = (mode: DurakSortMode) => { setSortMode(mode); saveDurakSort(mode); };
  const opponents = state.players.map((p, seat) => ({ p, seat })).filter(({ p }) => p.id !== ownId);
  const duration = match.createdAt && match.finishedAt ? Math.max(0, Math.round((Date.parse(match.finishedAt) - Date.parse(match.createdAt)) / 1000)) : null;
  const fmtDuration = (seconds: number) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const standings = [...state.players].sort((a, b) => Number(a.out) - Number(b.out) || (match.result?.winners.includes(b.id) ? 1 : 0) - (match.result?.winners.includes(a.id) ? 1 : 0));
  const statusOf = (id: string, out: boolean, forfeited: boolean) => match.result?.draw ? 'Ничья' : match.result?.winners.includes(id) ? 'Победитель' : forfeited ? 'Сдался' : out ? 'Проиграл' : '—';
  return <section className="durak-game" aria-label="Игровой стол Дурака" data-phase={state.phase} data-match-version={match.version}>
    {ended ? <div className="durak-result" role="status">
      <Crown size={26}/><h2>{match.status === 'interrupted' ? 'Партия прервана' : state.result?.draw ? 'Ничья' : state.forfeited ? 'Вы сдались' : state.result?.losers.includes(ownId) ? 'Вы остались с картами' : state.result?.winners.includes(ownId) ? 'Победа!' : 'Партия без поражения'}</h2>
      <p>{match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : 'Результат сохранён · рейтинговые очки не изменяются'}{duration !== null && ' · ' + fmtDuration(duration)}</p>
      <div className="result-standings">{standings.map(p => <div className={'result-standing' + (match.result?.winners.includes(p.id) ? ' winner' : '')} key={p.id}><Avatar src={room.members.find(m => m.player.id === p.id)?.player.avatar} name={memberName(p.id)} className="opponent-avatar"/><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{statusOf(p.id, p.out, p.forfeited)}</small></div>)}</div>
      {match.stakes && <div className="stake-payouts">
        <p className="stake-payouts-title"><Coins size={13}/> Банк {match.stakes.pool.toLocaleString('ru')} монет · {match.stakes.settlement === 'settled' ? 'выплачено' : match.stakes.settlement === 'pending' ? 'выплата обрабатывается' : match.stakes.settlement === 'refunded' ? 'ставки возвращены' : 'выплата не выполнена'}{match.stakes.payouts.some(p => (p.overflow ?? 0) > 0) ? ' · часть выигрыша превысила лимит баланса и не начислена' : ''}</p>
        {match.stakes.payouts.map(p => <div className={'stake-payout' + (p.playerId === ownId ? ' mine' : '')} key={p.playerId}><span>{memberName(p.playerId)}{p.playerId === ownId ? ' (вы)' : ''}</span><strong>+{p.amount.toLocaleString('ru')}</strong></div>)}
      </div>}
      {resultActions && <div className="button-row result-actions"><Button disabled={busy} onClick={resultActions.onToggleReady}>{resultActions.ready ? 'Отменить готовность' : 'Я готов — реванш'}</Button>{resultActions.isHost && <Button disabled={busy || !resultActions.canStart} onClick={resultActions.onStart}>Начать партию</Button>}{resultActions.isHost && resultActions.onCloseRoom && <Button className="danger-button" disabled={busy} onClick={resultActions.onCloseRoom}>Закрыть комнату</Button>}<Button onClick={resultActions.onLeave}>Выйти в меню</Button></div>}
    </div> : <>
      <div className="durak-felt" data-felt>
        <DurakFxLayer event={fx.event}/>
        <div className="durak-seats" role="list" aria-label="Соперники">
          {opponents.map(({ p, seat }) => {
            const member = room.members.find(m => m.player.id === p.id);
            return <DurakSeat key={p.id} view={state} seat={seat} ownSeat={ownSeat} memberName={memberName(p.id)} avatarUrl={member?.player.avatar ?? null} connected={member?.connected ?? false} position={{ x: 0, y: 0 }} isActor={state.actorId === p.id} isDefender={state.defenderId === p.id} isOut={p.out}/>;
          })}
        </div>
        <div className="battlefield" aria-label="Карты на столе">
          <div className="deck-zone"><div className="deck-stack">{state.deckCount > 0 && <div className="deck-back"><PlayingCard back/></div>}<div className="trump-indicator"><PlayingCard card={state.trumpCard}/></div></div></div>
          <AnimatePresence initial={false}>{state.table.map(pair => {
            const open = pair.defense === null && choices.some(a => a.type === 'defend');
            return <motion.div className={'card-pair' + (target === pair.attack ? ' targeted' : '') + (open ? ' open' : '')} key={pair.attack} initial={preferences.reducedMotion ? false : { opacity: 0, y: -25 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: state.lastEvent === 'pickup' ? 40 : -40 }}>
              <button type="button" className="table-card" aria-label={(open ? 'Цель защиты: ' : 'Карта атаки: ') + playingCardLabel(pair.attack)} aria-pressed={target === pair.attack} disabled={!open || busy} onClick={() => tapAttack(pair.attack, pair.defense !== null)} data-attack-card={pair.attack}><PlayingCard card={pair.attack}/></button>
              {pair.defense !== null && <motion.div className="defense-card" initial={preferences.reducedMotion ? false : { y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }}><PlayingCard card={pair.defense}/></motion.div>}
              {pair.defense !== null && <span className="covered-mark"><Shield size={11}/></span>}
            </motion.div>;
          })}</AnimatePresence>{!state.table.length && <div className="empty-table"><span className="table-diamond"/></div>}
        </div>
        <div className="durak-corner">
          {!ended && !state.paused && <span className={'turn-clock' + (time <= 10 ? ' urgent' : '')} role="timer" aria-label="Время хода"><Clock3 size={12}/>{time} c</span>}
          {state.table.length > 0 && <span className="round-label">{state.table.length}/{state.limit}</span>}
          {!ended && <div className="game-menu-wrap" ref={menuRef}><button type="button" className="durak-menu-btn" aria-expanded={menuOpen} aria-label="Меню партии" onClick={() => setMenuOpen(o => !o)}><Menu size={16}/></button>{menuOpen && <div className="game-menu" role="menu">
            <div className="durak-menu-sort" role="group" aria-label="Сортировка карт">{DURAK_SORT_MODES.map(mode => <button key={mode} type="button" className={sortMode === mode ? 'active' : ''} aria-pressed={sortMode === mode} onClick={() => changeSort(mode)}>{SORT_LABELS[mode]}</button>)}</div>
            <div className="game-menu-players">{state.players.map(p => { const member = room.members.find(m => m.player.id === p.id); return <div className="game-menu-player" key={p.id}><Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar><div><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{p.out ? 'Вышел' : p.id === state.defenderId ? 'Защищается' : p.count + ' карт'}</small></div></div>; })}</div>
            <p className="game-menu-rules">{state.mode === 'transfer' ? 'Переводной дурак: защищающийся может перевести атаку следующему игроку по кругу.' : 'Подкидной дурак: игроки могут подкидывать карты в пределах лимита.'} Козырь показан на столе.</p>
            <div className="game-menu-actions">{state.canSurrender && <Button className="danger-button" disabled={busy} onClick={() => confirming ? void act({ type: 'surrender' }) : setConfirming(true)}>{confirming ? 'Точно сдаться? Партия продолжится без вас' : 'Сдаться'}</Button>}{state.forfeited && !ended && <Button onClick={onForfeitExit}><DoorOpen size={14}/>Покинуть комнату</Button>}</div>
          </div>}</div>}
        </div>
        {state.paused && <div className="durak-paused" role="status">Пауза · ожидаем игроков</div>}
      </div>
      <div className="durak-handbar"><DurakHand cards={state.hand} trump={state.trump} playable={playable} selected={picked} disabled={busy || !ownTurn || ownOut} onToggle={toggleCard} onDropCard={dropCard} sortMode={sortMode} onSortMode={changeSort}/></div>
      <div className="durak-controls">{ownTurn ? <>{button('attack', 'Атаковать')}{button('defend', 'Защититься')}{button('transfer', 'Перевести')}{choices.some(a => a.type === 'throw') && <Button key="throw" disabled={busy || !canThrowPicked} onClick={() => { if (canThrowPicked) void act({ type: 'throw', cards: [...picked] }); }}>Подкинуть{picked.length > 1 ? ' ×' + picked.length : ''}</Button>}{button('take', 'Взять')}{button('pass', state.phase === 'taking' ? 'Не подкидывать' : 'Бито')}{(picked.length > 0 || target !== null) && <button type="button" className="text-button" onClick={clearPick}>Снять выбор</button>}</> : state.paused ? <p>Пауза · ожидаем игроков</p> : ownOut ? <p>{state.forfeited ? 'Вы сдались · наблюдайте за партией' : 'Вы вышли · наблюдайте за партией'}</p> : null}</div>
      {ownTurn && choices.some(a => a.type === 'defend') && <p className="card-hint">Карта в руке → карта атаки на столе → «Защититься»</p>}
    </>}
  </section>;
}
