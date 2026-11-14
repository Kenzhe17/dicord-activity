import { z } from 'zod';
import type { GameContext, GameResult } from '@rize/platform-core';
import { COLORS, cardColor, cardInfo, cardPoints, holdsColorMatch, isPlayable } from './cards';
import type { UnoColor } from './cards';
import { unoSettingsSchema } from '../server/definition';

export const TURN_MS = 30000;
export const CHALLENGE_MS = 10000;
export const ROUND_END_MS = 30000;

const colorSchema = z.enum(COLORS);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play'), card: z.number().int().min(0).max(107), color: colorSchema.optional(), callUno: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('draw') }).strict(),
  z.object({ type: z.literal('pass') }).strict(),
  z.object({ type: z.literal('chooseColor'), color: colorSchema }).strict(),
  z.object({ type: z.literal('challenge') }).strict(),
  z.object({ type: z.literal('callUno') }).strict(),
  z.object({ type: z.literal('catchUno'), target: z.string() }).strict(),
  z.object({ type: z.literal('nextRound') }).strict(),
  z.object({ type: z.literal('surrender') }).strict(),
]);
export type UnoAction = z.infer<typeof actionSchema>;

const seatIndexSchema = z.number().int().min(0).max(9);
export const stateSchema = z.object({
  players: z.array(z.string()).min(2).max(10),
  mode: z.enum(['quick', 'points']), target: z.number().int().min(100).max(10000),
  hands: z.array(z.array(z.number().int().min(0).max(107))).min(2).max(10),
  deck: z.array(z.number().int().min(0).max(107)),
  discard: z.array(z.number().int().min(0).max(107)).min(1),
  // Fields below carry defaults so checkpoints written before a field was
  // introduced still restore: a missing key must never ZodError every timer
  // tick (same convention as durak/monopoly `forfeited`).
  out: z.array(z.number().int().min(0).max(107)).default([]),
  currentColor: colorSchema, direction: z.union([z.literal(1), z.literal(-1)]),
  actor: z.number().int().min(-1).max(9),
  phase: z.enum(['turn', 'color', 'challenge', 'roundEnd', 'finished']),
  pendingDraw: z.number().int().min(0).max(107).nullable().default(null),
  awaiting: z.object({ card: z.number().int().min(0).max(107), draw4: z.boolean(), hadMatch: z.boolean() }).strict().nullable().default(null),
  challenge: z.object({ bySeat: seatIndexSchema, hadMatch: z.boolean() }).strict().nullable().default(null),
  deadline: z.number().finite().nonnegative(), pausedRemaining: z.number().min(0).max(120000).nullable().default(null),
  scores: z.array(z.number().int().nonnegative()).min(2).max(10),
  round: z.number().int().positive(), roundWinner: z.number().int().min(-1).max(9).default(-1), roundPoints: z.number().int().nonnegative().default(0),
  seed: z.number().int(), shuffles: z.number().int().nonnegative().default(0),
  uno: z.array(z.object({ card: z.number().int().min(0).max(107), ok: z.boolean() }).strict().nullable()).min(2).max(10),
  forfeited: z.array(seatIndexSchema).default([]),
  lastEvent: z.enum(['deal', 'play', 'draw', 'pass', 'color', 'challenge', 'uno', 'catch', 'draw4', 'skip', 'reverse', 'round', 'pause', 'resume', 'surrender', 'recover']).default('deal'),
});
export type UnoState = z.infer<typeof stateSchema>;

const copy = (s: UnoState): UnoState => ({
  ...s, players: [...s.players], hands: s.hands.map(h => [...h]), deck: [...s.deck], discard: [...s.discard], out: [...s.out],
  scores: [...s.scores], uno: s.uno.map(u => u && { ...u }), forfeited: [...s.forfeited],
  awaiting: s.awaiting && { ...s.awaiting }, challenge: s.challenge && { ...s.challenge },
});
const hand = (s: UnoState, seatIndex: number) => s.hands[seatIndex]!;
const topCard = (s: UnoState) => s.discard[s.discard.length - 1]!;
const activeSeats = (s: UnoState) => s.players.map((_, i) => i).filter(i => !s.forfeited.includes(i));
const seatOf = (s: UnoState, playerId: string) => s.players.indexOf(playerId);

/** Advance `steps` seats in the current direction, skipping forfeited seats. */
function nextSeat(s: UnoState, from: number, steps = 1): number {
  const seats = activeSeats(s);
  if (!seats.length) return -1;
  const at = seats.indexOf(from);
  if (at < 0) return seats[0]!;
  return seats[(at + steps * s.direction + seats.length * 10) % seats.length]!;
}

/** Deterministic Fisher–Yates over an arbitrary card list, keyed by
 * (seed, shuffleIndex) so replaying the action log reproduces every
 * reshuffle without storing RNG state. */
function shuffleCards(s: UnoState, cards: number[]): number[] {
  const index = s.shuffles++;
  const out = [...cards];
  let value = ((s.seed ^ Math.imul(index + 1, 0x9E3779B9)) >>> 0) || 1;
  const next = () => { value = (value + 0x6D2B79F5) | 0; let t = Math.imul(value ^ value >>> 15, 1 | value); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

function drawCards(s: UnoState, seatIndex: number, count: number): void {
  const target = hand(s, seatIndex);
  for (let i = 0; i < count; i++) {
    if (!s.deck.length) {
      if (s.discard.length <= 1) break;
      const top = s.discard[s.discard.length - 1]!;
      s.deck = shuffleCards(s, s.discard.slice(0, -1));
      s.discard = [top];
    }
    target.push(s.deck.pop()!);
  }
  // Drawing ends any one-card UNO episode for this seat.
  if (target.length !== 1) s.uno[seatIndex] = null;
}

function pickAutoColor(s: UnoState, seatIndex: number): UnoColor {
  const counts = [0, 0, 0, 0];
  for (const id of hand(s, seatIndex)) { const c = cardColor(id); if (c) counts[COLORS.indexOf(c)]! += 1; }
  if (!counts.some(c => c > 0)) return COLORS[(s.seed + s.round + seatIndex) % 4]!;
  let best = 0;
  for (let i = 1; i < 4; i++) if (counts[i]! > counts[best]!) best = i;
  return COLORS[best]!;
}

function setTurn(s: UnoState, seatIndex: number, now: number): void {
  s.actor = seatIndex;
  s.phase = 'turn';
  s.pendingDraw = null;
  s.awaiting = null;
  s.challenge = null;
  s.deadline = seatIndex < 0 ? 0 : now + TURN_MS;
}

/** Wild Draw Four with no successful challenge: the next player draws 4 and
 * loses the turn, then play continues after them. */
function resolveWild4(s: UnoState, now: number): void {
  const bySeat = s.challenge!.bySeat;
  const next = nextSeat(s, bySeat);
  if (next >= 0) drawCards(s, next, 4);
  setTurn(s, next >= 0 ? nextSeat(s, next) : -1, now);
  s.lastEvent = 'draw4';
  maybeEndRound(s, now);
}

/** Challenged Wild Draw Four. Illegal play (hadMatch): the attacker draws 4
 * instead and loses their turn, so the challenger takes their normal turn.
 * Legal play: the challenger draws 6 (4 + 2 penalty) and loses their turn. */
function resolveChallenge(s: UnoState, now: number): void {
  const ch = s.challenge!;
  const challenger = nextSeat(s, ch.bySeat);
  if (ch.hadMatch) {
    drawCards(s, ch.bySeat, 4);
    setTurn(s, challenger, now);
  } else {
    if (challenger >= 0) drawCards(s, challenger, 6);
    setTurn(s, challenger >= 0 ? nextSeat(s, challenger) : -1, now);
  }
  s.lastEvent = 'challenge';
  maybeEndRound(s, now);
}

/** Apply the chosen color of a Wild / Wild Draw Four and open the challenge
 * window for +4. */
function completeWild(s: UnoState, color: UnoColor, now: number): void {
  const aw = s.awaiting!;
  s.currentColor = color;
  s.awaiting = null;
  if (aw.draw4) {
    s.challenge = { bySeat: s.actor, hadMatch: aw.hadMatch };
    s.phase = 'challenge';
    s.deadline = now + CHALLENGE_MS;
    s.lastEvent = 'draw4';
    return;
  }
  s.lastEvent = 'color';
  setTurn(s, nextSeat(s, s.actor), now);
}

function maybeEndRound(s: UnoState, now: number): void {
  if (s.phase === 'roundEnd' || s.phase === 'finished' || s.phase === 'challenge' || s.phase === 'color') return;
  const seats = activeSeats(s);
  let winner = seats.find(i => hand(s, i).length === 0) ?? -1;
  if (winner < 0 && seats.length === 1) winner = seats[0]!;
  if (winner < 0) {
    if (!seats.length) { s.phase = 'finished'; s.actor = -1; s.deadline = 0; s.lastEvent = 'round'; }
    return;
  }
  s.roundWinner = winner;
  s.roundPoints = seats.filter(i => i !== winner).reduce((sum, i) => sum + hand(s, i).reduce((a, c) => a + cardPoints(c), 0), 0);
  s.scores[winner]! += s.roundPoints;
  if (s.mode === 'quick' || s.scores[winner]! >= s.target) {
    s.phase = 'finished'; s.actor = -1; s.deadline = 0;
  } else {
    s.phase = 'roundEnd'; s.actor = -1; s.deadline = now + ROUND_END_MS;
  }
  s.lastEvent = 'round';
}

function dealRound(s: UnoState, now: number): void {
  const seats = activeSeats(s);
  // Redeal from every card still in play; forfeited cards stay in `out`.
  s.deck = shuffleCards(s, [...s.deck, ...s.discard, ...s.hands.flat()]);
  s.hands = s.players.map(() => [] as number[]);
  // Keep the last card of a short pool (heavy forfeits shrink it, since `out`
  // cards never return) for the opening discard instead of dealing it away.
  deal: for (let i = 0; i < 7; i++) for (const seatIndex of seats) {
    if (s.deck.length <= 1) break deal;
    hand(s, seatIndex).push(s.deck.pop()!);
  }
  // The opening discard may never be a Wild Draw Four while an alternative
  // exists: return it and redraw.
  let top = s.deck.pop()!;
  while (cardInfo(top).rank === 'draw4' && s.deck.some(c => cardInfo(c).rank !== 'draw4')) {
    s.deck.push(top);
    s.deck = shuffleCards(s, s.deck);
    top = s.deck.pop()!;
  }
  s.discard = [top];
  s.currentColor = cardInfo(top).color ?? COLORS[(s.seed ^ s.round) & 3]!;
  s.direction = 1;
  s.actor = seats.length ? seats[(s.seed + s.round) % seats.length]! : -1;
  s.phase = seats.length > 1 ? 'turn' : 'finished';
  s.pendingDraw = null; s.awaiting = null; s.challenge = null;
  s.uno = s.players.map(() => null);
  s.roundWinner = -1; s.roundPoints = 0;
  s.deadline = s.phase === 'turn' ? now + TURN_MS : 0;
  s.pausedRemaining = null;
  s.lastEvent = 'deal';
}

export function createState(raw: unknown, context: GameContext): UnoState {
  const settings = unoSettingsSchema.parse(raw);
  const n = context.players.length;
  if (n < 2 || n > 10 || n > settings.maxPlayers || new Set(context.players).size !== n) throw new Error('Invalid player count');
  const s: UnoState = {
    players: [...context.players], mode: settings.mode, target: settings.target,
    hands: s_players(n), deck: Array.from({ length: 108 }, (_, i) => i), discard: [], out: [],
    currentColor: 'red', direction: 1, actor: -1,
    phase: 'turn', pendingDraw: null, awaiting: null, challenge: null,
    deadline: context.startedAt + TURN_MS, pausedRemaining: null,
    scores: Array.from({ length: n }, () => 0), round: 1, roundWinner: -1, roundPoints: 0,
    seed: context.seed, shuffles: 0, uno: s_players(n).map(() => null), forfeited: [], lastEvent: 'deal',
  };
  dealRound(s, context.startedAt);
  assertInvariants(s);
  return s;
}
function s_players(count: number): number[][] { return Array.from({ length: count }, () => []); }

export function invalidReason(s: UnoState, action: UnoAction, actorId: string, now: number): string | null {
  if (!Number.isFinite(now) || now < 0) return 'Некорректное время';
  if (s.phase === 'finished') return 'Партия завершена';
  const seatIndex = seatOf(s, actorId);
  if (seatIndex < 0) return 'Вы не участвует в матче';
  if (s.forfeited.includes(seatIndex)) return 'Вы сдались и не участвуете в партии';
  if (s.pausedRemaining !== null) return 'Партия приостановлена';

  if (action.type === 'surrender') return null;
  if (action.type === 'nextRound') return s.phase === 'roundEnd' ? null : 'Сейчас нельзя начать новый раунд';
  if (action.type === 'callUno') {
    const entry = s.uno[seatIndex];
    return hand(s, seatIndex).length === 1 && entry && !entry.ok ? null : 'Объявлять UNO сейчас не нужно';
  }
  if (action.type === 'catchUno') {
    const target = seatOf(s, action.target);
    if (target < 0 || target === seatIndex) return 'Нельзя поймать этого игрока';
    if (s.phase !== 'turn' && s.phase !== 'color' && s.phase !== 'challenge') return 'Сейчас нельзя поймать игрока';
    const entry = s.uno[target];
    return hand(s, target).length === 1 && entry && !entry.ok ? null : 'Игрок уже объявил UNO или не остался с одной картой';
  }
  if (action.type === 'challenge') {
    if (s.phase !== 'challenge' || !s.challenge) return 'Оспаривание сейчас недоступно';
    if (now >= s.deadline) return 'Время оспаривания истекло';
    const challenger = nextSeat(s, s.challenge.bySeat);
    // With a single active seat the "next" seat is the attacker itself —
    // nobody may challenge their own Wild Draw Four.
    return challenger !== s.challenge.bySeat && seatIndex === challenger ? null : 'Оспорить может только следующий игрок';
  }
  if (action.type === 'chooseColor') {
    if (s.phase !== 'color' || !s.awaiting) return 'Сейчас не нужно выбирать цвет';
    if (now >= s.deadline) return 'Время выбора цвета истекло';
    return seatIndex === s.actor ? null : 'Цвет выбирает игрок, сыгравший карту';
  }
  if (s.phase !== 'turn') return 'Сейчас чужой этап хода';
  if (seatIndex !== s.actor) return 'Сейчас ход другого игрока';
  if (now >= s.deadline) return 'Время хода истекло';
  const own = hand(s, seatIndex);
  switch (action.type) {
    case 'draw': return s.pendingDraw === null && (s.deck.length > 0 || s.discard.length > 1) ? null : 'Взятие сейчас недоступно';
    case 'pass': return s.pendingDraw !== null || !(s.deck.length > 0 || s.discard.length > 1) ? null : 'Сначала нужно взять карту';
    case 'play': {
      if (!own.includes(action.card)) return 'Карта отсутствует в вашей руке';
      if (s.pendingDraw !== null && action.card !== s.pendingDraw) return 'После взятия можно сыграть только взятую карту';
      if (action.callUno === true && own.length - 1 !== 1) return 'UNO объявляется при второй с конца карте';
      return isPlayable(action.card, topCard(s), s.currentColor) ? null : 'Карта не совпадает с текущим цветом или картой';
    }
  }
}

export function transition(s: UnoState, raw: UnoAction, actorId: string, now: number): UnoState {
  const reason = invalidReason(s, raw, actorId, now);
  if (reason) throw new Error(reason);
  const next = copy(s);
  const seatIndex = seatOf(next, actorId);

  switch (raw.type) {
    case 'surrender': {
      next.forfeited.push(seatIndex);
      next.out.push(...hand(next, seatIndex));
      next.hands[seatIndex] = [];
      next.uno[seatIndex] = null;
      next.lastEvent = 'surrender';
      if (next.phase === 'color' && next.awaiting) {
        if (next.actor === seatIndex) completeWild(next, pickAutoColor(next, seatIndex), now);
      } else if (next.phase === 'challenge' && next.challenge) {
        const ch = next.challenge;
        if (ch.bySeat === seatIndex || nextSeat(next, ch.bySeat) === seatIndex) resolveWild4(next, now);
      } else if (next.phase === 'turn' && next.actor === seatIndex) {
        setTurn(next, nextSeat(next, seatIndex), now);
      }
      maybeEndRound(next, now);
      // Surrendering during the round intermission bypasses maybeEndRound's
      // roundEnd early-return; finish the match if nobody is left to deal.
      if (next.phase === 'roundEnd' && !activeSeats(next).length) {
        next.phase = 'finished'; next.actor = -1; next.deadline = 0; next.lastEvent = 'round';
      }
      break;
    }
    case 'nextRound': {
      next.round += 1;
      dealRound(next, now);
      break;
    }
    case 'callUno': {
      next.uno[seatIndex] = { card: hand(next, seatIndex)[0]!, ok: true };
      next.lastEvent = 'uno';
      break;
    }
    case 'catchUno': {
      const target = seatOf(next, raw.target);
      drawCards(next, target, 2);
      next.uno[target] = null;
      next.lastEvent = 'catch';
      break;
    }
    case 'chooseColor': {
      completeWild(next, raw.color, now);
      maybeEndRound(next, now);
      break;
    }
    case 'challenge': {
      resolveChallenge(next, now);
      break;
    }
    case 'draw': {
      drawCards(next, seatIndex, 1);
      next.pendingDraw = hand(next, seatIndex)[hand(next, seatIndex).length - 1]!;
      next.deadline = now + TURN_MS;
      next.lastEvent = 'draw';
      break;
    }
    case 'pass': {
      next.pendingDraw = null;
      setTurn(next, nextSeat(next, seatIndex), now);
      break;
    }
    case 'play': {
      const card = raw.card;
      const info = cardInfo(card);
      // Remove from hand first: the +4 legality snapshot excludes the card itself.
      next.hands[seatIndex] = hand(next, seatIndex).filter(c => c !== card);
      next.discard.push(card);
      next.pendingDraw = null;
      next.uno[seatIndex] = hand(next, seatIndex).length === 1 ? { card: hand(next, seatIndex)[0]!, ok: raw.callUno === true } : null;
      const rank = info.rank;
      if (rank === 'wild' || rank === 'draw4') {
        const hadMatch = rank === 'draw4' ? holdsColorMatch(hand(next, seatIndex), next.currentColor) : false;
        next.awaiting = { card, draw4: rank === 'draw4', hadMatch };
        if (raw.color !== undefined) completeWild(next, raw.color, now);
        else {
          next.phase = 'color';
          next.deadline = now + TURN_MS;
          next.lastEvent = rank === 'draw4' ? 'draw4' : 'color';
        }
        maybeEndRound(next, now);
        break;
      }
      next.currentColor = info.color!;
      if (rank === 'skip') { next.lastEvent = 'skip'; setTurn(next, nextSeat(next, seatIndex, 2), now); }
      else if (rank === 'reverse') {
        next.lastEvent = 'reverse';
        if (activeSeats(next).length === 2) setTurn(next, nextSeat(next, seatIndex, 2), now);
        else { next.direction = (next.direction * -1) as 1 | -1; setTurn(next, nextSeat(next, seatIndex), now); }
      } else if (rank === 'draw2') {
        next.lastEvent = 'draw4';
        const victim = nextSeat(next, seatIndex);
        if (victim >= 0) drawCards(next, victim, 2);
        setTurn(next, nextSeat(next, seatIndex, 2), now);
      } else { next.lastEvent = 'play'; setTurn(next, nextSeat(next, seatIndex), now); }
      maybeEndRound(next, now);
      break;
    }
  }
  assertInvariants(next);
  return next;
}

/** Enumerates what the viewer may currently do — drives UI highlights. */
export function legalView(s: UnoState, playerId: string) {
  const seatIndex = seatOf(s, playerId);
  const none = { plays: [] as number[], canDraw: false, canPass: false, canChooseColor: false, canChallenge: false, canCallUno: false, catchable: [] as string[], canNextRound: false, canSurrender: false, myTurn: false };
  if (seatIndex < 0 || s.phase === 'finished' || s.forfeited.includes(seatIndex)) return none;
  const own = hand(s, seatIndex);
  const entry = s.uno[seatIndex];
  const inLivePhase = s.phase === 'turn' || s.phase === 'color' || s.phase === 'challenge';
  const challengerSeat = s.phase === 'challenge' && s.challenge ? nextSeat(s, s.challenge.bySeat) : -1;
  const base = {
    canCallUno: own.length === 1 && !!entry && !entry.ok && inLivePhase,
    catchable: inLivePhase ? s.players.filter((_, i) => i !== seatIndex && !s.forfeited.includes(i) && hand(s, i).length === 1 && s.uno[i] && !s.uno[i]!.ok) : [],
    canNextRound: s.phase === 'roundEnd',
    canSurrender: true,
    canChooseColor: s.phase === 'color' && s.actor === seatIndex && !!s.awaiting,
    canChallenge: challengerSeat >= 0 && challengerSeat !== s.challenge?.bySeat && seatIndex === challengerSeat,
    myTurn: s.phase === 'turn' && s.actor === seatIndex,
  };
  if (!base.myTurn) return { ...base, plays: [], canDraw: false, canPass: false };
  const top = topCard(s);
  const plays = s.pendingDraw !== null
    ? (isPlayable(s.pendingDraw, top, s.currentColor) ? [s.pendingDraw] : [])
    : own.filter(c => isPlayable(c, top, s.currentColor));
  const canDraw = s.pendingDraw === null && (s.deck.length > 0 || s.discard.length > 1);
  return { ...base, plays, canDraw, canPass: s.pendingDraw !== null || !canDraw };
}
export type UnoLegal = ReturnType<typeof legalView>;

export function playerView(s: UnoState, playerId: string) {
  const seatIndex = seatOf(s, playerId);
  if (seatIndex < 0) throw new Error('Not a participant');
  const challenger = s.phase === 'challenge' && s.challenge ? nextSeat(s, s.challenge.bySeat) : -1;
  const realChallenger = challenger >= 0 && challenger !== s.challenge?.bySeat ? challenger : -1;
  return {
    hand: [...hand(s, seatIndex)],
    seat: seatIndex,
    players: s.players.map((id, i) => ({ id, seat: i, count: hand(s, i).length, out: !activeSeats(s).includes(i), unoCalled: !!s.uno[i]?.ok, owesUno: hand(s, i).length === 1 && !!s.uno[i] && !s.uno[i]!.ok })),
    deckCount: s.deck.length, discardCount: s.discard.length, topCard: topCard(s), currentColor: s.currentColor,
    direction: s.direction, actorId: s.actor >= 0 ? s.players[s.actor]! : null,
    phase: s.phase, deadline: s.deadline, paused: s.pausedRemaining !== null,
    pendingDraw: seatIndex === s.actor ? s.pendingDraw : null,
    awaitingColor: s.phase === 'color' && s.awaiting ? { actorId: s.players[s.actor]! } : null,
    challenge: s.phase === 'challenge' && s.challenge ? { actorId: s.players[s.challenge.bySeat]!, iAmChallenger: realChallenger === seatIndex } : null,
    scores: [...s.scores], round: s.round, roundWinner: s.roundWinner >= 0 ? s.players[s.roundWinner]! : null,
    roundPoints: s.roundPoints, mode: s.mode, target: s.target,
    lastEvent: s.lastEvent, legal: legalView(s, playerId), result: result(s),
  };
}
export type UnoView = ReturnType<typeof playerView>;

export function result(s: UnoState): GameResult | null {
  if (s.phase !== 'finished') return null;
  // Forfeited seats can never win; with nobody eligible the match is a draw.
  const eligible = s.players.map((_, i) => i).filter(i => !s.forfeited.includes(i));
  if (!eligible.length) return { winners: [], losers: [...s.players], draw: true };
  const best = Math.max(...eligible.map(i => s.scores[i]!));
  const winners = eligible.filter(i => s.scores[i] === best).map(i => s.players[i]!);
  const losers = s.players.filter(id => !winners.includes(id));
  return { winners, losers, draw: winners.length !== 1 };
}

export function assertInvariants(s: UnoState): void {
  const all = [...s.deck, ...s.discard, ...s.out, ...s.hands.flat()];
  if (all.length !== 108 || new Set(all).size !== 108 || all.some(c => !Number.isInteger(c) || c < 0 || c > 107)) throw new Error('Card conservation violated');
  if (s.players.length < 2 || s.players.length > 10 || new Set(s.players).size !== s.players.length || s.hands.length !== s.players.length) throw new Error('Invalid seats');
  if (s.scores.length !== s.players.length || s.scores.some(v => !Number.isInteger(v) || v < 0)) throw new Error('Invalid scores');
  if (new Set(s.forfeited).size !== s.forfeited.length || s.forfeited.some(i => i < 0 || i >= s.players.length)) throw new Error('Invalid forfeited seats');
  if (s.forfeited.some(i => hand(s, i).length > 0)) throw new Error('Forfeited player still holds cards');
  if (s.direction !== 1 && s.direction !== -1) throw new Error('Invalid direction');
  if (s.uno.length !== s.players.length) throw new Error('Invalid uno tracking');
  s.hands.forEach((h, i) => {
    const entry = s.uno[i];
    if (h.length === 1 ? !(entry && entry.card === h[0]) : entry !== null) throw new Error('Invalid uno state');
  });
  if (s.phase === 'turn') {
    if (s.actor < 0 || s.actor >= s.players.length || s.forfeited.includes(s.actor)) throw new Error('Invalid actor');
    if (s.pendingDraw !== null && !hand(s, s.actor).includes(s.pendingDraw)) throw new Error('Invalid pending draw');
  } else if (s.phase === 'color') {
    if (!s.awaiting || s.actor < 0 || s.forfeited.includes(s.actor)) throw new Error('Invalid color phase');
  } else if (s.phase === 'challenge') {
    if (!s.challenge) throw new Error('Invalid challenge phase');
  } else if (s.phase === 'roundEnd') {
    if (s.roundWinner < -1 || s.roundWinner >= s.players.length) throw new Error('Invalid round winner');
  }
}

const systemSchema = z.object({ type: z.enum(['timeout', 'pause', 'resume', 'recover']) }).strict();
export function systemAction(s: UnoState, now: number, online: boolean) {
  if (s.phase === 'finished') return null;
  if (!online && s.pausedRemaining === null) return { type: 'pause' };
  if (online && s.pausedRemaining !== null) return { type: 'resume' };
  return online && now >= s.deadline ? { type: 'timeout' } : null;
}
export function applySystem(s: UnoState, raw: unknown, now: number): UnoState {
  const action = systemSchema.parse(raw);
  if (s.phase === 'finished') throw new Error('Finished game');
  if (action.type === 'recover') {
    const span = s.phase === 'challenge' ? CHALLENGE_MS : s.phase === 'roundEnd' ? ROUND_END_MS : TURN_MS;
    return { ...copy(s), deadline: Math.max(s.deadline, now + span), lastEvent: 'recover' };
  }
  if (action.type === 'pause') {
    if (s.pausedRemaining !== null) throw new Error('Already paused');
    return { ...copy(s), pausedRemaining: Math.max(0, s.deadline - now), lastEvent: 'pause' };
  }
  if (action.type === 'resume') {
    if (s.pausedRemaining === null) throw new Error('Not paused');
    return { ...copy(s), deadline: now + s.pausedRemaining, pausedRemaining: null, lastEvent: 'resume' };
  }
  if (s.pausedRemaining !== null || now < s.deadline) throw new Error('Timer not due');
  // Timeout: work on a copy whose deadline is already due so inner legality passes.
  const work = { ...copy(s), deadline: now + 1 };
  if (s.phase === 'turn') {
    const actorId = s.players[s.actor]!;
    if (work.pendingDraw !== null) return transition(work, { type: 'pass' }, actorId, now);
    if (work.deck.length > 0 || work.discard.length > 1) {
      const drawn = transition(work, { type: 'draw' }, actorId, now);
      return transition(drawn, { type: 'pass' }, actorId, now);
    }
    return transition(work, { type: 'pass' }, actorId, now);
  }
  if (s.phase === 'color' && s.awaiting) {
    return transition(work, { type: 'chooseColor', color: pickAutoColor(work, s.actor) }, s.players[s.actor]!, now);
  }
  if (s.phase === 'challenge' && s.challenge) {
    const next = copy(work);
    resolveWild4(next, now);
    assertInvariants(next);
    return next;
  }
  if (s.phase === 'roundEnd') {
    const actorId = s.players.find((_, i) => !s.forfeited.includes(i));
    if (!actorId) throw new Error('Nobody can start the next round');
    return transition(work, { type: 'nextRound' }, actorId, now);
  }
  throw new Error('Nothing to resolve');
}
