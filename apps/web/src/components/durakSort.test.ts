import { describe, expect, it } from 'vitest';
import { rank, suit } from '@rize/durak/cards';
import { DURAK_SORT_MODES, isDurakSortMode, loadDurakSort, saveDurakSort, sortDurakHand } from './durakSort';

const TRUMP = 2; // hearts
const hand = [0, 9, 18, 27, 1, 10, 19, 28, 8, 17, 26, 35]; // mixed suits/ranks
const fullDeck = Array.from({ length: 36 }, (_, i) => i);

const memStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
};

describe('durak hand sorting', () => {
  it('groups by suit with trump last and ranks 6→A inside each suit', () => {
    const sorted = sortDurakHand(fullDeck, 'suit', TRUMP);
    const lastNonTrump = sorted.map((c, i) => (suit(c) === TRUMP ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    const firstTrump = sorted.findIndex(c => suit(c) === TRUMP);
    expect(firstTrump).toBeGreaterThan(lastNonTrump);
    expect(firstTrump).toBe(27); // 3 non-trump suits × 9 cards first
    // non-trump suits keep canonical order
    const nonTrumpSuits = sorted.slice(0, 27).map(suit);
    expect(nonTrumpSuits.filter((_, i) => i % 9 === 0)).toEqual([0, 1, 3]);
    // within each suit ranks ascend 6→A
    for (const s of [0, 1, 3, TRUMP]) {
      const group = sorted.filter(c => suit(c) === s).map(rank);
      expect(group).toEqual([...group].sort((a, b) => a - b));
      expect(group[0]).toBe(0);
      expect(group.at(-1)).toBe(8);
    }
  });

  it('keeps trump last even when trump is the first canonical suit', () => {
    const sorted = sortDurakHand(fullDeck, 'suit', 0);
    expect(sorted.slice(-9).every(c => suit(c) === 0)).toBe(true);
    expect(sorted.slice(0, 9).every(c => suit(c) === 1)).toBe(true);
  });

  it('sorts by rank with suit as tiebreak', () => {
    const sorted = sortDurakHand(hand, 'rank', TRUMP);
    const ranks = sorted.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // same rank -> grouped, trump suit last inside the rank
    const sixes = sorted.filter(c => rank(c) === 0);
    expect(sixes.length).toBe(4);
    expect(suit(sixes.at(-1)!)).toBe(TRUMP);
  });

  it('returns the received order untouched', () => {
    expect(sortDurakHand(hand, 'received', TRUMP)).toEqual(hand);
    expect(sortDurakHand(hand, 'received', TRUMP)).not.toBe(hand);
  });

  it('never loses or duplicates cards, including a 30-card hand', () => {
    const big = fullDeck.slice(0, 30);
    for (const mode of DURAK_SORT_MODES) {
      const sorted = sortDurakHand(big, mode, TRUMP);
      expect(sorted).toHaveLength(big.length);
      expect(new Set(sorted).size).toBe(big.length);
      expect([...sorted].sort((a, b) => a - b)).toEqual([...big].sort((a, b) => a - b));
    }
    const sorted30 = sortDurakHand(big, 'suit', TRUMP);
    expect(sorted30[0]).toBeDefined();
    expect(sorted30.at(-1)).toBeDefined();
  });

  it('keeps selection valid because card ids are stable across modes', () => {
    const selected = [hand[3]!, hand[7]!];
    for (const mode of DURAK_SORT_MODES) {
      const sorted = sortDurakHand(hand, mode, TRUMP);
      expect(selected.every(c => sorted.includes(c))).toBe(true);
    }
  });
});

describe('durak sort persistence', () => {
  it('defaults to suit and round-trips through storage', () => {
    const store = memStorage();
    expect(loadDurakSort(store)).toBe('suit');
    saveDurakSort('rank', store);
    expect(loadDurakSort(store)).toBe('rank');
    expect(store.map.get('rize.arcade.durak.handSort')).toBe('rank');
    store.map.set('rize.arcade.durak.handSort', 'bogus');
    expect(loadDurakSort(store)).toBe('suit');
  });
  it('validates mode values', () => {
    expect(isDurakSortMode('suit')).toBe(true);
    expect(isDurakSortMode('received')).toBe(true);
    expect(isDurakSortMode('nope')).toBe(false);
    expect(isDurakSortMode(3)).toBe(false);
  });
});
