import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Clock3, Shield, Crown, WifiOff, Menu, DoorOpen, Coins, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DurakView, DurakAction } from '@rize/durak';
import type { MatchView, RoomView } from '@rize/shared';
import { Button } from '@rize/ui';
import { api, post } from '../api';
import { Avatar } from './Avatar';
import { useArcade } from '../store';
import { PlayingCard, playingCardLabel } from './PlayingCard';
import { DURAK_SORT_MODES, loadDurakSort, saveDurakSort, sortDurakHand } from './durakSort';
import type { DurakSortMode } from './durakSort';
import './durak.css';

interface ResultActions { ready: boolean; isHost: boolean; canStart: boolean; onToggleReady: () => void; onStart: () => void; onLeave: () => void }
export function DurakTable({ match, room, busy, run, onForfeitExit, resultActions }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onForfeitExit: () => void; resultActions?: ResultActions | undefined }) {
  const { session, setMatch, preferences } = useArcade();
  const state = match.state as DurakView;
  const [selected, setSelected] = useState<number[]>([]), [target, setTarget] = useState<number | null>(null), [clock, setClock] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const [sortMode, setSortMode] = useState<DurakSortMode>(() => loadDurakSort());
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const menuRef = useRef<HTMLDivElement>(null), handRef = useRef<HTMLDivElement>(null), lastHandScroll = useRef(0), lastPointerType = useRef('');
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { setConfirming(false); setMenuOpen(false); }, [match.version, match.status]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);
  const sortedHand = useMemo(() => sortDurakHand(state.hand, sortMode, state.trump), [state.hand, sortMode, state.trump]);
  const updateScrollEdges = () => {
    const el = handRef.current;
    if (!el) return;
    setScrollEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    updateScrollEdges();
    const el = handRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateScrollEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sortedHand.length, sortMode, state.hand.length]);
  const scrollHand = (direction: -1 | 1) => {
    const el = handRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.75), behavior: 'smooth' });
  };
  const changeSort = (mode: DurakSortMode) => { setSortMode(mode); saveDurakSort(mode); };
  const ownId = session?.player.id ?? '', ownTurn = state.actorId === ownId;
  const choices = state.legalActions;
  const picked = selected.filter(c => state.hand.includes(c));
  const valid = choices.filter(a => 'cards' in a ? a.cards.length === picked.length && a.cards.every(c => picked.includes(c)) : a.type === 'defend' ? picked.length === 1 && picked[0] === a.card && target === a.target : true);
  const selectable = new Set(choices.flatMap(a => 'cards' in a ? a.cards : a.type === 'defend' ? [a.card] : []));
  const memberName = (id: string | null) => room.members.find(m => m.player.id === id)?.player.name ?? 'Игрок';
  const time = Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const ended = match.status !== 'active';
  const act = (action: DurakAction) => run(async () => {
    try {
      const value = await post<MatchView>('/matches/' + match.matchId + '/actions', { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: match.version, action });
      setSelected([]); setTarget(null); setMatch(value);
    } catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
  });
  const button = (type: DurakAction['type'], label: string) => {
    if (!choices.some(a => a.type === type)) return null;
    const action = valid.find(a => a.type === type);
    return <Button key={type} disabled={busy || !action} onClick={() => { if (action) void act(action); }}>{label}</Button>;
  };
  const opponents = state.players.filter(p => p.id !== ownId);
  const phaseName = state.paused ? 'Пауза · ожидаем игроков' : ended ? 'Партия завершена' : ownTurn ? state.phase === 'defending' ? 'Ваша защита' : state.phase === 'taking' ? 'Можно подкинуть берущему' : 'Ваш ход' : 'Ходит ' + memberName(state.actorId);
  const duration = match.createdAt && match.finishedAt ? Math.max(0, Math.round((Date.parse(match.finishedAt) - Date.parse(match.createdAt)) / 1000)) : null;
  const fmtDuration = (seconds: number) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const standings = [...state.players].sort((a, b) => Number(a.out) - Number(b.out) || (match.result?.winners.includes(b.id) ? 1 : 0) - (match.result?.winners.includes(a.id) ? 1 : 0));
  const statusOf = (id: string, out: boolean, forfeited: boolean) => match.result?.draw ? 'Ничья' : match.result?.winners.includes(id) ? 'Победитель' : forfeited ? 'Сдался' : out ? 'Проиграл' : '—';
  return <section className="durak-game" aria-label="Игровой стол Дурака" data-phase={state.phase} data-match-version={match.version}>
    <div className="durak-toolbar"><div><span className="eyebrow">R!Z3 CARD CLUB</span><h2>{state.mode === 'transfer' ? 'Переводной дурак' : 'Подкидной дурак'}</h2></div><div className="toolbar-actions"><span className="round-label">Розыгрыш {state.bout}</span>{match.stakes && <span className="round-label stake-tag" title="Банк партии"><Coins size={12}/>{match.stakes.perPlayer} · банк {match.stakes.pool.toLocaleString('ru')}</span>}{!ended && <div className="game-menu-wrap" ref={menuRef}><Button aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}><Menu size={14}/>Меню</Button>{menuOpen && <div className="game-menu" role="menu">
      <div className="game-menu-players">{state.players.map(p => { const member = room.members.find(m => m.player.id === p.id); return <div className="game-menu-player" key={p.id}><Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar><div><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{p.out ? 'Вышел' : p.id === state.defenderId ? 'Защищается' : p.count + ' карт'}</small></div></div>; })}</div>
      <p className="game-menu-rules">{state.mode === 'transfer' ? 'Переводной дурак: защищающийся может перевести атаку следующему игроку по кругу.' : 'Подкидной дурак: игроки могут подкидывать карты в пределах лимита.'} Козырь показан на столе.</p>
      <div className="game-menu-actions">{state.canSurrender && <Button className="danger-button" disabled={busy} onClick={() => confirming ? void act({ type: 'surrender' }) : setConfirming(true)}>{confirming ? 'Точно сдаться? Партия продолжится без вас' : 'Сдаться'}</Button>}{state.forfeited && !ended && <Button onClick={onForfeitExit}><DoorOpen size={14}/>Покинуть комнату</Button>}</div>
    </div>}</div>}</div></div>
    <div className="opponents">{opponents.map(p => {
      const member = room.members.find(m => m.player.id === p.id), active = state.actorId === p.id;
      return <div key={p.id} className={'opponent' + (active ? ' opponent-active' : '') + (p.out ? ' opponent-out' : '')}>
        <div className="opponent-identity"><Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={12}/>}</Avatar><div><strong>{memberName(p.id)}</strong><small>{p.out ? 'Вышел из игры' : p.id === state.defenderId ? 'Защищается' : active ? 'Ходит' : p.count + ' карт'}</small></div>{p.out && <Crown size={14}/>}</div>
        <div className="opponent-hand" aria-label={p.count + ' закрытых карт'}>{Array.from({ length: Math.min(6, p.count) }, (_, i) => <span key={i} style={{ transform: 'rotate(' + (i - Math.min(6, p.count) / 2) * 6 + 'deg)' }}><PlayingCard back/></span>)}<b>{p.count}</b></div>
      </div>;
    })}</div>
    <div className="felt-table">
      <div className="table-watermark" aria-hidden="true">r!z3<span>ARCADE CARD SOCIETY</span></div>
      <div className="deck-zone"><div className="deck-stack">{state.deckCount > 0 && <div className="deck-back"><PlayingCard back/></div>}<div className="trump-indicator"><PlayingCard card={state.trumpCard}/></div></div><span>Козырь · {state.deckCount} в колоде</span><small>В отбое: {state.discardCount}</small></div>
      <div className="battlefield" aria-label="Карты на столе"><AnimatePresence initial={false}>{state.table.map(pair => {
        const canTarget = choices.some(a => a.type === 'defend' && picked[0] === a.card && a.target === pair.attack);
        return <motion.div className={'card-pair' + (target === pair.attack ? ' targeted' : '')} key={pair.attack} initial={preferences.reducedMotion ? false : { opacity: 0, y: -25 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: state.lastEvent === 'pickup' ? 40 : -40 }}>
          <button className="table-card" aria-label={'Покрыть: ' + playingCardLabel(pair.attack)} disabled={!canTarget || busy} onClick={() => setTarget(pair.attack)} data-target-card={pair.attack}><PlayingCard card={pair.attack}/></button>
          {pair.defense !== null && <motion.div className="defense-card" initial={preferences.reducedMotion ? false : { y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }}><PlayingCard card={pair.defense}/></motion.div>}
          {pair.defense !== null && <span className="covered-mark"><Shield size={11}/></span>}
        </motion.div>;
      })}</AnimatePresence>{!state.table.length && !ended && <div className="empty-table"><span className="table-diamond"/><p>{ownTurn ? 'Выберите карту для атаки' : 'Ожидаем первую карту'}</p></div>}</div>
      <div className="table-status"><span className={ownTurn ? 'turn-light active' : 'turn-light'}/><strong role="status">{phaseName}</strong>{!ended && !state.paused && <span className={'turn-clock' + (time <= 10 ? ' urgent' : '')}><Clock3 size={14}/>{time} c</span>}<small>{state.table.length} / {state.limit} атак</small></div>
    </div>
    {ended ? <div className="durak-result" role="status">
      <Crown size={30}/><h2>{match.status === 'interrupted' ? 'Партия прервана' : state.result?.draw ? 'Ничья' : state.forfeited ? 'Вы сдались' : state.result?.losers.includes(ownId) ? 'Вы остались с картами' : state.result?.winners.includes(ownId) ? 'Победа!' : 'Партия без поражения'}</h2>
      <p>{match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : 'Результат сохранён · рейтинговые очки не изменяются'}{duration !== null && ' · ' + fmtDuration(duration)}</p>
      <div className="result-standings">{standings.map(p => <div className={'result-standing' + (match.result?.winners.includes(p.id) ? ' winner' : '')} key={p.id}><Avatar src={room.members.find(m => m.player.id === p.id)?.player.avatar} name={memberName(p.id)} className="opponent-avatar"/><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{statusOf(p.id, p.out, p.forfeited)}</small></div>)}</div>
      {match.stakes && <div className="stake-payouts">
        <p className="stake-payouts-title"><Coins size={13}/> Банк {match.stakes.pool.toLocaleString('ru')} монет · {match.stakes.settlement === 'settled' ? 'выплачено' : match.stakes.settlement === 'pending' ? 'выплата обрабатывается' : match.stakes.settlement === 'refunded' ? 'ставки возвращены' : 'выплата не выполнена'}{match.stakes.payouts.some(p => (p.overflow ?? 0) > 0) ? ' · часть выигрыша превысила лимит баланса и не начислена' : ''}</p>
        {match.stakes.payouts.map(p => <div className={'stake-payout' + (p.playerId === ownId ? ' mine' : '')} key={p.playerId}><span>{memberName(p.playerId)}{p.playerId === ownId ? ' (вы)' : ''}</span><strong>+{p.amount.toLocaleString('ru')}</strong></div>)}
      </div>}
      {resultActions && <div className="button-row result-actions"><Button disabled={busy} onClick={resultActions.onToggleReady}>{resultActions.ready ? 'Отменить готовность' : 'Я готов — реванш'}</Button>{resultActions.isHost && <Button disabled={busy || !resultActions.canStart} onClick={resultActions.onStart}>Начать партию</Button>}<Button onClick={resultActions.onLeave}>Выйти в меню</Button></div>}
    </div> : <>
      <div className="own-hand-heading"><strong>{state.players.find(p => p.id === ownId)?.out ? state.forfeited ? 'Вы сдались · партия продолжается без вас' : 'Вы вышли · наблюдайте за партией' : 'Ваши карты'}</strong><span>{state.hand.length} карт · {ownTurn ? picked.length ? 'Выберите действие' : 'Подсвеченные карты доступны' : 'Ожидайте своего хода'}</span></div>
      <div className="hand-sort" role="group" aria-label="Сортировка карт">{DURAK_SORT_MODES.map(mode => <button key={mode} type="button" className={sortMode === mode ? 'active' : ''} aria-pressed={sortMode === mode} onClick={() => changeSort(mode)}>{mode === 'suit' ? 'По мастям' : mode === 'rank' ? 'По достоинству' : 'Как получены'}</button>)}</div>
      <div className={'own-hand-wrap' + (scrollEdges.left || scrollEdges.right ? ' scrollable' : '')} onPointerDownCapture={event => { lastPointerType.current = event.pointerType; }} onClickCapture={event => { if (lastPointerType.current !== 'mouse' && Date.now() - lastHandScroll.current < 250) { event.preventDefault(); event.stopPropagation(); } }}>
        {scrollEdges.left && <button type="button" className="hand-scroll left" aria-label="Прокрутить руку влево" onClick={() => scrollHand(-1)}><ChevronLeft size={18}/></button>}
        {scrollEdges.right && <button type="button" className="hand-scroll right" aria-label="Прокрутить руку вправо" onClick={() => scrollHand(1)}><ChevronRight size={18}/></button>}
        <div className={'own-hand' + (sortedHand.length > 10 ? ' dense' : '')} ref={handRef} aria-label="Ваши карты" onScroll={() => { lastHandScroll.current = Date.now(); updateScrollEdges(); }}><AnimatePresence>{sortedHand.map((c, i) => <motion.button key={c} layout className={'hand-card' + (picked.includes(c) ? ' selected' : '') + (selectable.has(c) ? ' playable' : '')} initial={preferences.reducedMotion ? false : { y: -50, opacity: 0 }} animate={{ y: picked.includes(c) ? -12 : 0, opacity: 1 }} exit={{ y: -65, opacity: 0 }} transition={{ duration: preferences.reducedMotion ? 0 : .18, delay: state.bout === 1 && state.lastEvent === 'deal' ? i * .035 : 0 }} aria-label={playingCardLabel(c)} aria-pressed={picked.includes(c)} data-hand-card={c} disabled={!selectable.has(c) || busy} onClick={() => {
        setTarget(null);
        const multi = state.phase === 'opening' || state.phase === 'defending' && choices.some(a => a.type === 'transfer' && a.cards.includes(c));
        setSelected(multi ? picked.includes(c) ? picked.filter(x => x !== c) : [...picked, c] : picked.includes(c) ? [] : [c]);
      }}><PlayingCard card={c}/></motion.button>)}</AnimatePresence></div>
      </div>
      <div className="durak-controls">{ownTurn && !state.paused ? <>{button('attack', 'Атаковать')}{button('defend', 'Защититься')}{button('transfer', 'Перевести')}{button('throw', 'Подкинуть')}{button('take', 'Взять')}{button('pass', state.phase === 'taking' ? 'Не подкидывать' : 'Бито / не подкидываю')}{picked.length > 0 && <button className="text-button" onClick={() => { setSelected([]); setTarget(null); }}>Снять выбор</button>}</> : <p>{phaseName}</p>}</div>
      {ownTurn && choices.some(a => a.type === 'defend') && <p className="card-hint">Выберите карту в руке, затем карту атаки на столе и нажмите «Защититься».</p>}
    </>}
  </section>;
}
