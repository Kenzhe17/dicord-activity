/**
 * Durak mobile rebuild — shared contracts.
 * These types are the ONLY interface between the table layout, hand
 * interaction, animation and multiplayer layers. Do not change without
 * Lead Architect approval.
 */
import type { DurakView, DurakAction } from '@rize/durak';
import type { DurakSortMode } from '../durakSort';

/** Logical seat index (0..n-1) of a player id inside DurakView.players order. */
export function seatOf(view: DurakView, playerId: string): number {
  return view.players.findIndex(p => p.id === playerId);
}

/** Normalized table position in percent of the felt area (0..100 x, 0..100 y).
 * Own seat is always bottom-center (50, 88). Opponents are distributed along
 * the top arc; with 5-6 players two extra seats sit on the mid sides. */
export interface SeatPoint { x: number; y: number }
export function seatPosition(seat: number, total: number, ownSeat: number): SeatPoint {
  if (seat === ownSeat) return { x: 50, y: 88 };
  const opponents = total - 1;
  // Order opponents by distance clockwise from own seat so they read naturally.
  const rel = (seat - ownSeat + total) % total; // 1..total-1
  if (opponents <= 3) {
    // 2-4 players: spread across the top arc
    const t = rel / (opponents + 1); // 0..1
    return { x: 12 + t * 76, y: 14 + Math.sin(t * Math.PI) * -4 };
  }
  // 5-6 players: 4 across top, extras at mid-left / mid-right
  const top = opponents <= 4 ? opponents : 4;
  if (rel <= top) {
    const t = rel / (top + 1);
    return { x: 10 + t * 80, y: 12 };
  }
  return rel === top + 1 ? { x: 4, y: 46 } : { x: 96, y: 46 };
}

/** Animation/FX event derived from a version diff. `kind` drives visuals+sound.
 * Events are ephemeral: the latest match.version wins, stale ones are dropped. */
export type DurakFxKind =
  | 'deal' | 'attack' | 'defend' | 'transfer' | 'throw'
  | 'take' | 'pass' | 'discard' | 'pickup'
  | 'pause' | 'resume' | 'surrender' | 'finished';
export interface DurakFxEvent {
  kind: DurakFxKind;
  version: number;          // match.version that produced it
  actorId: string | null;   // player who caused it (null for system)
  cards: number[];          // cards involved this transition (may be empty)
}

/** Derive the fx event for a state transition. Pure: no side effects.
 * `prev` may be null on first render/reconnect — returns null then. */
export function deriveFx(prev: DurakView | null, next: DurakView, version: number): DurakFxEvent | null {
  if (!prev) return null;
  // A new bout or a new lastEvent marks a transition worth animating.
  if (prev.bout === next.bout && prev.lastEvent === next.lastEvent && prev.phase === next.phase) return null;
  const added = next.table.length - prev.table.length;
  const cards = added > 0 ? next.table.slice(-added).map(p => p.attack) : [];
  return { kind: next.lastEvent as DurakFxKind, version, actorId: next.actorId, cards };
}

/** Sound names — mapped to WebAudio synth in durakSound.ts (no audio files). */
export type DurakSound = 'deal' | 'play' | 'defend' | 'take' | 'pass' | 'win' | 'lose' | 'turn';
export function soundForFx(kind: DurakFxKind, isLoser: boolean): DurakSound | null {
  switch (kind) {
    case 'deal': return 'deal';
    case 'attack': case 'throw': case 'transfer': return 'play';
    case 'defend': return 'defend';
    case 'take': case 'pickup': return 'take';
    case 'pass': return 'pass';
    case 'finished': return isLoser ? 'lose' : 'win';
    default: return null;
  }
}

/** Hand fan geometry input: number of cards and available width in px. */
export interface FanMetrics {
  cardWidth: number;    // px, capped (e.g. <= 86)
  cardHeight: number;   // px, keeps 80:116 ratio
  step: number;         // px horizontal offset between adjacent cards
  lift: number;         // px vertical lift of edge cards (arc)
  spread: number;       // half-angle in degrees for the outermost cards
  overflow: boolean;    // true when hand exceeds comfortable width
}
export function fanMetrics(count: number, availableWidth: number): FanMetrics {
  if (count <= 0) return { cardWidth: 0, cardHeight: 0, step: 0, lift: 0, spread: 0, overflow: false };
  // Overlap ratio shrinks as the hand grows so every card stays distinguishable.
  const f = count <= 6 ? 0.64 : count <= 10 ? 0.5 : count <= 16 ? 0.38 : 0.3;
  const w = Math.min(64, Math.max(26, availableWidth / (1 + (count - 1) * f)));
  const step = count > 1 ? Math.min(w * f, (availableWidth - w) / (count - 1)) : w;
  const spread = count <= 3 ? 7 : Math.min(10, 60 / count);
  return { cardWidth: w, cardHeight: Math.round(w * 116 / 80), step: Math.max(8, step), lift: Math.min(14, count * 1.1), spread, overflow: w + (count - 1) * step > availableWidth };
}

export type { DurakView, DurakAction };

/* ------------------------------------------------------------------ */
/* Component prop contracts — implement exactly, do not deviate.       */
/* ------------------------------------------------------------------ */

/** Dumb presentational own-hand fan. Owns sorting internally.
 * Implemented by the Card Interaction agent in ./DurakHand.tsx */
export interface DurakHandProps {
  /** Own hand card ids, unsorted. */
  cards: number[];
  /** Trump suit index 0..3 (clubs,diamonds,hearts,spades). */
  trump: number;
  /** Card ids the server currently allows this player to play. */
  playable: ReadonlySet<number>;
  /** Currently selected card ids (multi-select for same-rank attacks). */
  selected: readonly number[];
  /** True while a move is in flight or it is not this player's decision. */
  disabled: boolean;
  /** Called when the player taps a card. Parent decides select semantics. */
  onToggle: (card: number) => void;
  /** Optional drag-and-drop. When set, cards become draggable onto the felt.
   * `targetAttack` is the attack card id dropped onto, or null for table center.
   * Parent validates and submits the resulting DurakAction.
   * DOM contract: attack cards on the table carry `data-attack-card={cardId}`,
   * the felt container carries `data-felt`. Hand hit-tests via elementFromPoint. */
  onDropCard?: ((card: number, targetAttack: number | null) => void) | undefined;
  /** Optional controlled sort mode. When both are provided the internal sort
   * picker is hidden and the parent owns sorting (e.g. table menu). */
  sortMode?: DurakSortMode | undefined;
  onSortMode?: ((mode: DurakSortMode) => void) | undefined;
}

/** Opponent seat on the felt. Implemented in ./DurakSeat.tsx */
export interface DurakSeatProps {
  view: DurakView;
  seat: number;               // logical seat index in view.players order
  ownSeat: number;
  memberName: string;
  avatarUrl: string | null;
  connected: boolean;
  position: SeatPoint;        // from seatPosition()
  isActor: boolean;
  isDefender: boolean;
  isOut: boolean;
  isSelf?: boolean;
}

/** Imperative FX hook contract — implemented in ./durakFx.ts.
 * Returns the latest non-stale event; consumers render <DurakFxLayer/>. */
export interface DurakFxController {
  event: DurakFxEvent | null;
  /** Call once per render commit with the newest view. */
  observe: (view: DurakView, version: number) => void;
}
