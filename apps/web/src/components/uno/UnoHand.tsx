import { useLayoutEffect, useRef, useState } from 'react';
import { UnoCard } from './UnoCard';

interface FanMetrics { cardW: number; cardH: number; step: number; lift: number }

function metrics(count: number, width: number): FanMetrics {
  // Narrow screens get smaller cards so the fan keeps a tappable exposed strip.
  const cap = width < 560 ? 54 : 62;
  const cardW = Math.round(Math.min(cap, Math.max(26, width / Math.max(count * 0.62, 1))));
  const cardH = Math.round(cardW * 1.45);
  // Rotated edge cards overshoot their layout box; reserve bleed so the fan
  // never clips outside the viewport on narrow screens.
  const bleed = Math.ceil(cardH * 0.19) + 2;
  const avail = Math.max(width - bleed * 2, cardW + 24);
  const step = count > 1 ? Math.min(cardW - 3, Math.max(9, (avail - cardW) / (count - 1))) : cardW;
  return { cardW, cardH, step, lift: Math.min(16, count * 0.9) };
}

/** Own-hand card fan. Cards overlap, playable ones lift and glow. */
export function UnoHand({ cards, playable, picked, disabled, onToggle }: {
  cards: number[];
  playable: ReadonlySet<number>;
  picked: ReadonlySet<number>;
  disabled: boolean;
  onToggle: (card: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || 360);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const n = cards.length;
  const m = metrics(n, width);
  const center = (n - 1) / 2;
  return <div className="uno-hand" ref={ref} role="group" aria-label="Ваши карты">
    {cards.map((id, i) => {
      const norm = n > 1 ? (i - center) / center : 0;
      const offset = (i - center) * m.step;
      // Dense hands fan flatter so rotated corners don't cover neighbours' tap area.
      const rotation = Math.max(-22, Math.min(22, norm * (n > 9 ? 14 : 20)));
      const arc = -Math.abs(norm) * m.lift * 0.4;
      const canPlay = playable.has(id);
      const isPicked = picked.has(id);
      const style = {
        width: m.cardW, height: m.cardH,
        transform: 'translateX(-50%) translateX(' + offset + 'px) translateY(' + (arc + (isPicked ? -16 : canPlay ? -10 : 0)) + 'px) rotate(' + rotation + 'deg)',
        zIndex: isPicked ? 60 : canPlay ? 40 + i : i,
      };
      return <button key={id} type="button" data-hand-card={id}
        className={'uno-hand-card' + (canPlay ? ' playable' : '') + (isPicked ? ' picked' : '') + (disabled ? ' disabled' : '')}
        style={style} disabled={disabled && !canPlay}
        aria-label={(canPlay ? 'Сыграть ' : 'Карта ') + id}
        onClick={() => { if (canPlay && !disabled) onToggle(id); }}>
        <UnoCard id={id}/>
      </button>;
    })}
  </div>;
}

/** Face-down card row used for opponents' hands, plus a compact count chip
 * revealed by .uno-opponents.crowded on narrow screens. */
export function UnoCardBacks({ count, small = true }: { count: number; small?: boolean }) {
  const shown = Math.min(count, small ? 3 : 10);
  return <>
    <span className="uno-backs" aria-label={count + ' карт'}>
      {Array.from({ length: shown }, (_, i) => <UnoCard key={i} back small={small}/>)}
      {count > shown && <em>+{count - shown}</em>}
    </span>
    <span className="uno-count" aria-hidden="true">{count}</span>
  </>;
}
