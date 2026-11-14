import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { MotionStyle } from 'motion/react';
import { PlayingCard, playingCardLabel } from '../PlayingCard';
import { DURAK_SORT_MODES, loadDurakSort, saveDurakSort, sortDurakHand } from '../durakSort';
import type { DurakSortMode } from '../durakSort';
import { fanMetrics } from './contracts';
import type { DurakHandProps } from './contracts';
import { useArcade } from '../../store';
import './durakHand.css';

const SORT_LABELS: Record<DurakSortMode, string> = { suit: 'По мастям', rank: 'По достоинству', received: 'Как получены' };
const SUIT_COLORS = ['#8fb7c9', '#d98a94', '#d98a94', '#c9c3d9'];
const TAP_SLOP = 8, TAP_MS = 400;

interface DragRef { card: number; pointerId: number; x0: number; y0: number; t0: number; dragging: boolean }

export function DurakHand({ cards, trump, playable, selected, disabled, onToggle, onDropCard, sortMode: controlledSort, onSortMode }: DurakHandProps) {
  const { preferences } = useArcade();
  const reduced = preferences.reducedMotion;
  const [innerSort, setInnerSort] = useState<DurakSortMode>(() => loadDurakSort());
  const sortMode = controlledSort ?? innerSort;
  const changeSort = (mode: DurakSortMode) => {
    if (onSortMode) onSortMode(mode); else { setInnerSort(mode); saveDurakSort(mode); }
  };
  const [width, setWidth] = useState(360);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragRef | null>(null);
  const lastDownAt = useRef(0);
  const pendingTap = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const [dragPos, setDragPos] = useState<{ card: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const sorted = useMemo(() => sortDurakHand(cards, sortMode, trump), [cards, sortMode, trump]);
  const metrics = fanMetrics(sorted.length, Math.max(width, 200));
  const count = sorted.length;
  const totalWidth = count > 0 ? metrics.cardWidth + (count - 1) * metrics.step : 0;
  const fitScale = totalWidth > width && totalWidth > 0 ? Math.max(0.7, width / totalWidth) : 1;
  const sel = useMemo(() => new Set(selected), [selected]);

  const canDrag = (card: number) => !!onDropCard && !disabled && playable.has(card);

  const handleDown = (card: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    lastDownAt.current = performance.now();
    dragRef.current = { card, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), dragging: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  };

  const handleMove = (card: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || d.card !== card || d.pointerId !== e.pointerId) return;
    if (!d.dragging && canDrag(card) && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > TAP_SLOP) {
      d.dragging = true;
      setDragPos({ card, x: e.clientX, y: e.clientY });
    } else if (d.dragging) {
      setDragPos({ card, x: e.clientX, y: e.clientY });
    }
  };

  const finish = (card: number, e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || d.card !== card || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (d.dragging) {
      setDragPos(null);
      suppressClick.current = true;
      if (!cancelled && onDropCard) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el?.closest('[data-felt]')) {
          const attackEl = el.closest('[data-attack-card]');
          const raw = attackEl?.getAttribute('data-attack-card');
          const target = raw == null ? null : Number(raw);
          onDropCard(card, target != null && Number.isFinite(target) ? target : null);
        }
      }
      return;
    }
    const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    const dt = performance.now() - d.t0;
    pendingTap.current = !cancelled && dist <= TAP_SLOP && dt <= TAP_MS ? card : null;
  };

  const handleClick = (card: number) => () => {
    const wasTap = pendingTap.current === card;
    pendingTap.current = null;
    if (suppressClick.current) { suppressClick.current = false; return; }
    // Click without a recent pointerdown is keyboard (Enter/Space) activation.
    if (wasTap || performance.now() - lastDownAt.current > 500) onToggle(card);
  };

  const mid = (count - 1) / 2;
  return <div className="durak-hand-root">
    {!onSortMode && <div className="durak-hand-sort" role="group" aria-label="Сортировка карт">
      {DURAK_SORT_MODES.map(mode => <button key={mode} type="button" className={sortMode === mode ? 'active' : ''} aria-pressed={sortMode === mode} onClick={() => changeSort(mode)}>{SORT_LABELS[mode]}</button>)}
    </div>}
    <div className="durak-hand-measure" ref={wrapRef}>
      <div className="durak-hand-fan" style={{ transform: fitScale < 1 ? 'scale(' + fitScale + ')' : undefined }}>
        <AnimatePresence>
          {sorted.map((c, i) => {
            const isSel = sel.has(c), isPlayable = playable.has(c);
            const edge = count > 1 ? Math.abs(i - mid) / mid : 0;
            const angle = count > 1 ? ((i - mid) / mid) * metrics.spread : 0;
            const dy = metrics.lift * edge * edge - (isSel ? 14 : isPlayable && !disabled ? 3 : 0);
            // Playable cards must always sit above non-playable neighbours:
            // a disabled card in the fan centre otherwise swallows their taps.
            const z = isSel ? 90 : (isPlayable ? 50 : 20) - Math.round(edge * 8);
            return <motion.button
              key={c}
              type="button"
              className={'durak-hand-card' + (isSel ? ' selected' : '') + (isPlayable ? ' playable' : '') + (Math.floor(c / 9) === trump ? ' is-trump' : '')}
              style={{ width: metrics.cardWidth, marginLeft: i === 0 ? 0 : -(metrics.cardWidth - metrics.step), zIndex: z, transformOrigin: '50% 100%', '--tc': SUIT_COLORS[Math.floor(c / 9)] } as MotionStyle}
              initial={reduced ? false : { y: -40, opacity: 0, rotate: 0 }}
              animate={{ y: dy, rotate: reduced ? 0 : angle, opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { y: -65, opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.18, delay: reduced ? 0 : i * 0.03, ease: 'easeOut' }}
              aria-label={playingCardLabel(c)}
              aria-pressed={isSel}
              data-hand-card={c}
              disabled={!isPlayable || disabled}
              onPointerDown={handleDown(c)}
              onPointerMove={handleMove(c)}
              onPointerUp={e => finish(c, e, false)}
              onPointerCancel={e => finish(c, e, true)}
              onClick={handleClick(c)}
            ><PlayingCard card={c}/></motion.button>;
          })}
        </AnimatePresence>
      </div>
    </div>
    {dragPos && <div className="durak-hand-drag" style={{ left: dragPos.x, top: dragPos.y, width: metrics.cardWidth }} aria-hidden="true"><PlayingCard card={dragPos.card}/></div>}
  </div>;
}
