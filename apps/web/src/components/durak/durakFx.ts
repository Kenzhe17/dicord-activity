/**
 * Durak FX layer — derives ephemeral animation events from DurakView
 * diffs (contracts.deriveFx) and renders purely decorative overlays plus
 * synthesized audio. NEVER mutates game state.
 *
 * Integration contract:
 *  - Parent calls `observe(view, match.version)` once per render commit
 *    (e.g. in a useEffect) and renders <DurakFxLayer event={fx.event} />
 *    inside the felt container ([data-felt]), which MUST be
 *    position:relative — the layer is absolutely positioned inset:0 and
 *    relies on the nearest positioned ancestor.
 *  - All effects are centered/table-edge generic flourishes because exact
 *    card pixel positions are not available at this layer.
 *  - 'finished' is intentionally silent here: the parent knows win/lose
 *    from match.result and should call playDurakSound('win'|'lose')
 *    itself (see durakSound.ts). soundForFx(kind,false) is used for the
 *    rest.
 *  - `muted` suppresses synthesized audio for this layer only.
 *
 * NOTE: this file is .ts (not .tsx) per contract, so the layer is built
 * with createElement instead of JSX.
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { DurakView } from '@rize/durak';
import { deriveFx, soundForFx } from './contracts';
import type { DurakFxController, DurakFxEvent, DurakFxKind } from './contracts';
import { playDurakSound } from './durakSound';
import { useArcade } from '../../store';
import './durakFx.css';

/** How long each event kind stays mounted (matches CSS durations). */
const FX_MS: Record<DurakFxKind, number> = {
  deal: 1000,
  attack: 650,
  defend: 700,
  transfer: 650,
  throw: 650,
  take: 750,
  pass: 500,
  discard: 750,
  pickup: 750,
  pause: 600,
  resume: 600,
  surrender: 850,
  finished: 2000,
};

/**
 * Imperative FX hook. Call observe(view, version) every render commit.
 * Latest wins: a newer observe replaces the pending event before its
 * animation completes. A version regression (reconnect/reload) resets the
 * diff baseline and emits nothing.
 */
export function useDurakFx(): DurakFxController {
  const prevRef = useRef<DurakView | null>(null);
  const lastVersionRef = useRef(-1);
  const [event, setEvent] = useState<DurakFxEvent | null>(null);

  const observe = useCallback((view: DurakView, version: number) => {
    if (version < lastVersionRef.current) {
      prevRef.current = view;
      lastVersionRef.current = version;
      setEvent(null);
      return;
    }
    lastVersionRef.current = version;
    const fx = deriveFx(prevRef.current, view, version);
    prevRef.current = view;
    if (fx) setEvent(fx); // null diff => keep whatever is still animating
  }, []);

  // Stale-event safety: auto-clear once the animation has had time to play.
  useEffect(() => {
    if (!event) return;
    const timer = setTimeout(() => setEvent(null), FX_MS[event.kind]);
    return () => clearTimeout(timer);
  }, [event]);

  return { event, observe };
}

const FAN_CARDS = [0, 1, 2, 3, 4];
const SLIDE_CARDS = [0, 1, 2];
const CONFETTI = Array.from({ length: 18 }, (_, i) => ({
  left: 6 + ((i * 53) % 88),
  delay: (i % 6) * 0.11,
  duration: 1.15 + (i % 5) * 0.16,
  drift: ((i * 31) % 48) - 24,
  gold: i % 3 !== 0,
}));

function chipStyle(i: number, count: number): CSSProperties {
  const mid = (count - 1) / 2;
  return {
    ['--tx' as string]: `${(i - mid) * 26}px`,
    ['--rot' as string]: `${(i - mid) * 9}deg`,
    animationDelay: `${i * 0.05}s`,
  } as CSSProperties;
}

function confettiStyle(p: (typeof CONFETTI)[number]): CSSProperties {
  return {
    left: `${p.left}%`,
    animationDelay: `${p.delay}s`,
    animationDuration: `${p.duration}s`,
    ['--drift' as string]: `${p.drift}px`,
    background: p.gold ? 'linear-gradient(160deg,#f5d67b,#d4a437)' : 'linear-gradient(160deg,#fdf3d8,#e8d9b0)',
  } as CSSProperties;
}

function chips(counts: number[]): ReactNode {
  return counts.map(i => createElement('span', { key: i, className: 'durak-fx-chip', style: chipStyle(i, counts.length) }));
}

function fxBody(kind: DurakFxKind): ReactNode {
  switch (kind) {
    case 'deal':
      return createElement('div', { className: 'durak-fx durak-fx-deal' }, chips(FAN_CARDS));
    case 'attack':
    case 'throw':
    case 'transfer':
      return createElement('div', { className: 'durak-fx durak-fx-flip' });
    case 'defend':
      return createElement('div', { className: 'durak-fx durak-fx-shield' });
    case 'take':
    case 'pickup':
      return createElement('div', { className: 'durak-fx durak-fx-slide' }, chips(SLIDE_CARDS));
    case 'discard':
      return createElement('div', { className: 'durak-fx durak-fx-sweep' });
    case 'finished':
      return createElement(
        'div',
        { className: 'durak-fx durak-fx-confetti' },
        CONFETTI.map((p, i) => createElement('span', { key: i, className: 'durak-fx-particle', style: confettiStyle(p) })),
      );
    case 'surrender':
      return createElement('div', { className: 'durak-fx durak-fx-surrender' });
    case 'pause':
    case 'resume':
    case 'pass':
    default:
      return createElement('div', { className: 'durak-fx durak-fx-ripple' });
  }
}

/** Purely decorative overlay. Parent MUST wrap in a position:relative
 * container (the felt element carries data-felt). pointer-events:none. */
export function DurakFxLayer({ event, muted }: { event: DurakFxEvent | null; muted?: boolean }) {
  const reducedMotion = useArcade(s => s.preferences.reducedMotion);

  useEffect(() => {
    if (!event || event.kind === 'finished' || muted) return;
    const sound = soundForFx(event.kind, false);
    if (sound) playDurakSound(sound);
  }, [event, muted]);

  if (!event) return null;

  if (reducedMotion) {
    // Minimal: a single short fade for game-over, nothing otherwise.
    return event.kind === 'finished'
      ? createElement('div', { className: 'durak-fx-layer reduced-motion', 'aria-hidden': true },
          createElement('div', { className: 'durak-fx durak-fx-fade' }))
      : null;
  }

  return createElement(
    'div',
    { className: 'durak-fx-layer', 'aria-hidden': true },
    createElement('div', { key: `${event.version}:${event.kind}`, className: 'durak-fx-host' }, fxBody(event.kind)),
  );
}
