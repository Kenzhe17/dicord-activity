import type { DeckKind } from './board';

/** Original card effects. Every effect is resolved server-side by the engine;
 * cards never touch the client RNG. */
export type CardEffect =
  | { readonly type: 'gain'; readonly amount: number }
  | { readonly type: 'lose'; readonly amount: number }
  | { readonly type: 'collectEach'; readonly amount: number }
  | { readonly type: 'moveTo'; readonly target: number | 'go' | 'nearestStation' | 'nearestUtility' | 'jail' }
  | { readonly type: 'moveBack'; readonly steps: number }
  | { readonly type: 'repairs'; readonly perLevel: number }
  | { readonly type: 'gainPerProperty'; readonly amount: number }
  | { readonly type: 'getOutCard' };

export interface CardDef {
  readonly id: string;
  readonly deck: DeckKind;
  readonly text: string;
  readonly effect: CardEffect;
}

const chance = (id: string, text: string, effect: CardEffect): CardDef => ({ id: 'chance:' + id, deck: 'chance', text, effect });
const community = (id: string, text: string, effect: CardEffect): CardDef => ({ id: 'community:' + id, deck: 'community', text, effect });

export const CHANCE_CARDS: readonly CardDef[] = [
  chance('advance', 'Дорожный бонус! Перейдите на Старт и получите 200.', { type: 'moveTo', target: 'go' }),
  chance('bank-error', 'Банк ошибся в вашу пользу. Получите 200.', { type: 'gain', amount: 200 }),
  chance('doctor', 'Вы пригласили врача на вечеринку. Получите по 50 от каждого игрока (сколько есть у каждого).', { type: 'collectEach', amount: 50 }),
  chance('school', 'Штраф за непристёгнутый ремень в клубе. Заплатите 15 каждому игроку — нет, банку: 60.', { type: 'lose', amount: 60 }),
  chance('inherit', 'Дальний родственник оставил вам наследство. Получите 100.', { type: 'gain', amount: 100 }),
  chance('consultant', 'Консультация по недвижимости обошлась в 25 за каждый ваш уровень построек.', { type: 'repairs', perLevel: 25 }),
  chance('station', 'Идите прямо на ближайший вокзал. Если не хотите покупать — платите аренду.', { type: 'moveTo', target: 'nearestStation' }),
  chance('utility', 'Электрики требуют проверки. Идите на ближайшую коммунальную клетку.', { type: 'moveTo', target: 'nearestUtility' }),
  chance('back3', 'Вы зашли не в ту дверь. Отступите на 3 клетки назад.', { type: 'moveBack', steps: 3 }),
  chance('jailfree', 'Служебный пропуск клуба. Сохраните его — он выведет вас из тюрьмы.', { type: 'getOutCard' }),
  chance('crowdfund', 'Краудфандинг удался! Соберите по 40 с каждого игрока (сколько есть у каждого).', { type: 'collectEach', amount: 40 }),
  chance('fine', 'Штраф за шум после полуночи. Заплатите банку 50.', { type: 'lose', amount: 50 }),
  chance('lottery', 'Вы выиграли в клубную лотерею! Банк выплатит 150.', { type: 'gain', amount: 150 }),
  chance('repairs-hotel', 'Срочный ремонт всех построек: 40 за каждый уровень.', { type: 'repairs', perLevel: 40 }),
  chance('tournament', 'Плата за участие в турнире по картам. Заплатите 100.', { type: 'lose', amount: 100 }),
  chance('sponsor', 'Местный спонсор оценил вашу игровую империю. Получите 25 за каждую вашу собственность.', { type: 'gainPerProperty', amount: 25 }),
];

export const COMMUNITY_CARDS: readonly CardDef[] = [
  community('fee', 'Взнос за участие в турнире клуба. Заплатите банку 50.', { type: 'lose', amount: 50 }),
  community('tax-refund', 'Налоговая вернула переплату. Получите 100.', { type: 'gain', amount: 100 }),
  community('birthday', 'Сегодня ваш день рождения! Каждый игрок дарит вам по 10 (сколько есть у каждого).', { type: 'collectEach', amount: 10 }),
  community('medical', 'Счёт за медицинскую помощь после неудачного трюка. Заплатите 100.', { type: 'lose', amount: 100 }),
  community('sale', 'Вы продали старый инвентарь. Получите 60.', { type: 'gain', amount: 60 }),
  community('renovation', 'Ремонт клуба обошёлся в 25 за каждый уровень ваших построек.', { type: 'repairs', perLevel: 25 }),
  community('jailfree', 'Выходной пропуск от завсегдатаев. Сохраните его.', { type: 'getOutCard' }),
  community('utility', 'Сантехники вызваны по ошибке. Идите на ближайшую коммунальную клетку.', { type: 'moveTo', target: 'nearestUtility' }),
  community('station', 'Экспресс до ближайшего вокзала. Мчим!', { type: 'moveTo', target: 'nearestStation' }),
  community('advance-go', 'Бонус за лояльность: переходите на Старт.', { type: 'moveTo', target: 'go' }),
  community('inspect', 'Инспекция проверила вашу недвижимость. 20 за каждый уровень построек.', { type: 'repairs', perLevel: 20 }),
  community('dividend', 'Дивиденды по акциям клуба. Получите 50.', { type: 'gain', amount: 50 }),
  community('parking', 'Вы нашли конверт под «Финальной стоянкой» — но там просто парковка. Отступите на 3 клетки.', { type: 'moveBack', steps: 3 }),
  community('loan', 'Кредитный союз одобрил заём. Получите 150.', { type: 'gain', amount: 150 }),
  community('charity', 'Благотворительный взнос клуба. Соберите по 30 с каждого игрока (сколько есть у каждого).', { type: 'collectEach', amount: 30 }),
  community('grand-tournament', 'Срочный ремонт арены: 50 за каждый уровень построек.', { type: 'repairs', perLevel: 50 }),
];

export const CARD_BY_ID = new Map<string, CardDef>([...CHANCE_CARDS, ...COMMUNITY_CARDS].map(c => [c.id, c]));
