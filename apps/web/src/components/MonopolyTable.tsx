import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Clock3, Dices, Crown, WifiOff, Menu, Handshake, ArrowLeftRight, X, Gavel, Lock, Eye, DoorOpen } from 'lucide-react';
import type { MatchView, RoomView } from '@rize/shared';
import { Button } from '@rize/ui';
import { api, post } from '../api';
import { useArcade } from '../store';
import { Avatar } from './Avatar';
import { BOARD, GROUPS, GO_BONUS, JAIL_BAIL, JAIL_INDEX, MAX_LEVEL, isPurchasable, groupOfProperty, mortgageValue, unmortgageCost } from '@rize/monopoly/board';
import type { MonopolyAction, MonopolyView } from '@rize/monopoly';
import './monopoly.css';

interface ResultActions { ready: boolean; isHost: boolean; canStart: boolean; onToggleReady: () => void; onStart: () => void; onLeave: () => void }

const SEAT_COLORS = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#c084fc', '#fb923c'];
const MODE_NAMES: Record<string, string> = { classic: 'Классика', quick: 'Быстрая', teams: 'Командная 2×2' };
const PHASE_NAMES: Record<string, string> = {
  awaitRoll: 'Бросьте кубики', awaitEnd: 'Ваш ход завершён — можно управлять собственностью',
  buy: 'Решите, покупать ли объект', auction: 'Идут торги', debt: 'Нужно погасить долг', finished: 'Партия завершена',
};

/** 11×11 grid placement: index → {row, col}. Corners are single cells. */
function cellPos(index: number): { row: number; col: number } {
  if (index === 0) return { row: 10, col: 10 };
  if (index <= 9) return { row: 10, col: 10 - index };
  if (index === 10) return { row: 10, col: 0 };
  if (index <= 19) return { row: 20 - index, col: 0 };
  if (index === 20) return { row: 0, col: 0 };
  if (index <= 29) return { row: 0, col: index - 20 };
  if (index === 30) return { row: 0, col: 10 };
  return { row: index - 30, col: 10 };
}

function groupColor(index: number): string | null {
  const def = BOARD[index]?.property;
  if (!def) return null;
  const group = groupOfProperty(def);
  return group?.color ?? (def.kind === 'station' ? '#8d99ae' : '#7fb3d5');
}

export function MonopolyTable({ match, room, busy, run, onForfeitExit, resultActions }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onForfeitExit?: (() => void) | undefined; resultActions?: ResultActions | undefined }) {
  const { session, setMatch } = useArcade();
  const state = match.state as MonopolyView;
  const ownId = session?.player.id ?? '';
  const ownSeat = state.players.findIndex(p => p.id === ownId);
  const ownBank = ownSeat >= 0 ? state.players[ownSeat]!.bank : -1;
  const ended = match.status !== 'active';

  const [clock, setClock] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [bid, setBid] = useState('');
  const [zoom, setZoom] = useState(1);
  const menuRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(t); }, []);
  useEffect(() => { setSelected(null); setMenuOpen(false); setTradeOpen(false); setConfirming(false); setBid(''); }, [match.version, match.status]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);

  const memberName = (id: string | null | undefined): string => {
    if (id === null || id === undefined) return 'Банк';
    const seat = state.players.findIndex(p => p.id === id);
    if (seat >= 0) return room.members.find(m => m.player.id === id)?.player.name ?? state.players[seat]!.id.slice(0, 6);
    const bank = Number(id);
    if (Number.isInteger(bank) && state.banks[bank]) {
      const seatId = state.banks[bank]!.members.map(m => state.players[m]?.id).find(Boolean);
      return seatId ? memberName(seatId) : 'Команда ' + (bank + 1);
    }
    return room.members.find(m => m.player.id === id)?.player.name ?? 'Игрок';
  };
  const seatName = (seat: number | null | undefined) => seat === null || seat === undefined ? '—' : memberName(state.players[seat]?.id);
  const bankName = (bank: number | null) => bank === null ? 'Банк' : state.banks[bank]!.members.map(m => memberName(state.players[m]!.id)).join(' + ');

  const time = Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const act = (action: MonopolyAction) => run(async () => {
    try {
      const value = await post<MatchView>('/matches/' + match.matchId + '/actions', { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: match.version, action });
      setMatch(value);
    } catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
  });

  const flags = state.flags;
  const myTurn = state.turnPlayerId === ownId && !ended && !state.paused;
  const pendingPurchase = state.pending?.type === 'purchase' ? state.pending.index : null;
  const pendingDebt = state.pending?.type === 'debt' ? state.pending : null;
  const auction = state.auction;
  const isAuctionParticipant = auction !== null && state.banks[ownBank]?.active && !auction.passed.includes(ownBank) && auction.leader !== ownBank;
  const minBid = auction ? auction.minNextBid : 0;
  const maxBid = auction ? state.banks[ownBank]!.balance : 0;

  const selectedCell = selected !== null ? BOARD[selected] : null;
  const selectedProp = selected !== null ? state.properties[selected]! : null;
  const selectedOwnerBank = selectedProp?.owner ?? null;
  const ownerSeats = selectedOwnerBank !== null ? state.banks[selectedOwnerBank]!.members : [];
  const groupComplete = useMemo(() => {
    if (!selectedCell?.property?.group) return false;
    const group = GROUPS.find(g => g.id === selectedCell.property!.group)!;
    return group.indices.every(i => state.properties[i]!.owner === selectedOwnerBank);
  }, [selectedCell, state.properties, selectedOwnerBank]);

  const rentLabel = (index: number) => {
    const def = BOARD[index]!.property!;
    const prop = state.properties[index]!;
    const ownerBank = prop.owner;
    if (ownerBank === null || prop.mortgaged) return '—';
    if (def.kind === 'station') {
      const count = state.properties.filter((p, i) => p.owner === ownerBank && BOARD[i]!.property?.kind === 'station').length;
      return [0, 25, 50, 100, 200][Math.min(count, 4)];
    }
    if (def.kind === 'utility') {
      const count = state.properties.filter((p, i) => p.owner === ownerBank && BOARD[i]!.property?.kind === 'utility').length;
      return '×' + (count >= 2 ? 10 : 4) + ' кубиков';
    }
    return def.rents[Math.min(prop.level, MAX_LEVEL)];
  };

  // occupants per cell for token rendering
  const occupants = useMemo(() => {
    const map = new Map<number, number[]>();
    state.players.forEach((p, seat) => {
      if (p.out) return;
      const list = map.get(p.position) ?? [];
      list.push(seat);
      map.set(p.position, list);
    });
    return map;
  }, [state.players]);

  const tokensOn = (index: number) => occupants.get(index) ?? [];

  const statusText = state.paused ? 'Пауза · ожидаем игроков'
    : ended ? 'Партия завершена'
    : auction ? 'Торги: ' + BOARD[auction.index]!.name + ' · ' + auction.currentBid
    : pendingDebt && pendingDebt.forSeat === ownSeat ? 'Ваш долг: ' + pendingDebt.amount + ' — ' + bankName(pendingDebt.creditor)
    : pendingPurchase !== null && myTurn ? 'Купить ' + BOARD[pendingPurchase]!.name + ' за ' + BOARD[pendingPurchase]!.property!.price + '?'
    : myTurn ? (state.phase === 'awaitRoll' ? (state.players[ownSeat]?.inJail ? 'Вы в тюрьме — бросьте дубли, заплатите ' + JAIL_BAIL + ' или используйте пропуск' : 'Ваш ход — бросьте кубики') : PHASE_NAMES[state.phase] ?? '')
    : 'Ходит ' + memberName(state.turnPlayerId);

  const bidNumber = Math.floor(Number(bid));
  const bidValid = Number.isInteger(bidNumber) && bidNumber >= minBid && bidNumber <= maxBid;

  return <section className="mono-game" data-match-version={match.version} aria-label="Игровой стол Монополии">
    <div className="mono-topbar">
      <div className="mono-topbar-info">
        <strong>Монополия · {MODE_NAMES[state.mode] ?? state.mode}</strong>
        {state.mode === 'teams' && <span className="mono-team-tag">{memberName(state.banks[0]!.members.map(m => state.players[m]!.id)[0])} + {memberName(state.players[state.banks[0]!.members[1]!]!.id)} vs {memberName(state.players[state.banks[1]!.members[0]!]!.id)} + {memberName(state.players[state.banks[1]!.members[1]!]!.id)}</span>}
      </div>
      <div className="mono-topbar-right">
        {!ended && !state.paused && <span className={'mono-clock' + (time <= 10 ? ' urgent' : '')} role="timer"><Clock3 size={13}/>{time} c</span>}
        {state.dice && <span className="mono-dice" aria-label="Кубики"><Dices size={14}/>{state.dice[0]} · {state.dice[1]}</span>}
        <div className="mono-zoom">
          <button aria-label="Уменьшить поле" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.1).toFixed(2)))}>−</button>
          <button aria-label="Увеличить поле" onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(2)))}>+</button>
        </div>
        <button className="mono-log-toggle" onClick={() => setLogOpen(o => !o)}><Eye size={14}/>{logOpen ? 'Скрыть лог' : 'Лог'}</button>
        {!ended && <div className="game-menu-wrap" ref={menuRef}>
          <Button aria-expanded={menuOpen} aria-label="Меню партии" onClick={() => setMenuOpen(o => !o)}><Menu size={14}/>Меню</Button>
          {menuOpen && <div className="game-menu" role="menu">
            <div className="game-menu-players">
              {state.players.map(p => {
                const member = room.members.find(m => m.player.id === p.id);
                return <div className="game-menu-player" key={p.id}>
                  <Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar>
                  <div><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{p.out ? 'Выбыл' : p.inJail ? 'В тюрьме' : state.banks[p.bank]!.balance.toLocaleString('ru') + ' монет'}</small></div>
                </div>;
              })}
            </div>
            <p className="game-menu-rules">Монополия: покупайте цветные группы, стройте дома и отели, берите аренду, торгуйтесь и разоряйте соперников. Проход Старт: +{GO_BONUS}. Залог в тюрьме: {JAIL_BAIL}. Залог собственности: 50% цены, выкуп: +10%.</p>
            <div className="game-menu-actions">
              {flags.canTrade && <Button onClick={() => { setTradeOpen(true); setMenuOpen(false); }}><Handshake size={14}/>Предложить обмен</Button>}
              {state.players[ownSeat]?.out && onForfeitExit && <Button onClick={onForfeitExit}><DoorOpen size={14}/>Покинуть комнату</Button>}
              {flags.canSurrender && <Button className="danger-button" disabled={busy} onClick={() => confirming ? void act({ type: 'surrender' }) : setConfirming(true)}>{confirming ? 'Точно сдаться? Имущество сгорит' : 'Сдаться'}</Button>}
            </div>
          </div>}
        </div>}
      </div>
    </div>

    <div className="mono-status" role="status"><strong>{statusText}</strong>{pendingDebt && <small>долг {pendingDebt.amount} · кредитор {bankName(pendingDebt.creditor)}</small>}</div>

    <div className="mono-layout">
      <div className="mono-board-scroll">
        <div className="mono-board" style={{ transform: 'scale(' + zoom + ')' }} ref={boardRef}>
          {BOARD.map(cell => {
            const pos = cellPos(cell.index);
            const prop = state.properties[cell.index]!;
            const color = groupColor(cell.index);
            const tokens = tokensOn(cell.index);
            const isPurchaseTarget = pendingPurchase === cell.index;
            const isAuctionTarget = auction?.index === cell.index;
            const isCurrent = state.players[state.turnSeat]?.position === cell.index && !ended;
            return <button
              key={cell.index}
              className={[
                'mono-cell', 'mono-' + cell.kind,
                prop.owner !== null ? 'owned' : '',
                prop.mortgaged ? 'mortgaged' : '',
                isPurchaseTarget ? 'purchase-target' : '',
                isAuctionTarget ? 'auction-target' : '',
                isCurrent ? 'current-pos' : '',
                cell.index === JAIL_INDEX ? 'jail-cell' : '',
              ].filter(Boolean).join(' ')}
              style={{ gridRow: pos.row + 1, gridColumn: pos.col + 1, ...(color ? { borderTopColor: color, borderTopWidth: 4 } : {}) }}
              onClick={() => setSelected(cell.index)}
              aria-label={cell.name}
            >
              <span className="mono-cell-name">{cell.name}</span>
              {cell.property && <span className="mono-cell-price">{cell.property.price}</span>}
              {cell.tax !== undefined && <span className="mono-cell-tax">−{cell.tax}</span>}
              {cell.kind === 'go' && <span className="mono-cell-bonus">+{GO_BONUS}</span>}
              {prop.owner !== null && <span className="mono-owner-bar" style={{ background: SEAT_COLORS[state.banks[prop.owner]!.members[0]!] }}>{ownerSeats.length > 1 && <em>2×2</em>}</span>}
              {prop.level > 0 && <span className="mono-levels">{Array.from({ length: prop.level }, (_, i) => <i key={i}/>)}</span>}
              {prop.mortgaged && <span className="mono-mortgage-mark"><Lock size={9}/>ЗАЛОГ</span>}
              {tokens.length > 0 && <span className="mono-tokens">{tokens.map(seat => <i key={seat} className="mono-token" style={{ background: SEAT_COLORS[seat], zIndex: seat }}>{state.players[seat]!.inJail ? 'J' : ''}</i>)}</span>}
              {cell.deck && <span className="mono-deck-tag">{cell.deck === 'chance' ? 'Шанс' : 'Сообщество'} · {state.deckCounts[cell.deck]}</span>}
            </button>;
          })}
          <div className="mono-center" style={{ gridRow: '2 / 11', gridColumn: '2 / 11' }}>
            <div className="mono-center-card">
              <strong>r!z3</strong>
              <span>АРКАДНАЯ МОНополия</span>
              <small>{MODE_NAMES[state.mode]}</small>
            </div>
          </div>
        </div>
      </div>

      <aside className="mono-side">
        <div className="mono-players">
          {state.players.map(p => {
            const member = room.members.find(m => m.player.id === p.id);
            const isTurn = state.turnPlayerId === p.id && !ended;
            const bank = state.banks[p.bank]!;
            return <div key={p.id} className={'mono-player' + (isTurn ? ' active' : '') + (p.out ? ' out' : '') + (p.id === ownId ? ' mine' : '')} style={{ borderLeftColor: SEAT_COLORS[p.seat] }}>
              <Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar>
              <div className="mono-player-info">
                <strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}{state.mode === 'teams' ? ' · ' + (p.bank === 0 ? 'Команда А' : 'Команда Б') : ''}</strong>
                <span>{p.out ? 'Выбыл' : p.inJail ? 'Тюрьма ' + (p.jailTurns + 1) + '/3 · пропусков: ' + p.getOutCards : 'Клетка ' + p.position + ' · ' + bank.balance.toLocaleString('ru') + ' монет'}</span>
              </div>
              {isTurn && <span className="turn-light active"/>}
            </div>;
          })}
        </div>

        {auction && <div className="mono-auction-panel">
          <h3><Gavel size={15}/> Аукцион: {BOARD[auction.index]!.name}</h3>
          <p>Ставка: <strong>{auction.currentBid || '—'}</strong> · лидер: {auction.leader !== null ? bankName(auction.leader) : 'нет'}</p>
          {isAuctionParticipant && <div className="mono-bid-row">
            <input inputMode="numeric" aria-label="Сумма ставки" placeholder={'от ' + minBid} value={bid} onChange={e => setBid(e.target.value.replace(/\D/g, ''))}/>
            <Button disabled={busy || !bidValid} onClick={() => void act({ type: 'bid', amount: bidNumber })}>Ставка</Button>
            <Button disabled={busy} onClick={() => void act({ type: 'pass' })}>Пас</Button>
          </div>}
          {!isAuctionParticipant && <p className="muted">{auction.passed.includes(ownBank) ? 'Вы пасовали' : 'Ожидание ставок…'}</p>}
        </div>}

        {state.trades.toMe.length > 0 && <div className="mono-trades">
          <h3><ArrowLeftRight size={15}/> Входящие сделки</h3>
          {state.trades.toMe.map(t => <div className="mono-trade" key={t.id}>
            <p><strong>{seatName(t.from)}</strong> предлагает: {t.giveMoney > 0 && t.giveMoney + ' монет '}{t.giveProps.map(i => BOARD[i]!.name).join(', ')}{t.getMoney > 0 && ' ← ' + t.getMoney + ' монет'}{t.getProps.map(i => BOARD[i]!.name).join(', ')}</p>
            <div className="button-row">
              <Button disabled={busy} onClick={() => void act({ type: 'accept', offerId: t.id })}>Принять</Button>
              <Button disabled={busy} onClick={() => void act({ type: 'decline', offerId: t.id })}>Отклонить</Button>
            </div>
          </div>)}
        </div>}
        {state.trades.byMe.length > 0 && <div className="mono-trades outgoing">
          <h3>Ваши предложения</h3>
          {state.trades.byMe.map(t => <div className="mono-trade" key={t.id}>
            <p>→ {seatName(t.to)}: {t.giveMoney > 0 && t.giveMoney + ' '}{t.giveProps.map(i => BOARD[i]!.name).join(', ')}{t.getMoney > 0 && ' ← ' + t.getMoney}{t.getProps.map(i => BOARD[i]!.name).join(', ')}</p>
            <Button disabled={busy} onClick={() => void act({ type: 'cancel', offerId: t.id })}>Отменить</Button>
          </div>)}
        </div>}

        <div className="mono-owned">
          <h3>Ваша собственность</h3>
          {state.properties.map((p, i) => p.owner === ownBank ? (
            <button key={i} className={'mono-owned-item' + (p.mortgaged ? ' mortgaged' : '')} style={{ borderLeftColor: groupColor(i) ?? '#888' }} onClick={() => setSelected(i)}>
              <span>{BOARD[i]!.name}</span>
              <small>{p.mortgaged ? 'залог' : 'ур. ' + p.level + (p.level === MAX_LEVEL ? ' · отель' : '')}</small>
            </button>
          ) : null)}
          {!state.properties.some(p => p.owner === ownBank) && <p className="muted">Пока пусто — покупайте на аукционе или за деньги.</p>}
        </div>
      </aside>

      {logOpen && <div className="mono-log" role="log">
        {state.log.map((entry, i) => <p key={i}>{entry.seat !== undefined ? <strong>{seatName(entry.seat)}: </strong> : null}{entry.text}</p>)}
      </div>}
    </div>

    {/* Contextual action bar */}
    {!ended && <div className="mono-actions">
      {myTurn && state.phase === 'awaitRoll' && !state.players[ownSeat]?.inJail && <Button className="mono-primary" disabled={busy} onClick={() => void act({ type: 'roll' })}><Dices size={16}/>Бросить кубики</Button>}
      {myTurn && state.phase === 'awaitRoll' && state.players[ownSeat]?.inJail && <>
        {flags.canRoll && <Button className="mono-primary" disabled={busy} onClick={() => void act({ type: 'roll' })}><Dices size={16}/>Бросить дубли</Button>}
        {flags.canPayJail && <Button disabled={busy} onClick={() => void act({ type: 'payJail' })}>Заплатить {JAIL_BAIL}</Button>}
        {flags.canUseJailCard && <Button disabled={busy} onClick={() => void act({ type: 'jailCard' })}>Пропуск ({state.players[ownSeat]!.getOutCards})</Button>}
      </>}
      {myTurn && state.phase === 'buy' && pendingPurchase !== null && <>
        <Button className="mono-primary" disabled={busy || !flags.canBuy} onClick={() => void act({ type: 'buy' })}>Купить за {BOARD[pendingPurchase]!.property!.price}</Button>
        <Button disabled={busy} onClick={() => void act({ type: 'refuse' })}>Отказаться → аукцион</Button>
      </>}
      {myTurn && state.phase === 'awaitEnd' && <Button className="mono-primary" disabled={busy} onClick={() => void act({ type: 'endTurn' })}>Завершить ход</Button>}
      {myTurn && state.phase === 'debt' && pendingDebt && <p className="mono-debt-note">Долг {pendingDebt.amount}: продавайте постройки и закладывайте собственность через карточку клетки, или предложите обмен.</p>}
      {!myTurn && !auction && !ended && <p className="mono-waiting">{statusText}</p>}
    </div>}

    {/* Property detail modal */}
    <AnimatePresence>
      {selectedCell && selected !== null && <motion.div className="mono-modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSelected(null)}>
        <motion.div className="mono-modal" role="dialog" aria-label={selectedCell.name} initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }} onClick={e => e.stopPropagation()}>
          <button className="mono-modal-close" aria-label="Закрыть" onClick={() => setSelected(null)}><X size={18}/></button>
          <div className="mono-modal-head" style={{ borderTopColor: groupColor(selected) ?? '#888', borderTopWidth: 6 }}>
            <h2>{selectedCell.name}</h2>
            <span className="mono-modal-kind">{selectedCell.kind === 'property' ? 'Улица' : selectedCell.kind === 'station' ? 'Вокзал' : selectedCell.kind === 'utility' ? 'Коммунальная' : selectedCell.kind === 'chance' ? 'Шанс' : selectedCell.kind === 'community' ? 'Сообщество' : selectedCell.kind === 'tax' ? 'Налог' : selectedCell.kind === 'jail' ? 'Тюрьма' : selectedCell.kind === 'gotojail' ? 'В тюрьму' : selectedCell.kind === 'parking' ? 'Стоянка' : 'Старт'}</span>
          </div>
          <div className="mono-modal-body">
            {selectedCell.property && <>
              <p className="mono-modal-price">Цена: <strong>{selectedCell.property.price}</strong> · Залог: <strong>{mortgageValue(selectedCell.property.price)}</strong> · Выкуп: <strong>{unmortgageCost(selectedCell.property.price)}</strong></p>
              <p className="mono-modal-owner">Владелец: <strong>{selectedOwnerBank !== null ? bankName(selectedOwnerBank) : 'никто'}</strong>{groupComplete && selectedOwnerBank !== null && <em className="mono-monopoly-tag">монополия</em>}</p>
              {selectedCell.property.kind === 'property' && <div className="mono-rent-table">
                {selectedCell.property.rents.map((r, lvl) => <span key={lvl} className={selectedProp?.level === lvl ? 'cur' : ''}>{lvl === MAX_LEVEL ? 'отель' : lvl > 0 ? 'дом ' + lvl : 'без домов'}: {r}</span>)}
              </div>}
              {selectedCell.property.kind !== 'property' && <p className="muted">Аренда: {rentLabel(selected)}</p>}
              {selectedProp?.mortgaged && <p className="mono-mortgaged-note"><Lock size={12}/> Заложено — аренда не взимается</p>}
            </>}
            {selectedCell.kind === 'chance' && <p>Тяните карту «Шанс». В колоде осталось {state.deckCounts.chance}.</p>}
            {selectedCell.kind === 'community' && <p>Тяните карту «Сообщество». В колоде осталось {state.deckCounts.community}.</p>}
            {selectedCell.kind === 'tax' && <p>Заплатите банку {selectedCell.tax}.</p>}
            {selectedCell.kind === 'gotojail' && <p>Отправляет в тюрьму.</p>}
            {selectedCell.kind === 'jail' && <p>Тюрьма / «просто посещение». Залог {JAIL_BAIL}, пропуск — карта из колоды.</p>}
            {selectedCell.kind === 'go' && <p>Проходите и получайте +{GO_BONUS}.</p>}
            {selectedCell.kind === 'parking' && <p>Финальная стоянка — передышка.</p>}

            {/* Manage actions */}
            {selectedCell.property && !ended && <div className="mono-manage">
              {flags.buildable.includes(selected) && <Button disabled={busy} onClick={() => { void act({ type: 'build', property: selected }); setSelected(null); }}>Построить (−{selectedCell.property.houseCost})</Button>}
              {flags.sellable.includes(selected) && <Button disabled={busy} onClick={() => { void act({ type: 'sell', property: selected }); setSelected(null); }}>Продать постройку (+{Math.floor(selectedCell.property.houseCost / 2)})</Button>}
              {flags.mortgageable.includes(selected) && <Button disabled={busy} onClick={() => { void act({ type: 'mortgage', property: selected }); setSelected(null); }}>Заложить (+{mortgageValue(selectedCell.property.price)})</Button>}
              {flags.unmortgageable.includes(selected) && <Button disabled={busy} onClick={() => { void act({ type: 'unmortgage', property: selected }); setSelected(null); }}>Выкупить (−{unmortgageCost(selectedCell.property.price)})</Button>}
            </div>}
          </div>
        </motion.div>
      </motion.div>}
    </AnimatePresence>

    {/* Trade composer */}
    <AnimatePresence>
      {tradeOpen && <TradeModal state={state} ownSeat={ownSeat} ownBank={ownBank} memberName={memberName} bankName={bankName} busy={busy} run={run} match={match} room={room} onClose={() => setTradeOpen(false)}/>}    
    </AnimatePresence>

    {/* Result */}
    {ended && <div className="mono-result" role="status">
      <Crown size={26}/>
      <h2>{match.status === 'interrupted' ? 'Партия прервана' : state.result?.draw ? 'Ничья' : state.result?.winners.includes(ownId) ? 'Победа!' : 'Партия завершена'}</h2>
      <p>{match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : 'Результат сохранён · рейтинговые очки не изменяются'}</p>
      <div className="mono-result-grid">
        {state.players.map(p => {
          const member = room.members.find(m => m.player.id === p.id);
          const place = state.result?.winners.includes(p.id) ? 'Победитель' : p.out ? 'Проиграл' : '—';
          return <div key={p.id} className={'mono-result-card' + (state.result?.winners.includes(p.id) ? ' winner' : '')} style={{ borderLeftColor: SEAT_COLORS[p.seat] }}>
            <Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar"/>
            <strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong>
            <span>{place} · {state.banks[p.bank]!.balance.toLocaleString('ru')}</span>
          </div>;
        })}
      </div>
      {resultActions && <div className="button-row result-actions">
        <Button disabled={busy} onClick={resultActions.onToggleReady}>{resultActions.ready ? 'Отменить готовность' : 'Я готов — реванш'}</Button>
        {resultActions.isHost && <Button disabled={busy || !resultActions.canStart} onClick={resultActions.onStart}>Начать партию</Button>}
        <Button onClick={resultActions.onLeave}>Выйти в меню</Button>
      </div>}
    </div>}
  </section>;
}

/* ------------------------------ Trade modal ------------------------------ */

function TradeModal({ state, ownSeat, ownBank, memberName, bankName, busy, run, match, room, onClose }: {
  state: MonopolyView; ownSeat: number; ownBank: number;
  memberName: (id: string | null | undefined) => string; bankName: (b: number | null) => string;
  busy: boolean; run: (a: () => Promise<void>) => Promise<void>; match: MatchView; room: RoomView; onClose: () => void;
}) {
  const { setMatch } = useArcade();
  const [targetSeat, setTargetSeat] = useState<number>(-1);
  const [giveMoney, setGiveMoney] = useState('');
  const [getMoney, setGetMoney] = useState('');
  const [giveProps, setGiveProps] = useState<number[]>([]);
  const [getProps, setGetProps] = useState<number[]>([]);
  const targets = state.players.filter(p => p.seat !== ownSeat && !p.out);
  const targetBank = targetSeat >= 0 ? state.players[targetSeat]!.bank : -1;
  const myTradable = state.properties.map((p, i) => p.owner === ownBank && p.level === 0 && isPurchasable(i) ? i : -1).filter(i => i >= 0);
  const theirTradable = targetBank >= 0 ? state.properties.map((p, i) => p.owner === targetBank && p.level === 0 && isPurchasable(i) ? i : -1).filter(i => i >= 0) : [];
  const toggle = (list: number[], set: (v: number[]) => void, i: number) => set(list.includes(i) ? list.filter(x => x !== i) : [...list, i]);
  const send = () => run(async () => {
    try {
      const value = await post<MatchView>('/matches/' + match.matchId + '/actions', {
        protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: match.version,
        action: { type: 'offer', to: state.players[targetSeat]!.id, giveMoney: Number(giveMoney) || 0, giveProps, getMoney: Number(getMoney) || 0, getProps } satisfies MonopolyAction,
      });
      setMatch(value); onClose();
    } catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
  });
  const valid = targetSeat >= 0 && (giveProps.length + getProps.length + (Number(giveMoney) || 0) + (Number(getMoney) || 0)) > 0;
  return <motion.div className="mono-modal-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
    <motion.div className="mono-modal mono-trade-modal" role="dialog" aria-label="Обмен" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }} onClick={e => e.stopPropagation()}>
      <button className="mono-modal-close" aria-label="Закрыть" onClick={onClose}><X size={18}/></button>
      <h2><Handshake size={18}/> Предложить обмен</h2>
      <label className="mono-field">С кем
        <select value={targetSeat} onChange={e => { setTargetSeat(Number(e.target.value)); setGetProps([]); }}>
          <option value={-1}>— выберите игрока —</option>
          {targets.map(p => <option key={p.seat} value={p.seat}>{memberName(p.id)}{state.mode === 'teams' ? ' (' + (p.bank === 0 ? 'А' : 'Б') + ')' : ''}</option>)}
        </select>
      </label>
      {targetSeat >= 0 && <div className="mono-trade-cols">
        <div className="mono-trade-col">
          <h3>Отдаёте ({bankName(ownBank)})</h3>
          <label>Монеты <input inputMode="numeric" value={giveMoney} onChange={e => setGiveMoney(e.target.value.replace(/\D/g, ''))}/></label>
          <div className="mono-trade-props">
            {myTradable.map(i => <button key={i} className={giveProps.includes(i) ? 'sel' : ''} onClick={() => toggle(giveProps, setGiveProps, i)}>{BOARD[i]!.name}</button>)}
            {!myTradable.length && <p className="muted">Нет незастроенной собственности</p>}
          </div>
        </div>
        <div className="mono-trade-col">
          <h3>Получаете ({memberName(state.players[targetSeat]!.id)})</h3>
          <label>Монеты <input inputMode="numeric" value={getMoney} onChange={e => setGetMoney(e.target.value.replace(/\D/g, ''))}/></label>
          <div className="mono-trade-props">
            {theirTradable.map(i => <button key={i} className={getProps.includes(i) ? 'sel' : ''} onClick={() => toggle(getProps, setGetProps, i)}>{BOARD[i]!.name}</button>)}
            {!theirTradable.length && <p className="muted">У игрока нет незастроенной собственности</p>}
          </div>
        </div>
      </div>}
      <div className="button-row">
        <Button className="mono-primary" disabled={busy || !valid} onClick={() => void send()}>Отправить предложение</Button>
        <Button onClick={onClose}>Отмена</Button>
      </div>
    </motion.div>
  </motion.div>;
}
