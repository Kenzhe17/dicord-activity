import { z } from 'zod';
import type { GameContext, GameResult } from '@rize/platform-core';
import { durakSettingsSchema } from '../server/definition';
import { beats, rank, suit, shuffled } from './cards';

const card = z.number().int().min(0).max(35);
const cards = z.array(card).min(1).max(6);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attack'), cards }).strict(),
  z.object({ type: z.literal('throw'), cards }).strict(),
  z.object({ type: z.literal('transfer'), cards }).strict(),
  z.object({ type: z.literal('defend'), card, target: card }).strict(),
  z.object({ type: z.literal('take') }).strict(), z.object({ type: z.literal('pass') }).strict(),
]);
export type DurakAction = z.infer<typeof actionSchema>;
export const stateSchema = z.object({
  players: z.array(z.string()).min(2).max(6), mode: z.enum(['throw-in', 'transfer']),
  hands: z.array(z.array(card)), deck: z.array(card), discard: z.array(card),
  table: z.array(z.object({ attack: card, defense: card.nullable() })),
  trump: z.number().int().min(0).max(3), trumpCard: card, dealer: z.number().int(),
  active: z.array(z.number().int()), original: z.number().int(), lead: z.number().int(), defender: z.number().int(), actor: z.number().int(),
  queue: z.array(z.number().int()), limit: z.number().int().min(0).max(6), bout: z.number().int().positive(),
  phase: z.enum(['opening', 'defending', 'throwing', 'taking', 'finished']),
  deadline: z.number().finite().nonnegative(), pausedRemaining: z.number().min(0).max(30000).nullable(),
  lastEvent: z.enum(['deal', 'attack', 'defend', 'transfer', 'throw', 'take', 'pass', 'discard', 'pickup', 'pause', 'resume']),
});
export type DurakState = z.infer<typeof stateSchema>;
const hand = (s: DurakState, seat: number) => s.hands[seat]!;
const nextSeat = (s: DurakState, from: number) => {
  for (let step = 1; step <= s.players.length; step++) { const seat = (from + step) % s.players.length; if (s.active.includes(seat)) return seat; }
  throw new Error('No active player');
};
const circle = (s: DurakState, start: number) => Array.from({ length: s.players.length }, (_, i) => (start + i) % s.players.length).filter(i => s.active.includes(i));
const copy = (s: DurakState): DurakState => ({ ...s, players: [...s.players], hands: s.hands.map(h => [...h]), deck: [...s.deck], discard: [...s.discard], table: s.table.map(p => ({ ...p })), active: [...s.active], queue: [...s.queue] });

export function assertInvariants(s: DurakState): void {
  const all = [...s.deck, ...s.discard, ...s.hands.flat(), ...s.table.flatMap(p => p.defense === null ? [p.attack] : [p.attack, p.defense])];
  if (all.length !== 36 || new Set(all).size !== 36 || all.some(c => !Number.isInteger(c) || c < 0 || c > 35)) throw new Error('Card conservation violated');
  if (s.hands.length !== s.players.length || new Set(s.players).size !== s.players.length || new Set(s.active).size !== s.active.length) throw new Error('Invalid seats');
  if (s.table.length > s.limit || s.table.some(p => p.defense !== null && !beats(p.attack, p.defense, s.trump))) throw new Error('Invalid table');
  if (s.active.some(i => i < 0 || i >= s.players.length) || s.hands.some((h, i) => !s.active.includes(i) && h.length > 0)) throw new Error('Invalid active players');
  if (s.phase !== 'finished') {
    if (s.active.length < 2 || !s.active.includes(s.actor) || !s.active.includes(s.defender)) throw new Error('Invalid turn');
    if (!s.active.includes(s.original) || !s.active.includes(s.lead)) throw new Error('Invalid attacking seats');
    if (s.phase === 'opening' && s.actor !== s.original) throw new Error('Invalid opening actor');
    if ((s.phase === 'throwing' || s.phase === 'taking') && (s.queue[0] !== s.actor || new Set(s.queue).size !== s.queue.length || s.queue.some(i => !s.active.includes(i) || i === s.defender || !hand(s, i).length))) throw new Error('Invalid throwing queue');
    if ((s.phase === 'defending') !== (s.actor === s.defender)) throw new Error('Invalid defender turn');
    if (s.phase === 'opening' && s.table.length || s.phase === 'defending' && !s.table.some(p => p.defense === null) || s.phase === 'throwing' && s.table.some(p => p.defense === null)) throw new Error('Invalid phase');
  } else if (s.active.length > 1 || s.table.length || s.deck.length) throw new Error('Invalid final state');
}

export function createState(raw: unknown, context: GameContext): DurakState {
  const settings = durakSettingsSchema.parse(raw), n = context.players.length;
  if (n < 2 || n > settings.maxPlayers || new Set(context.players).size !== n) throw new Error('Invalid player count');
  const generated = shuffled(context.seed), deck = generated.deck, dealer = generated.dealer % n;
  const hands: number[][] = Array.from({ length: n }, () => []);
  let last = 0;
  for (let round = 0; round < 6; round++) for (let step = 1; step <= n; step++) { last = deck.shift()!; hands[(dealer + step) % n]!.push(last); }
  const trumpCard = deck.length ? deck.shift()! : last;
  if (n < 6) deck.push(trumpCard);
  const trump = suit(trumpCard);
  let first = (dealer + 1) % n, lowest = 9;
  hands.forEach((h, i) => h.forEach(c => { if (suit(c) === trump && rank(c) < lowest) { first = i; lowest = rank(c); } }));
  const defender = (first + 1) % n;
  const state: DurakState = { players: [...context.players], mode: settings.mode, hands, deck, discard: [], table: [], trump, trumpCard, dealer, active: hands.map((_, i) => i), original: first, lead: first, defender, actor: first, queue: [], limit: 6, bout: 1, phase: 'opening', deadline: context.startedAt + 30000, pausedRemaining: null, lastEvent: 'deal' };
  assertInvariants(state); return state;
}

export function invalidReason(s: DurakState, action: DurakAction, actorId: string, now: number): string | null {
  if (!Number.isFinite(now) || now < 0) return 'Некорректное время';
  if (s.phase === 'finished') return 'Партия завершена';
  if (s.players[s.actor] !== actorId) return 'Сейчас ход другого игрока';
  if (s.pausedRemaining !== null) return 'Партия приостановлена';
  if (now >= s.deadline) return 'Время хода истекло';
  const own = hand(s, s.actor);
  const selected = 'cards' in action ? action.cards : action.type === 'defend' ? [action.card] : [];
  if ('cards' in action && (!selected.length || selected.length > 6)) return 'Выберите от 1 до 6 карт';
  if (new Set(selected).size !== selected.length || selected.some(c => !own.includes(c))) return 'Карта отсутствует в вашей руке';
  const same = (cs: number[]) => cs.every(c => rank(c) === rank(cs[0]!));
  switch (action.type) {
    case 'attack': return s.phase === 'opening' && same(action.cards) && action.cards.length <= s.limit ? null : 'Недопустимая атака';
    case 'defend': {
      const pair = s.table.find(p => p.attack === action.target && p.defense === null);
      return s.phase === 'defending' && pair && beats(pair.attack, action.card, s.trump) ? null : 'Эта карта не покрывает выбранную атаку';
    }
    case 'transfer': {
      const target = nextSeat(s, s.defender);
      return s.mode === 'transfer' && s.phase === 'defending' && s.table.every(p => p.defense === null && rank(p.attack) === rank(action.cards[0]!)) && same(action.cards) && !(s.active.length === 2 && target === s.original) && s.table.length + action.cards.length <= Math.min(6, hand(s, target).length) ? null : 'Перевод запрещён или превышен лимит нового защитника';
    }
    case 'throw': {
      const seen = new Set(s.table.flatMap(p => p.defense === null ? [rank(p.attack)] : [rank(p.attack), rank(p.defense)]));
      return (s.phase === 'throwing' || s.phase === 'taking') && s.table.length + action.cards.length <= s.limit && action.cards.every(c => seen.has(rank(c))) ? null : 'Нельзя подкинуть эти карты';
    }
    case 'take': return s.phase === 'defending' ? null : 'Нет непокрытой атаки';
    case 'pass': return s.phase === 'throwing' || s.phase === 'taking' ? null : 'Сейчас нельзя пасовать';
  }
}

function settle(s: DurakState, taking: boolean) {
  const tableCards = s.table.flatMap(p => p.defense === null ? [p.attack] : [p.attack, p.defense]);
  (taking ? hand(s, s.defender) : s.discard).push(...tableCards);
  s.table = []; s.queue = []; s.lastEvent = taking ? 'pickup' : 'discard';
  const refill = [...circle(s, s.original).filter(i => i !== s.defender), s.defender];
  for (const seat of refill) while (hand(s, seat).length < 6 && s.deck.length) hand(s, seat).push(s.deck.shift()!);
  if (!s.deck.length) s.active = s.active.filter(i => hand(s, i).length > 0);
  if (s.active.length <= 1) { s.phase = 'finished'; s.actor = -1; s.deadline = 0; return; }
  const first = !taking && s.active.includes(s.defender) ? s.defender : nextSeat(s, s.defender);
  s.original = first; s.lead = first; s.actor = first; s.defender = nextSeat(s, first);
  s.limit = Math.min(6, hand(s, s.defender).length); s.phase = 'opening'; s.bout++;
}
function offer(s: DurakState, taking: boolean) {
  if (s.table.length >= s.limit) { settle(s, taking); return; }
  s.queue = circle(s, s.lead).filter(i => i !== s.defender && hand(s, i).length > 0);
  if (!s.queue.length) { settle(s, taking); return; }
  s.phase = taking ? 'taking' : 'throwing'; s.actor = s.queue[0]!;
}
export function transition(s: DurakState, raw: DurakAction, actorId: string, now: number): DurakState {
  const reason = invalidReason(s, raw, actorId, now);
  if (reason) throw new Error(reason);
  const next = copy(s), action = raw;
  next.lastEvent = action.type;
  if ('cards' in action) {
    next.hands[next.actor] = hand(next, next.actor).filter(c => !action.cards.includes(c));
    next.table.push(...action.cards.map(attack => ({ attack, defense: null })));
  }
  switch (action.type) {
    case 'attack': next.phase = 'defending'; next.actor = next.defender; break;
    case 'transfer': next.lead = next.defender; next.defender = nextSeat(next, next.defender); next.actor = next.defender; next.limit = Math.min(6, hand(next, next.defender).length); break;
    case 'defend':
      next.hands[next.actor] = hand(next, next.actor).filter(c => c !== action.card);
      next.table.find(p => p.attack === action.target)!.defense = action.card;
      if (next.table.every(p => p.defense !== null)) offer(next, false);
      break;
    case 'throw': if (s.phase === 'taking') offer(next, true); else { next.phase = 'defending'; next.actor = next.defender; } break;
    case 'take': offer(next, true); break;
    case 'pass': next.queue.shift(); if (next.queue.length) next.actor = next.queue[0]!; else settle(next, s.phase === 'taking'); break;
  }
  next.deadline = next.phase === 'finished' ? 0 : now + 30000;
  assertInvariants(next); return next;
}

/** Enumerates allowed single-card moves and same-rank multi-card attacks/transfers. */
export function legalActions(s: DurakState, playerId: string): DurakAction[] {
  if (s.phase === 'finished' || s.pausedRemaining !== null || s.players[s.actor] !== playerId) return [];
  const own = hand(s, s.actor), candidates: DurakAction[] = [];
  if (s.phase === 'opening' || s.phase === 'defending' && s.mode === 'transfer') {
    for (let r = 0; r < 9; r++) {
      const group = own.filter(c => rank(c) === r);
      for (let mask = 1; mask < 1 << group.length; mask++) candidates.push({ type: s.phase === 'opening' ? 'attack' : 'transfer', cards: group.filter((_, i) => mask & 1 << i) });
    }
  }
  if (s.phase === 'defending') {
    for (const pair of s.table) if (pair.defense === null) for (const c of own) candidates.push({ type: 'defend', card: c, target: pair.attack });
    candidates.push({ type: 'take' });
  }
  if (s.phase === 'throwing' || s.phase === 'taking') { for (const c of own) candidates.push({ type: 'throw', cards: [c] }); candidates.push({ type: 'pass' }); }
  return candidates.filter(a => invalidReason(s, a, playerId, s.deadline - 1) === null);
}
export function result(s: DurakState): GameResult | null {
  if (s.phase !== 'finished') return null;
  return s.active.length ? { winners: s.players.filter((_, i) => !s.active.includes(i)), losers: [s.players[s.active[0]!]!], draw: false } : { winners: [], losers: [], draw: true };
}
export function playerView(s: DurakState, playerId: string) {
  const seat = s.players.indexOf(playerId);
  if (seat < 0) throw new Error('Not a participant');
  return { hand: [...hand(s, seat)], players: s.players.map((id, i) => ({ id, count: hand(s, i).length, out: !s.active.includes(i) })), table: s.table.map(p => ({ ...p })), trump: s.trump, trumpCard: s.trumpCard, deckCount: s.deck.length, discardCount: s.discard.length, actorId: s.players[s.actor] ?? null, defenderId: s.players[s.defender]!, phase: s.phase, mode: s.mode, limit: s.limit, bout: s.bout, deadline: s.deadline, paused: s.pausedRemaining !== null, lastEvent: s.lastEvent, legalActions: legalActions(s, playerId), result: result(s) };
}
export type DurakView = ReturnType<typeof playerView>;

const systemSchema = z.object({ type: z.enum(['timeout', 'pause', 'resume', 'recover']) }).strict();
export function systemAction(s: DurakState, now: number, online: boolean) {
  if (s.phase === 'finished') return null;
  if (!online && s.pausedRemaining === null) return { type: 'pause' };
  if (online && s.pausedRemaining !== null) return { type: 'resume' };
  return online && now >= s.deadline ? { type: 'timeout' } : null;
}
export function applySystem(s: DurakState, raw: unknown, now: number): DurakState {
  const action = systemSchema.parse(raw);
  if (s.phase === 'finished') throw new Error('Finished game');
  if (action.type === 'recover') return { ...copy(s), deadline: Math.max(s.deadline, now + 30000), lastEvent: 'resume' };
  if (action.type === 'pause') {
    if (s.pausedRemaining !== null) throw new Error('Already paused');
    return { ...copy(s), pausedRemaining: Math.max(0, s.deadline - now), lastEvent: 'pause' };
  }
  if (action.type === 'resume') {
    if (s.pausedRemaining === null) throw new Error('Not paused');
    return { ...copy(s), deadline: now + s.pausedRemaining, pausedRemaining: null, lastEvent: 'resume' };
  }
  if (s.pausedRemaining !== null || now < s.deadline) throw new Error('Timer not due');
  let move: DurakAction;
  if (s.phase === 'opening') {
    const sorted = [...hand(s, s.actor)].sort((a, b) => Number(suit(a) === s.trump) - Number(suit(b) === s.trump) || rank(a) - rank(b) || suit(a) - suit(b));
    move = { type: 'attack', cards: [sorted[0]!] };
  } else move = { type: s.phase === 'defending' ? 'take' : 'pass' };
  return transition({ ...s, deadline: now + 1 }, move, s.players[s.actor]!, now);
}
