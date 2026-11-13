import { rank, suit } from '@rize/durak/cards';

/** Client-side hand ordering for the Durak table. Pure functions only —
 * the server hand order and card ids are never touched. */
export type DurakSortMode = 'suit' | 'rank' | 'received';

export const DURAK_SORT_MODES: readonly DurakSortMode[] = ['suit', 'rank', 'received'];
export const DURAK_SORT_STORAGE_KEY = 'rize.arcade.durak.handSort';

export function isDurakSortMode(value: unknown): value is DurakSortMode {
  return typeof value === 'string' && (DURAK_SORT_MODES as readonly string[]).includes(value);
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadDurakSort(storage?: StorageLike | null): DurakSortMode {
  try {
    const store = storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage;
    const value = store?.getItem(DURAK_SORT_STORAGE_KEY);
    return isDurakSortMode(value) ? value : 'suit';
  } catch {
    return 'suit';
  }
}

export function saveDurakSort(mode: DurakSortMode, storage?: StorageLike | null): void {
  try {
    const store = storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : storage;
    store?.setItem(DURAK_SORT_STORAGE_KEY, mode);
  } catch { /* Private mode / quota — sorting still works for the session. */ }
}

/** Trump suit always sorts last; inside a suit ranks run 6 → A. */
function suitKey(card: number, trump: number): [number, number, number] {
  const s = suit(card);
  return [s === trump ? 1 : 0, s, rank(card)];
}

/** 'suit' — grouped by suit (trump last), 'rank' — by rank then suit,
 * 'received' — original server order. Always returns a new array. */
export function sortDurakHand(hand: readonly number[], mode: DurakSortMode, trump: number): number[] {
  const cards = [...hand];
  if (mode === 'received') return cards;
  if (mode === 'rank') {
    cards.sort((a, b) => rank(a) - rank(b) || suitKey(a, trump)[0] - suitKey(b, trump)[0] || suit(a) - suit(b));
    return cards;
  }
  cards.sort((a, b) => {
    const ka = suitKey(a, trump), kb = suitKey(b, trump);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
  return cards;
}
