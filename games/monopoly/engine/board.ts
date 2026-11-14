/** Original 40-cell board for r!z3 Arcade Monopoly. All names, prices and
 * rents are original work — no Monopoly (Hasbro/Unity) assets or names. */

export type CellKind = 'go' | 'property' | 'station' | 'utility' | 'chance' | 'community' | 'tax' | 'jail' | 'parking' | 'gotojail';
export type DeckKind = 'chance' | 'community';

export interface PropertyDef {
  readonly index: number;
  readonly kind: 'property' | 'station' | 'utility';
  readonly name: string;
  readonly price: number;
  /** Color group id for streets; null for stations/utilities. */
  readonly group: string | null;
  /** Rent per building level 0..5 (level 5 = hotel). Ignored for station/utility. */
  readonly rents: readonly number[];
  /** Cost per building level; 0 for station/utility (not buildable). */
  readonly houseCost: number;
}

export interface CellDef {
  readonly index: number;
  readonly kind: CellKind;
  readonly name: string;
  readonly tax?: number;
  readonly deck?: DeckKind;
  readonly property?: PropertyDef;
}

interface GroupDef { readonly id: string; readonly name: string; readonly color: string; readonly indices: readonly number[] }

const street = (index: number, name: string, price: number, group: string, rents: readonly number[], houseCost: number): PropertyDef =>
  ({ index, kind: 'property', name, price, group, rents, houseCost });
const station = (index: number, name: string): PropertyDef =>
  ({ index, kind: 'station', name, price: 200, group: null, rents: STATION_RENTS, houseCost: 0 });
const utility = (index: number, name: string): PropertyDef =>
  ({ index, kind: 'utility', name, price: 150, group: null, rents: UTILITY_RENTS, houseCost: 0 });

const STATION_RENTS = [0, 25, 50, 100, 200, 200] as const;
const UTILITY_RENTS = [0, 4, 10, 10, 10, 10] as const; // multiplier of dice total, stored as levels for shape compatibility

export const GROUPS: readonly GroupDef[] = [
  { id: 'brown', name: 'Бурые', color: '#8d6e63', indices: [1, 3] },
  { id: 'sky', name: 'Небесные', color: '#4fc3f7', indices: [6, 8, 9] },
  { id: 'pink', name: 'Розовые', color: '#f48fb1', indices: [11, 13, 14] },
  { id: 'orange', name: 'Оранжевые', color: '#ffb74d', indices: [17, 18, 19] },
  { id: 'red', name: 'Красные', color: '#e57373', indices: [21, 23, 24] },
  { id: 'yellow', name: 'Жёлтые', color: '#fff176', indices: [26, 27, 29] },
  { id: 'green', name: 'Зелёные', color: '#81c784', indices: [31, 33] },
  { id: 'navy', name: 'Тёмно-синие', color: '#5c6bc0', indices: [37, 39] },
] as const;

const GROUP_OF = new Map<number, GroupDef>();
for (const group of GROUPS) for (const index of group.indices) GROUP_OF.set(index, group);

function cell(index: number, kind: CellKind, name: string, extra: Partial<CellDef> = {}): CellDef {
  return { index, kind, name, ...extra };
}
function own(index: number, property: PropertyDef): CellDef {
  return cell(index, property.kind, property.name, { property });
}

export const BOARD: readonly CellDef[] = [
  cell(0, 'go', 'Старт', {}),
  own(1, street(1, 'Уютный двор', 60, 'brown', [2, 10, 30, 90, 160, 250], 50)),
  cell(2, 'chance', 'Шанс', { deck: 'chance' }),
  own(3, street(3, 'Тихий переулок', 60, 'brown', [4, 20, 60, 180, 320, 450], 50)),
  cell(4, 'tax', 'Клубный сбор', { tax: 200 }),
  own(5, station(5, 'Вокзал «Блиц»')),
  own(6, street(6, 'Неоновая аллея', 100, 'sky', [6, 30, 90, 270, 400, 550], 50)),
  cell(7, 'chance', 'Шанс', { deck: 'chance' }),
  own(8, street(8, 'Стеклянный бульвар', 120, 'sky', [8, 40, 100, 300, 450, 600], 50)),
  own(9, street(9, 'Лазерная набережная', 140, 'sky', [10, 50, 120, 330, 500, 700], 50)),
  cell(10, 'jail', 'Тюрьма', {}),
  own(11, street(11, 'Клубная улица', 140, 'pink', [10, 50, 150, 450, 625, 750], 100)),
  own(12, utility(12, 'Электростанция')),
  own(13, street(13, 'Виниловый ряд', 160, 'pink', [12, 60, 180, 500, 700, 900], 100)),
  own(14, street(14, 'Звёздный проспект', 180, 'pink', [14, 70, 200, 550, 750, 950], 100)),
  own(15, station(15, 'Вокзал «Ритм»')),
  cell(16, 'community', 'Сообщество', { deck: 'community' }),
  own(17, street(17, 'Апельсиновая набережная', 180, 'orange', [14, 70, 200, 550, 750, 950], 100)),
  own(18, street(18, 'Фонарный переулок', 200, 'orange', [16, 80, 220, 600, 800, 1000], 100)),
  own(19, street(19, 'Закатная улица', 220, 'orange', [18, 90, 250, 700, 875, 1050], 100)),
  cell(20, 'parking', 'Финальная стоянка', {}),
  own(21, street(21, 'Карточный квартал', 220, 'red', [18, 90, 250, 700, 875, 1050], 150)),
  cell(22, 'chance', 'Шанс', { deck: 'chance' }),
  own(23, street(23, 'Гранд-авеню', 240, 'red', [20, 100, 300, 750, 925, 1100], 150)),
  own(24, street(24, 'Банковский бульвар', 260, 'red', [22, 110, 330, 800, 975, 1150], 150)),
  own(25, station(25, 'Вокзал «Эхо»')),
  own(26, street(26, 'Солнечная аллея', 260, 'yellow', [22, 110, 330, 800, 975, 1150], 150)),
  own(27, street(27, 'Пикниковый парк', 280, 'yellow', [24, 120, 360, 850, 1025, 1200], 150)),
  own(28, utility(28, 'Водоканал')),
  own(29, street(29, 'Летний бульвар', 300, 'yellow', [26, 130, 390, 900, 1100, 1275], 150)),
  cell(30, 'gotojail', 'В тюрьму', {}),
  own(31, street(31, 'Изумрудная набережная', 300, 'green', [26, 150, 450, 1000, 1200, 1400], 200)),
  cell(32, 'community', 'Сообщество', { deck: 'community' }),
  own(33, street(33, 'Хрустальный проспект', 400, 'green', [35, 200, 600, 1400, 1700, 2000], 200)),
  own(34, station(34, 'Вокзал «Пульс»')),
  cell(35, 'chance', 'Шанс', { deck: 'chance' }),
  cell(36, 'community', 'Сообщество', { deck: 'community' }),
  own(37, street(37, 'Аркадный бульвар', 350, 'navy', [50, 200, 600, 1400, 1700, 2000], 200)),
  cell(38, 'tax', 'Сверхналог', { tax: 100 }),
  own(39, street(39, 'Премиум-проезд', 400, 'navy', [50, 220, 700, 1600, 1900, 2200], 200)),
] as const;

export const GO_BONUS = 200;
export const JAIL_INDEX = 10;
export const JAIL_BAIL = 50;
export const MAX_LEVEL = 5; // 0..4 houses, 5 = hotel
export const MORTGAGE_RATE = 0.5;
export const UNMORTGAGE_RATE = 1.1;
export const MIN_BID = 10;
export const BID_INCREMENT = 10;

export const PURCHASEABLE: readonly number[] = BOARD.flatMap(c => c.property ? [c.index] : []);
export const isPurchasable = (index: number): boolean => BOARD[index]?.property !== undefined;
export const groupOf = (index: number): GroupDef | undefined => GROUP_OF.get(index);
export const groupOfProperty = (property: PropertyDef): GroupDef | undefined =>
  property.group === null ? undefined : GROUPS.find(g => g.id === property.group);

/** Rent owed for a property given building level and, for stations/utilities,
 * how many same-kind properties the owner bank holds. */
export function rentFor(def: PropertyDef, level: number, ownedCount: number, diceTotal: number): number {
  if (def.kind === 'station') return STATION_RENTS[Math.min(ownedCount, 4)] ?? 0;
  if (def.kind === 'utility') return diceTotal * (ownedCount >= 2 ? 10 : 4);
  return def.rents[Math.min(level, MAX_LEVEL)] ?? 0;
}
export const mortgageValue = (price: number): number => Math.floor(price * MORTGAGE_RATE);
export const unmortgageCost = (price: number): number => Math.ceil(price * MORTGAGE_RATE * UNMORTGAGE_RATE);
