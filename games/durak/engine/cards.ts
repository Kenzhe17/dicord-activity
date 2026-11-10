export const suits = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const ranks = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export const suit = (card: number) => Math.floor(card / 9);
export const rank = (card: number) => card % 9;
export const cardName = (card: number) => ranks[rank(card)] + ' ' + suits[suit(card)];
export const beats = (attack: number, defense: number, trump: number) => suit(attack) === suit(defense) ? rank(defense) > rank(attack) : suit(defense) === trump && suit(attack) !== trump;
/** Version 1 PRNG: Mulberry32. Seed never leaves the server checkpoint. */
export function random(seed: number) {
  let value = seed >>> 0;
  return () => { value = (value + 0x6D2B79F5) | 0; let t = Math.imul(value ^ value >>> 15, 1 | value); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shuffled(seed: number) {
  const rng = random(seed), deck = Array.from({ length: 36 }, (_, i) => i);
  for (let i = 35; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
  return { deck, dealer: Math.floor(rng() * 6) };
}
