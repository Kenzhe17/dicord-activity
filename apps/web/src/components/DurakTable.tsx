import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Clock3, Shield, Crown, WifiOff } from 'lucide-react';
import type { DurakView, DurakAction } from '@rize/durak';
import type { MatchView, RoomView } from '@rize/shared';
import { Button } from '@rize/ui';
import { api, post, avatarSource } from '../api';
import { useArcade } from '../store';
import { PlayingCard, playingCardLabel } from './PlayingCard';
import './durak.css';

export function DurakTable({ match, room, busy, run, onForfeitExit }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onForfeitExit: () => void }) {
  const { session, setMatch, preferences } = useArcade();
  const state = match.state as DurakView;
  const [selected, setSelected] = useState<number[]>([]), [target, setTarget] = useState<number | null>(null), [clock, setClock] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { setConfirming(false); }, [match.version]);
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
  return <section className="durak-game" aria-label="Игровой стол Дурака" data-phase={state.phase} data-match-version={match.version}>
    <div className="durak-toolbar"><div><span className="eyebrow">R!Z3 CARD CLUB</span><h2>{state.mode === 'transfer' ? 'Переводной дурак' : 'Подкидной дурак'}</h2></div><div className="toolbar-actions"><span className="round-label">Розыгрыш {state.bout}</span>{state.canSurrender && !ended && <Button disabled={busy} onClick={() => confirming ? void act({ type: 'surrender' }) : setConfirming(true)}>{confirming ? 'Точно сдаться?' : 'Сдаться'}</Button>}</div></div>
    <div className="opponents">{opponents.map(p => {
      const member = room.members.find(m => m.player.id === p.id), active = state.actorId === p.id;
      return <div key={p.id} className={'opponent' + (active ? ' opponent-active' : '') + (p.out ? ' opponent-out' : '')}>
        <div className="opponent-identity"><span className="opponent-avatar">{member?.player.avatar ? <img src={avatarSource(member.player.avatar)} alt=""/> : member?.player.name.slice(0, 1)}{!member?.connected && <WifiOff size={12}/>}</span><div><strong>{memberName(p.id)}</strong><small>{p.out ? 'Вышел из игры' : p.id === state.defenderId ? 'Защищается' : active ? 'Ходит' : p.count + ' карт'}</small></div>{p.out && <Crown size={14}/>}</div>
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
    {ended ? <div className="durak-result" role="status"><Crown size={30}/><h2>{match.status === 'interrupted' ? 'Партия прервана' : state.result?.draw ? 'Ничья' : state.result?.losers.includes(ownId) ? 'Вы остались с картами' : 'Партия без поражения'}</h2><p>{match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : 'Результат сохранён · рейтинговые очки не изменяются'}</p></div> : <>
      <div className="own-hand-heading"><strong>{state.players.find(p => p.id === ownId)?.out ? state.forfeited ? 'Вы сдались · партия продолжается без вас' : 'Вы вышли · наблюдайте за партией' : 'Ваши карты'}</strong><span>{state.hand.length} карт · {ownTurn ? picked.length ? 'Выберите действие' : 'Подсвеченные карты доступны' : 'Ожидайте своего хода'}</span></div>
      <div className="own-hand" aria-label="Ваши карты"><AnimatePresence>{state.hand.map((c, i) => <motion.button key={c} layout className={'hand-card' + (picked.includes(c) ? ' selected' : '') + (selectable.has(c) ? ' playable' : '')} initial={preferences.reducedMotion ? false : { y: -50, opacity: 0 }} animate={{ y: picked.includes(c) ? -12 : 0, opacity: 1 }} exit={{ y: -65, opacity: 0 }} transition={{ duration: preferences.reducedMotion ? 0 : .18, delay: state.bout === 1 && state.lastEvent === 'deal' ? i * .035 : 0 }} aria-label={playingCardLabel(c)} aria-pressed={picked.includes(c)} data-hand-card={c} disabled={!selectable.has(c) || busy} onClick={() => {
        setTarget(null);
        const multi = state.phase === 'opening' || state.phase === 'defending' && choices.some(a => a.type === 'transfer' && a.cards.includes(c));
        setSelected(multi ? picked.includes(c) ? picked.filter(x => x !== c) : [...picked, c] : picked.includes(c) ? [] : [c]);
      }}><PlayingCard card={c}/></motion.button>)}</AnimatePresence></div>
      <div className="durak-controls">{ownTurn && !state.paused ? <>{button('attack', 'Атаковать')}{button('defend', 'Защититься')}{button('transfer', 'Перевести')}{button('throw', 'Подкинуть')}{button('take', 'Взять')}{button('pass', state.phase === 'taking' ? 'Не подкидывать' : 'Бито / не подкидываю')}{picked.length > 0 && <button className="text-button" onClick={() => { setSelected([]); setTarget(null); }}>Снять выбор</button>}</> : <p>{phaseName}</p>}</div>
      {state.forfeited && !ended && <div className="button-row"><Button onClick={onForfeitExit}>Покинуть комнату</Button></div>}
      {ownTurn && choices.some(a => a.type === 'defend') && <p className="card-hint">Выберите карту в руке, затем карту атаки на столе и нажмите «Защититься».</p>}
    </>}
  </section>;
}
