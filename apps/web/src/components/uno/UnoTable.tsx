import { useEffect, useRef, useState } from 'react';
import { Clock3, Crown, Menu, RotateCcw, RotateCw, WifiOff, DoorOpen, Hand, Palette, AlertTriangle } from 'lucide-react';
import type { MatchView, RoomView } from '@rize/shared';
import { Button } from '@rize/ui';
import { api, post } from '../../api';
import { useArcade } from '../../store';
import { Avatar } from '../Avatar';
import { UnoCard, UnoColorChip, UNO_COLORS } from './UnoCard';
import { UnoHand, UnoCardBacks } from './UnoHand';
import type { UnoAction, UnoView } from '@rize/uno';
import '../uno.css';

interface ResultActions { ready: boolean; isHost: boolean; canStart: boolean; onToggleReady: () => void; onStart: () => void; onLeave: () => void }

export function UnoTable({ match, room, busy, run, onForfeitExit, resultActions }: { match: MatchView; room: RoomView; busy: boolean; run: (action: () => Promise<void>) => Promise<void>; onForfeitExit: () => void; resultActions?: ResultActions | undefined }) {
  const { session, setMatch } = useArcade();
  const state = match.state as UnoView;
  const [clock, setClock] = useState(Date.now());
  const [menuOpen, setMenuOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const [colorPick, setColorPick] = useState<number | null>(null); // card awaiting color choice
  const [fx, setFx] = useState<string>('');
  const menuRef = useRef<HTMLDivElement>(null);
  const versionRef = useRef(match.version);

  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 500); return () => clearInterval(timer); }, []);
  useEffect(() => { setConfirming(false); setMenuOpen(false); setColorPick(null); }, [match.version, match.status]);
  useEffect(() => {
    if (versionRef.current === match.version) return;
    versionRef.current = match.version;
    setFx(state.lastEvent);
    const timer = setTimeout(() => setFx(''), 900);
    return () => clearTimeout(timer);
  }, [match.version, state.lastEvent]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [menuOpen]);

  const ownId = session?.player.id ?? '';
  const legal = state.legal;
  const ended = match.status !== 'active';
  const ownTurn = legal.myTurn && !ended && !state.paused;
  const memberName = (id: string | null) => room.members.find(m => m.player.id === id)?.player.name ?? 'Игрок';
  const memberOf = (id: string) => room.members.find(m => m.player.id === id);
  const time = Math.max(0, Math.ceil((state.deadline - clock) / 1000));
  const playable = new Set(legal.plays);
  const directionIcon = state.direction === 1 ? RotateCw : RotateCcw;
  const DirectionIcon = directionIcon;

  const act = (action: UnoAction) => run(async () => {
    try {
      const value = await post<MatchView>('/matches/' + match.matchId + '/actions', { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: crypto.randomUUID(), expectedVersion: match.version, action });
      setMatch(value);
    } catch (error) { setMatch(await api('/matches/' + match.matchId)); throw error; }
  });

  const isWildCard = (id: number) => id >= 100;
  const tapCard = (id: number) => {
    if (!playable.has(id) || busy) return;
    if (isWildCard(id)) { setColorPick(id); return; }
    void act({ type: 'play', card: id, ...(state.hand.length === 2 ? { callUno: true } : {}) });
  };
  const pickColor = (color: 'red' | 'blue' | 'green' | 'yellow') => {
    if (colorPick !== null) {
      const card = colorPick;
      setColorPick(null);
      void act({ type: 'play', card, color, ...(state.hand.length === 2 ? { callUno: true } : {}) });
    } else {
      setColorPick(null);
      void act({ type: 'chooseColor', color });
    }
  };
  const showColorPicker = colorPick !== null || (state.phase === 'color' && state.awaitingColor?.actorId === ownId);

  const phaseName = state.paused ? 'Пауза · ожидаем игроков'
    : ended ? 'Партия завершена'
    : state.phase === 'roundEnd' ? 'Раунд окончен'
    : state.phase === 'color' ? (state.awaitingColor?.actorId === ownId ? 'Выберите цвет' : memberName(state.awaitingColor?.actorId ?? null) + ' выбирает цвет')
    : state.phase === 'challenge' ? memberName(state.challenge?.actorId ?? null) + ' сыграл +4'
    : legal.myTurn ? (state.pendingDraw !== null ? 'Можно сыграть взятую карту или пропустить' : 'Ваш ход')
    : 'Ходит ' + memberName(state.actorId);

  const opponents = state.players.map((p, i) => ({ p, i })).filter(({ p }) => p.id !== ownId);
  const standings = [...state.players].sort((a, b) => (state.scores[b.seat] ?? 0) - (state.scores[a.seat] ?? 0));
  const duration = match.createdAt && match.finishedAt ? Math.max(0, Math.round((Date.parse(match.finishedAt) - Date.parse(match.createdAt)) / 1000)) : null;
  const fmtDuration = (seconds: number) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');

  return <section className="uno-game" aria-label="Игровой стол UNO" data-phase={state.phase} data-match-version={match.version} data-fx={fx}>
    <div className="uno-topbar">
      <div className="uno-topbar-info"><strong>UNO</strong><span className="round-label">Раунд {state.round}{state.mode === 'points' ? ' · до ' + state.target : ''}</span></div>
      <div className="toolbar-actions">
        {!ended && !state.paused && state.phase !== 'roundEnd' && <span className={'turn-clock' + (time <= 10 ? ' urgent' : '')} role="timer" aria-label="Время хода"><Clock3 size={13}/>{time} c</span>}
        {!ended && <div className="game-menu-wrap" ref={menuRef}><Button aria-expanded={menuOpen} aria-label="Меню партии" onClick={() => setMenuOpen(o => !o)}><Menu size={14}/>Меню</Button>{menuOpen && <div className="game-menu" role="menu">
          <div className="game-menu-players">{state.players.map(p => { const member = memberOf(p.id); return <div className="game-menu-player" key={p.id}><Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar><div><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><small>{p.out ? 'Вышел' : p.count + ' карт · ' + (state.scores[p.seat] ?? 0) + ' очк.'}</small></div></div>; })}</div>
          <p className="game-menu-rules">Кладите карту совпадающего цвета, числа или действия. Дикие карты меняют цвет. Оставаясь с одной картой, объявите UNO — иначе соперник поймает вас и добавит 2 карты.</p>
          <div className="game-menu-actions">{legal.canSurrender && <Button className="danger-button" disabled={busy} onClick={() => confirming ? void act({ type: 'surrender' }) : setConfirming(true)}>{confirming ? 'Точно сдаться? Партия продолжится без вас' : 'Сдаться'}</Button>}{state.players.find(p => p.out && p.id === ownId) && <Button onClick={onForfeitExit}><DoorOpen size={14}/>Покинуть комнату</Button>}</div>
        </div>}</div>}
      </div>
    </div>

    <div className="uno-stage" data-felt>
      <div className={'uno-opponents' + (opponents.length >= 5 ? ' crowded' : '')}>
        {opponents.map(({ p }) => {
          const member = memberOf(p.id);
          const isActor = state.actorId === p.id;
          const catchable = legal.catchable.includes(p.id);
          return <div className={'uno-seat' + (isActor && !ended ? ' active' : '') + (p.out ? ' out' : '')} key={p.id}>
            <Avatar src={member?.player.avatar} name={memberName(p.id)} className="opponent-avatar">{!member?.connected && <WifiOff size={11}/>}</Avatar>
            <div className="uno-seat-info"><strong>{memberName(p.id)}</strong>
              <span className="uno-seat-meta"><UnoCardBacks count={p.count}/>{p.unoCalled && <em className="uno-badge">UNO</em>}{p.owesUno && <em className="uno-badge warn">?</em>}</span>
            </div>
            {catchable && <button type="button" className="uno-catch" disabled={busy} onClick={() => void act({ type: 'catchUno', target: p.id })} aria-label={'Поймать ' + memberName(p.id) + ' без UNO'}><AlertTriangle size={12}/>Без UNO?</button>}
          </div>;
        })}
      </div>

      <div className="uno-center">
        <button type="button" className="uno-pile deck" disabled={!legal.canDraw || busy || ended} onClick={() => void act({ type: 'draw' })} aria-label={'Взять карту, осталось ' + state.deckCount}>
          <UnoCard back/>
          <span className="uno-pile-count">{state.deckCount}</span>
        </button>
        <div className="uno-discard" aria-label="Верхняя карта">
          <UnoCard id={state.topCard}/>
          <UnoColorChip color={state.currentColor}/>
        </div>
        <span className="uno-direction" title={state.direction === 1 ? 'По часовой стрелке' : 'Против часовой стрелки'}><DirectionIcon size={18}/></span>
      </div>

      <div className="table-status"><span className={ownTurn ? 'turn-light active' : 'turn-light'}/><strong role="status">{phaseName}</strong></div>
    </div>

    {state.phase === 'roundEnd' && !ended && <div className="uno-roundend" role="status">
      <Crown size={26}/>
      <h2>{memberName(state.roundWinner)} wins the round</h2>
      <p>+{state.roundPoints} очков{state.mode === 'points' ? ' · до ' + state.target : ''}</p>
      <div className="uno-scores">{standings.map(p => <div className={'uno-score' + (p.id === state.roundWinner ? ' winner' : '')} key={p.id}><span>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</span><strong>{state.scores[p.seat] ?? 0}</strong></div>)}</div>
      {legal.canNextRound && <Button disabled={busy} onClick={() => void act({ type: 'nextRound' })}>Следующий раунд</Button>}
      {!legal.canNextRound && <p className="muted">Ожидаем игроков…</p>}
    </div>}

    {ended ? <div className="uno-result" role="status">
      <Crown size={26}/>
      <h2>{match.status === 'interrupted' ? 'Партия прервана' : state.result?.draw ? 'Ничья' : state.result?.winners.includes(ownId) ? 'Победа!' : 'Партия окончена'}</h2>
      <p>{match.status === 'interrupted' ? 'Состояние сохранено. Результат не начислен.' : 'Результат сохранён'}{duration !== null && ' · ' + fmtDuration(duration)}</p>
      <div className="uno-scores">{standings.map(p => <div className={'uno-score' + (state.result?.winners.includes(p.id) ? ' winner' : '')} key={p.id}><Avatar src={memberOf(p.id)?.player.avatar} name={memberName(p.id)} className="opponent-avatar"/><strong>{memberName(p.id)}{p.id === ownId ? ' (вы)' : ''}</strong><span>{state.scores[p.seat] ?? 0} очк.</span></div>)}</div>
      {resultActions && <div className="button-row result-actions"><Button disabled={busy} onClick={resultActions.onToggleReady}>{resultActions.ready ? 'Отменить готовность' : 'Я готов — реванш'}</Button>{resultActions.isHost && <Button disabled={busy || !resultActions.canStart} onClick={resultActions.onStart}>Начать партию</Button>}<Button onClick={resultActions.onLeave}>Выйти в меню</Button></div>}
    </div> : <>
      <div className="uno-handbar">
        <UnoHand cards={state.hand} playable={playable} picked={colorPick !== null ? new Set<number>([colorPick]) : new Set<number>()} disabled={busy || !ownTurn || state.phase !== 'turn'} onToggle={tapCard}/>
      </div>
      <div className="uno-controls">
        {ownTurn && state.phase === 'turn' ? <>
          {legal.canDraw && <Button className="uno-draw" disabled={busy} onClick={() => void act({ type: 'draw' })}><Hand size={15}/>Взять</Button>}
          {legal.canPass && <Button disabled={busy} onClick={() => void act({ type: 'pass' })}>Пропустить</Button>}
        </> : state.phase === 'challenge' && state.challenge?.iAmChallenger ? <>
          <Button className="danger-button" disabled={busy} onClick={() => void act({ type: 'challenge' })}>Оспорить +4</Button>
          <span className="muted">иначе через {Math.max(0, Math.ceil((state.deadline - clock) / 1000))} c</span>
        </> : <p className="uno-waiting">{phaseName}</p>}
        {legal.canCallUno && <Button className="uno-call" disabled={busy} onClick={() => void act({ type: 'callUno' })}>UNO!</Button>}
      </div>
    </>}

    {showColorPicker && <div className="uno-colorpick" role="dialog" aria-label="Выберите цвет">
      <p><Palette size={15}/> Выберите цвет</p>
      <div className="uno-colorpick-row">{(['red', 'blue', 'green', 'yellow'] as const).map(color => <button key={color} type="button" className={'uno-colorbtn ' + color} style={{ background: UNO_COLORS[color].main }} aria-label={color} disabled={busy} onClick={() => pickColor(color)}/>)}</div>
      {colorPick !== null && <button type="button" className="text-button" onClick={() => setColorPick(null)}>Отмена</button>}
    </div>}
  </section>;
}
