/**
 * UNO card encoding — pure helpers, no I/O.
 *
 * Physical deck: 108 unique cards, ids 0..107.
 *   ids 0..99   — colored cards: id = colorIndex * 25 + slot (slot 0..24)
 *   ids 100..103 — Wild
 *   ids 104..107 — Wild Draw Four
 * Colored slots: 0 → number 0; 1..18 → numbers 1..9 (two copies each);
 * 19,20 → Skip; 21,22 → Reverse; 23,24 → Draw Two.
 */
export const COLORS = ['red', 'blue', 'green', 'yellow'] as const;
export type UnoColor = (typeof COLORS)[number];
export const colorIndex = (color: UnoColor) => COLORS.indexOf(color);

export type UnoRank = number | 'skip' | 'reverse' | 'draw2' | 'wild' | 'draw4';
export interface UnoCardInfo { readonly id: number; readonly color: UnoColor | null; readonly rank: UnoRank }

const ACTION_RANKS = ['skip', 'reverse', 'draw2'] as const;

export function cardInfo(id: number): UnoCardInfo {
  if (id >= 104) return { id, color: null, rank: 'draw4' };
  if (id >= 100) return { id, color: null, rank: 'wild' };
  const color = COLORS[Math.floor(id / 25)]!;
  const slot = id % 25;
  if (slot === 0) return { id, color, rank: 0 };
  if (slot <= 18) return { id, color, rank: Math.ceil(slot / 2) };
  return { id, color, rank: ACTION_RANKS[(slot - 19) >> 1]! };
}

export const cardColor = (id: number): UnoColor | null => cardInfo(id).color;
export const cardRank = (id: number): UnoRank => cardInfo(id).rank;
export const isWild = (id: number) => cardInfo(id).rank === 'wild' || cardInfo(id).rank === 'draw4';

/** Points a card contributes to the winner's score when left in a hand. */
export function cardPoints(id: number): number {
  const rank = cardInfo(id).rank;
  if (typeof rank === 'number') return rank;
  return rank === 'wild' || rank === 'draw4' ? 50 : 20;
}

/** A card may be played on the pile when it is wild, shares the active
 * color, or repeats the top card's rank (numbers match numbers, action
 * cards match the same action type across colors). */
export function isPlayable(card: number, top: number, activeColor: UnoColor): boolean {
  const info = cardInfo(card);
  if (info.rank === 'wild' || info.rank === 'draw4') return true;
  if (info.color === activeColor) return true;
  return cardInfo(top).rank === info.rank;
}

/** Official +4 check: the play is legal only when the actor holds no card
 * matching the color in play — Wild cards count as a match. Evaluated on
 * the actor's hand AFTER the Wild Draw Four itself was removed. */
export function holdsColorMatch(hand: readonly number[], activeColor: UnoColor): boolean {
  return hand.some(id => isWild(id) || cardColor(id) === activeColor);
}

/** Version 1 PRNG: Mulberry32. Seed never leaves the server checkpoint. */
export function random(seed: number) {
  let value = seed >>> 0;
  return () => { value = (value + 0x6D2B79F5) | 0; let t = Math.imul(value ^ value >>> 15, 1 | value); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Deterministic shuffle keyed by (seed, shuffleIndex) so replaying the
 * action log reproduces every reshuffle without storing RNG state. */
export function shuffled(seed: number, index: number): number[] {
  const rng = random((seed ^ Math.imul(index + 1, 0x9E3779B9)) >>> 0);
  const deck = Array.from({ length: 108 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
  return deck;
}
