import { z } from 'zod';
import type { GameContext, GameResult } from '@rize/platform-core';
import { monopolySettingsSchema } from '../server/definition';
import { BOARD, GROUPS, GO_BONUS, JAIL_INDEX, JAIL_BAIL, MAX_LEVEL, BID_INCREMENT, MIN_BID, groupOfProperty, isPurchasable, mortgageValue, rentFor, unmortgageCost } from './board';
import type { DeckKind } from './board';
import { CARD_BY_ID, CHANCE_CARDS, COMMUNITY_CARDS } from './cards';

/* ---------------------------------- RNG ---------------------------------- */

/** mulberry32 — deterministic, state is a single uint32 kept inside the state. */
function rngStep(rng: number): [number, number] {
  rng = (rng + 0x6D2B79F5) | 0;
  let t = rng;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, rng];
}
function rngInt(rng: number, n: number): [number, number] {
  const [v, next] = rngStep(rng);
  return [Math.floor(v * n), next];
}
function shuffled<T>(items: readonly T[], rng: number): [T[], number] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const [j, next] = rngInt(rng, i + 1);
    rng = next;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return [out, rng];
}

/* --------------------------------- State --------------------------------- */

const seatStateSchema = z.object({
  position: z.number().int().min(0).max(39),
  inJail: z.boolean(),
  jailTurns: z.number().int().min(0).max(10),
  out: z.boolean(),
  getOutCards: z.number().int().min(0).max(10),
  lastDice: z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)]).nullable(),
});
export type SeatState = z.infer<typeof seatStateSchema>;

const propertyStateSchema = z.object({
  owner: z.number().int().min(0).max(5).nullable(), // bank id; null = bank-owned pool
  level: z.number().int().min(0).max(MAX_LEVEL),
  mortgaged: z.boolean(),
});
export type PropertyState = z.infer<typeof propertyStateSchema>;

const tradeSchema = z.object({
  id: z.string(), from: z.number().int().min(0).max(5), to: z.number().int().min(0).max(5),
  giveMoney: z.number().int().min(0).max(1000000), giveProps: z.array(z.number().int().min(0).max(39)).max(22),
  getMoney: z.number().int().min(0).max(1000000), getProps: z.array(z.number().int().min(0).max(39)).max(22),
  createdAt: z.number().finite().nonnegative(), expiresAt: z.number().finite().nonnegative(),
});
export type TradeOffer = z.infer<typeof tradeSchema>;

const pendingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('purchase'), index: z.number().int().min(0).max(39) }).strict(),
  z.object({
    type: z.literal('debt'), amount: z.number().int().positive().max(1000000),
    creditor: z.number().int().min(0).max(5).nullable(), // null = owed to the bank
    returnPhase: z.enum(['awaitEnd', 'awaitRoll']), forSeat: z.number().int().min(0).max(5),
  }).strict(),
]);

const auctionSchema = z.object({
  index: z.number().int().min(0).max(39), currentBid: z.number().int().min(0),
  leader: z.number().int().min(0).max(5).nullable(), passed: z.array(z.number().int().min(0).max(5)),
  deadline: z.number().finite().nonnegative(),
});

export const stateSchema = z.object({
  players: z.array(z.string()).min(2).max(6),
  mode: z.enum(['classic', 'quick', 'teams']),
  startMoney: z.number().int().positive(), turnSeconds: z.number().int().positive(),
  auctionSeconds: z.number().int().positive(), tradeSeconds: z.number().int().positive(), evenBuild: z.boolean(),
  banks: z.array(z.number().int().min(0).max(10000000)).min(2).max(6),
  bankMembers: z.array(z.array(z.number().int().min(0).max(5))).min(2).max(6),
  seatBank: z.array(z.number().int().min(0).max(5)),
  seats: z.array(seatStateSchema).min(2).max(6),
  properties: z.array(propertyStateSchema).length(40),
  decks: z.object({
    chance: z.array(z.string()), community: z.array(z.string()),
    chanceOut: z.array(z.string()), communityOut: z.array(z.string()),
  }),
  rng: z.number().int(),
  phase: z.enum(['awaitRoll', 'awaitEnd', 'buy', 'auction', 'debt', 'finished']),
  turn: z.number().int().min(0).max(5),
  doubles: z.number().int().min(0).max(3),
  extraRollPending: z.boolean(),
  pending: pendingSchema.nullable(),
  auction: auctionSchema.nullable(),
  trades: z.array(tradeSchema).max(100),
  tradeSeq: z.number().int().nonnegative(),
  dice: z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)]).nullable(),
  deadline: z.number().finite().nonnegative(),
  pausedRemaining: z.number().min(0).max(600000).nullable(),
  log: z.array(z.object({ seat: z.number().int().min(0).max(5).optional(), text: z.string().max(300), cardId: z.string().optional() })).max(80),
  lastEvent: z.string().max(40),
  /** Seats that left the game (bankruptcy/surrender). Mirrors seats[].out —
   * the platform reads this field to allow mid-match room exit. */
  forfeited: z.array(z.number().int().min(0).max(5)).default([]),
});
export type MonopolyState = z.infer<typeof stateSchema>;

/* -------------------------------- Actions -------------------------------- */

const propIndex = z.number().int().min(0).max(39);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('roll') }).strict(),
  z.object({ type: z.literal('buy') }).strict(),
  z.object({ type: z.literal('refuse') }).strict(),
  z.object({ type: z.literal('bid'), amount: z.number().int().min(0).max(1000000) }).strict(),
  z.object({ type: z.literal('pass') }).strict(),
  z.object({ type: z.literal('build'), property: propIndex }).strict(),
  z.object({ type: z.literal('sell'), property: propIndex }).strict(),
  z.object({ type: z.literal('mortgage'), property: propIndex }).strict(),
  z.object({ type: z.literal('unmortgage'), property: propIndex }).strict(),
  z.object({ type: z.literal('offer'), to: z.string(), giveMoney: z.number().int().min(0).max(1000000), giveProps: z.array(propIndex).max(22), getMoney: z.number().int().min(0).max(1000000), getProps: z.array(propIndex).max(22) }).strict(),
  z.object({ type: z.literal('accept'), offerId: z.string().max(20) }).strict(),
  z.object({ type: z.literal('decline'), offerId: z.string().max(20) }).strict(),
  z.object({ type: z.literal('cancel'), offerId: z.string().max(20) }).strict(),
  z.object({ type: z.literal('payJail') }).strict(),
  z.object({ type: z.literal('jailCard') }).strict(),
  z.object({ type: z.literal('endTurn') }).strict(),
  z.object({ type: z.literal('surrender') }).strict(),
]);
export type MonopolyAction = z.infer<typeof actionSchema>;

/* ------------------------------- Utilities ------------------------------- */

const copy = (s: MonopolyState): MonopolyState => ({
  ...s, players: [...s.players], banks: [...s.banks], bankMembers: s.bankMembers.map(m => [...m]), seatBank: [...s.seatBank],
  seats: s.seats.map(p => ({ ...p, lastDice: p.lastDice ? [...p.lastDice] as [number, number] : null })),
  properties: s.properties.map(p => ({ ...p })),
  decks: { chance: [...s.decks.chance], community: [...s.decks.community], chanceOut: [...s.decks.chanceOut], communityOut: [...s.decks.communityOut] },
  pending: s.pending ? { ...s.pending } : null,
  auction: s.auction ? { ...s.auction, passed: [...s.auction.passed] } : null,
  trades: s.trades.map(t => ({ ...t, giveProps: [...t.giveProps], getProps: [...t.getProps] })),
  dice: s.dice ? [...s.dice] as [number, number] : null,
  log: [...s.log],
  forfeited: [...s.forfeited],
});
const seatOf = (s: MonopolyState, playerId: string) => s.players.indexOf(playerId);
const bankOf = (s: MonopolyState, seat: number) => s.seatBank[seat]!;
const bankActive = (s: MonopolyState, bank: number) => s.bankMembers[bank]!.some(seat => !s.seats[seat]!.out);
const activeBanks = (s: MonopolyState) => s.banks.map((_, i) => i).filter(i => bankActive(s, i));
const seatActive = (s: MonopolyState, seat: number) => seat >= 0 && !s.seats[seat]!.out;
const playerName = (_s: MonopolyState, seat: number) => '#' + (seat + 1);
function pushLog(s: MonopolyState, text: string, seat?: number, cardId?: string) {
  s.log.push({ text, ...(seat !== undefined ? { seat } : {}), ...(cardId ? { cardId } : {}) });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
}

function nextTurnSeat(s: MonopolyState, from: number): number {
  for (let step = 1; step <= s.players.length; step++) {
    const seat = (from + step) % s.players.length;
    if (seatActive(s, seat)) return seat;
  }
  throw new Error('No active seat');
}

/* ------------------------------- Game setup ------------------------------ */

export function createState(raw: unknown, context: GameContext): MonopolyState {
  const settings = monopolySettingsSchema.parse(raw);
  const n = context.players.length;
  if (n < 2 || n > 6 || new Set(context.players).size !== n) throw new Error('Invalid player count');
  const teams = settings.mode === 'teams';
  if (teams && n !== 4) throw new Error('Team mode requires exactly 4 players');
  if (!teams && n > settings.maxPlayers) throw new Error('Too many players for settings');

  let rng = context.seed >>> 0 || 1;
  let bankMembers: number[][], seatBank: number[];
  if (teams) {
    bankMembers = [[0, 1], [2, 3]];
    seatBank = [0, 0, 1, 1];
  } else {
    bankMembers = context.players.map((_, i) => [i]);
    seatBank = context.players.map((_, i) => i);
  }
  const banks = bankMembers.map(() => settings.startMoney);

  const [chanceDeck, r1] = shuffled(CHANCE_CARDS.map(c => c.id), rng); rng = r1;
  const [communityDeck, r2] = shuffled(COMMUNITY_CARDS.map(c => c.id), rng); rng = r2;

  const seats: SeatState[] = context.players.map(() => ({ position: 0, inJail: false, jailTurns: 0, out: false, getOutCards: 0, lastDice: null }));
  const state: MonopolyState = {
    players: [...context.players], mode: settings.mode,
    startMoney: settings.startMoney, turnSeconds: settings.turnSeconds,
    auctionSeconds: settings.auctionSeconds, tradeSeconds: settings.tradeSeconds, evenBuild: settings.evenBuild,
    banks, bankMembers, seatBank, seats,
    properties: BOARD.map(() => ({ owner: null, level: 0, mortgaged: false })),
    decks: { chance: chanceDeck, community: communityDeck, chanceOut: [], communityOut: [] },
    rng,
    phase: 'awaitRoll', turn: 0, doubles: 0, extraRollPending: false,
    pending: null, auction: null, trades: [], tradeSeq: 0, dice: null,
    deadline: context.startedAt + settings.turnSeconds * 1000, pausedRemaining: null,
    log: [{ text: 'Партия началась. Удачи!' }], lastEvent: 'start', forfeited: [],
  };
  assertInvariants(state);
  return state;
}

/* ------------------------------ Core helpers ----------------------------- */

function transfer(s: MonopolyState, fromBank: number, toBank: number | null, amount: number) {
  s.banks[fromBank] = s.banks[fromBank]! - amount;
  if (toBank !== null) s.banks[toBank] = s.banks[toBank]! + amount;
}
function gain(s: MonopolyState, bank: number, amount: number) { s.banks[bank] = s.banks[bank]! + amount; }

function ownedCountOfKind(s: MonopolyState, bank: number, kind: 'station' | 'utility'): number {
  return s.properties.filter((p, i) => p.owner === bank && BOARD[i]!.property?.kind === kind).length;
}
function rentOwed(s: MonopolyState, index: number, ownerBank: number, diceTotal: number): number {
  const def = BOARD[index]!.property!;
  const level = s.properties[index]!.level;
  const count = def.kind === 'station' ? ownedCountOfKind(s, ownerBank, 'station') : def.kind === 'utility' ? ownedCountOfKind(s, ownerBank, 'utility') : 0;
  return rentFor(def, level, count, diceTotal);
}

function totalLevels(s: MonopolyState, bank: number): number {
  return s.properties.reduce((sum, p) => p.owner === bank ? sum + p.level : sum, 0);
}
function propertyCount(s: MonopolyState, bank: number): number {
  return s.properties.filter(p => p.owner === bank).length;
}

/** All building levels owned by a bank, used by repair cards. */
function sendToJail(s: MonopolyState, seat: number) {
  const p = s.seats[seat]!;
  p.position = JAIL_INDEX; p.inJail = true; p.jailTurns = 0;
  s.extraRollPending = false;
  pushLog(s, playerName(s, seat) + ' отправлен в тюрьму', seat);
}

function advance(s: MonopolyState, seat: number, steps: number) {
  const p = s.seats[seat]!;
  const from = p.position;
  const total = from + steps;
  const laps = Math.floor(total / 40);
  p.position = ((total % 40) + 40) % 40;
  if (laps > 0 && steps > 0) {
    const bank = bankOf(s, seat);
    gain(s, bank, laps * GO_BONUS);
    pushLog(s, playerName(s, seat) + ' прошёл Старт: +' + laps * GO_BONUS, seat);
  }
}
function moveForwardTo(s: MonopolyState, seat: number, target: number) {
  const from = s.seats[seat]!.position;
  const steps = (target - from + 40) % 40;
  advance(s, seat, steps === 0 && target !== from ? 40 : steps);
}

/* --------------------------------- Cards --------------------------------- */

function drawCard(s: MonopolyState, deck: DeckKind): string {
  const d = s.decks;
  const pile = deck === 'chance' ? d.chance : d.community;
  const out = deck === 'chance' ? d.chanceOut : d.communityOut;
  if (!pile.length) {
    const [reshuffled, rng] = shuffled(out.splice(0), s.rng);
    s.rng = rng;
    pile.push(...reshuffled);
    out.length = 0;
  }
  const id = pile.pop()!;
  out.push(id);
  return id;
}

function applyCardEffect(s: MonopolyState, seat: number, cardId: string, now: number): 'debt' | 'ok' {
  // 'debt' means the card opened a debt phase and resolution must stop.
  const card = CARD_BY_ID.get(cardId);
  if (!card) throw new Error('Unknown card ' + cardId);
  const bank = bankOf(s, seat);
  const p = s.seats[seat]!;
  pushLog(s, 'Карта: ' + card.text, seat, cardId);
  const effect = card.effect;
  switch (effect.type) {
    case 'gain': gain(s, bank, effect.amount); return 'ok';
    case 'lose': return chargeOrDebt(s, seat, effect.amount, null, 'awaitEnd', now) ? 'debt' : 'ok';
    case 'gainPerProperty': gain(s, bank, effect.amount * propertyCount(s, bank)); return 'ok';
    case 'collectEach': {
      for (const other of activeBanks(s)) if (other !== bank) {
        const paid = Math.min(s.banks[other]!, effect.amount);
        if (paid > 0) { transfer(s, other, bank, paid); }
      }
      return 'ok';
    }
    case 'repairs': {
      const cost = effect.perLevel * totalLevels(s, bank);
      if (cost <= 0) return 'ok';
      return chargeOrDebt(s, seat, cost, null, 'awaitEnd', now) ? 'debt' : 'ok';
    }
    case 'getOutCard': p.getOutCards++; return 'ok';
    case 'moveBack': {
      p.position = (((p.position - effect.steps) % 40) + 40) % 40;
      return 'ok';
    }
    case 'moveTo': {
      if (effect.target === 'jail') { sendToJail(s, seat); return 'ok'; }
      if (effect.target === 'go') { moveForwardTo(s, seat, 0); return 'ok'; }
      if (effect.target === 'nearestStation' || effect.target === 'nearestUtility') {
        const kind = effect.target === 'nearestStation' ? 'station' : 'utility';
        for (let step = 1; step <= 40; step++) {
          const idx = (p.position + step) % 40;
          if (BOARD[idx]!.property?.kind === kind) { moveForwardTo(s, seat, idx); return 'ok'; }
        }
        return 'ok';
      }
      moveForwardTo(s, seat, effect.target);
      return 'ok';
    }
  }
}

/* --------------------------- Landing resolution -------------------------- */

/** Charge `amount` from the seat's bank to `creditor` (null = bank). Returns
 * true when a debt phase was opened instead. */
function chargeOrDebt(s: MonopolyState, seat: number, amount: number, creditor: number | null, returnPhase: 'awaitEnd' | 'awaitRoll', now: number): boolean {
  const bank = bankOf(s, seat);
  if (s.banks[bank]! >= amount) { transfer(s, bank, creditor, amount); return false; }
  s.pending = { type: 'debt', amount, creditor, returnPhase, forSeat: seat };
  s.phase = 'debt';
  s.deadline = now + s.turnSeconds * 2 * 1000;
  return true;
}

function resolvePurchaseOrRent(s: MonopolyState, seat: number, index: number, now: number) {
  const cell = s.properties[index]!;
  const bank = bankOf(s, seat);
  if (cell.owner === null) {
    s.pending = { type: 'purchase', index };
    s.phase = 'buy';
    s.deadline = now + s.turnSeconds * 1000;
    return;
  }
  if (cell.owner === bank || cell.mortgaged) return;
  const rent = rentOwed(s, index, cell.owner, s.dice ? s.dice[0] + s.dice[1] : 0);
  if (rent <= 0) return;
  chargeOrDebt(s, seat, rent, cell.owner, 'awaitEnd', now);
}

/** Resolve whatever the active seat stands on. Loops through card chains.
 * Ends with phase awaitEnd/awaitRoll/buy/auction/debt as appropriate. */
function resolveLanding(s: MonopolyState, seat: number, now: number) {
  for (let guard = 0; guard < 12; guard++) {
    const cell = BOARD[s.seats[seat]!.position]!;
    switch (cell.kind) {
      case 'go': case 'parking': case 'jail':
        return finishStep(s, now);
      case 'gotojail':
        sendToJail(s, seat);
        return finishStep(s, now);
      case 'tax': {
        if (!chargeOrDebt(s, seat, cell.tax!, null, 'awaitEnd', now)) pushLog(s, playerName(s, seat) + ' заплатил налог ' + cell.tax, seat);
        return;
      }
      case 'chance': case 'community': {
        const deck = cell.deck!;
        const posBefore = s.seats[seat]!.position;
        const cardId = drawCard(s, deck);
        if (applyCardEffect(s, seat, cardId, now) === 'debt') return;
        if (s.seats[seat]!.position === posBefore) return finishStep(s, now);
        continue; // card moved us (or sent us to jail): resolve the new cell
      }
      case 'property': case 'station': case 'utility': {
        resolvePurchaseOrRent(s, seat, cell.index, now);
        return finishStep(s, now);
      }
    }
  }
  throw new Error('Card chain overflow');
}

/** Enter awaitEnd, or awaitRoll again when a doubles roll is still pending.
 * Always (re)sets the phase deadline for the freshly entered phase. */
function finishStep(s: MonopolyState, now: number) {
  if (s.phase === 'debt' || s.phase === 'buy' || s.phase === 'auction') return;
  if (s.extraRollPending && seatActive(s, s.turn)) {
    s.extraRollPending = false;
    s.phase = 'awaitRoll';
  } else {
    s.phase = 'awaitEnd';
  }
  s.deadline = now + s.turnSeconds * 1000;
}

/* --------------------------------- Turns --------------------------------- */

function doRoll(s: MonopolyState, now: number) {
  const seat = s.turn;
  const p = s.seats[seat]!;
  let rng = s.rng;
  const [a, r1] = rngInt(rng, 6); rng = r1;
  const [b, r2] = rngInt(rng, 6);
  s.rng = r2;
  const dice: [number, number] = [a + 1, b + 1];
  s.dice = dice; p.lastDice = dice;
  pushLog(s, playerName(s, seat) + ' выбросил ' + dice[0] + ' и ' + dice[1], seat);
  s.lastEvent = 'roll';

  if (p.inJail) {
    if (dice[0] === dice[1]) {
      p.inJail = false; p.jailTurns = 0;
      pushLog(s, playerName(s, seat) + ' выбросил дубль и выходит из тюрьмы', seat);
      s.doubles++;
      if (s.doubles >= 3) {
        pushLog(s, playerName(s, seat) + ' выбросил третьи дубли — обратно в тюрьму', seat);
        sendToJail(s, seat);
        s.doubles = 0;
        finishStep(s, now);
        return;
      }
      s.extraRollPending = true;
      advance(s, seat, dice[0] + dice[1]);
      resolveLanding(s, seat, now);
      return;
    }
    p.jailTurns++;
    pushLog(s, playerName(s, seat) + ' не выбросил дубль в тюрьме (' + p.jailTurns + '/3)', seat);
    if (p.jailTurns >= 3) releaseFromJailForced(s, seat, now);
    finishStep(s, now);
    return;
  }

  s.doubles = dice[0] === dice[1] ? s.doubles + 1 : 0;
  if (s.doubles >= 3) {
    pushLog(s, playerName(s, seat) + ' выбросил третьи дубли подряд — в тюрьму', seat);
    sendToJail(s, seat);
    s.doubles = 0;
    finishStep(s, now);
  } else {
    s.extraRollPending = dice[0] === dice[1];
    advance(s, seat, dice[0] + dice[1]);
    resolveLanding(s, seat, now);
  }
}

/** Forced jail exit after the third failed doubles attempt. */
function releaseFromJailForced(s: MonopolyState, seat: number, now: number) {
  const p = s.seats[seat]!;
  const bank = bankOf(s, seat);
  if (s.banks[bank]! >= JAIL_BAIL) {
    transfer(s, bank, null, JAIL_BAIL);
    p.inJail = false; p.jailTurns = 0;
    pushLog(s, playerName(s, seat) + ' заплатил залог ' + JAIL_BAIL + ' и выходит из тюрьмы', seat);
  } else if (p.getOutCards > 0) {
    p.getOutCards--; p.inJail = false; p.jailTurns = 0;
    pushLog(s, playerName(s, seat) + ' использовал пропуск и выходит из тюрьмы', seat);
  } else {
    // Bail becomes a debt to the bank; the seat leaves jail on credit.
    p.inJail = false; p.jailTurns = 0;
    chargeOrDebt(s, seat, JAIL_BAIL, null, 'awaitEnd', now);
  }
}

function doEndTurn(s: MonopolyState, now: number) {
  checkFinished(s);
  if (s.phase === 'finished') return;
  s.turn = nextTurnSeat(s, s.turn);
  s.doubles = 0; s.extraRollPending = false; s.dice = s.seats[s.turn]!.lastDice;
  s.pending = null;
  s.phase = 'awaitRoll';
  s.deadline = now + s.turnSeconds * 1000;
  pushLog(s, 'Ход переходит к ' + playerName(s, s.turn), s.turn);
}

function checkFinished(s: MonopolyState) {
  const alive = activeBanks(s);
  if (alive.length <= 1 && s.phase !== 'finished') {
    s.phase = 'finished';
    s.deadline = 0;
    s.pending = null; s.auction = null;
    s.trades = [];
    pushLog(s, 'Партия завершена');
  }
}

function deadlineFor(s: MonopolyState, now: number): number {
  const seconds = s.phase === 'auction' ? s.auctionSeconds : s.phase === 'debt' ? s.turnSeconds * 2 : s.turnSeconds;
  return now + seconds * 1000;
}

/* ------------------------------- Auctions --------------------------------- */

function minNextBid(s: MonopolyState): number {
  const a = s.auction!;
  return a.currentBid === 0 ? MIN_BID : a.currentBid + BID_INCREMENT;
}
function startAuction(s: MonopolyState, index: number, now: number) {
  s.auction = { index, currentBid: 0, leader: null, passed: [], deadline: now + s.auctionSeconds * 1000 };
  // The system timer reads s.deadline — it must track the auction window,
  // not the stale buy/turn deadline, or timeouts resolve auctions early/late.
  s.deadline = s.auction.deadline;
  s.pending = null;
  s.phase = 'auction';
  pushLog(s, 'Аукцион: ' + BOARD[index]!.name + ' (стартовая ставка от ' + MIN_BID + ')');
}
function resolveAuction(s: MonopolyState, now: number) {
  const a = s.auction!;
  if (a.leader !== null) {
    const bank = a.leader;
    transfer(s, bank, null, a.currentBid);
    s.properties[a.index] = { owner: bank, level: 0, mortgaged: false };
    pushLog(s, playerName(s, s.bankMembers[bank]![0]!) + ' выиграл аукцион: ' + BOARD[a.index]!.name + ' за ' + a.currentBid, s.bankMembers[bank]![0]);
  } else {
    pushLog(s, 'Аукцион ' + BOARD[a.index]!.name + ' завершился без покупателя');
  }
  s.auction = null;
  s.phase = 'awaitEnd';
  finishStep(s, now);
}

/* --------------------------------- Debts --------------------------------- */

function settleDebtIfPossible(s: MonopolyState, now: number): boolean {
  const d = s.pending;
  if (!d || d.type !== 'debt') return false;
  const bank = bankOf(s, d.forSeat);
  if (s.banks[bank]! < d.amount) return false;
  transfer(s, bank, d.creditor, d.amount);
  pushLog(s, playerName(s, d.forSeat) + ' погасил долг ' + d.amount, d.forSeat);
  s.pending = null;
  s.phase = d.returnPhase;
  finishStep(s, now);
  return true;
}

function liquidateForDebt(s: MonopolyState, seat: number) {
  const bank = bankOf(s, seat);
  const covered = () => s.pending?.type === 'debt' && s.banks[bank]! >= s.pending.amount;
  // Sell buildings at half price, stopping as soon as the debt is covered.
  for (let i = 0; i < 40 && !covered(); i++) {
    const prop = s.properties[i]!;
    if (prop.owner === bank && prop.level > 0) {
      const def = BOARD[i]!.property!;
      const refund = Math.floor(def.houseCost / 2) * prop.level;
      prop.level = 0;
      gain(s, bank, refund);
      pushLog(s, playerName(s, seat) + ' продал постройки на ' + BOARD[i]!.name + ' (+ ' + refund + ')', seat);
    }
  }
  for (let i = 0; i < 40 && !covered(); i++) {
    const prop = s.properties[i]!;
    if (prop.owner === bank && !prop.mortgaged && prop.level === 0 && isPurchasable(i)) {
      prop.mortgaged = true;
      gain(s, bank, mortgageValue(BOARD[i]!.property!.price));
      pushLog(s, playerName(s, seat) + ' заложил ' + BOARD[i]!.name, seat);
    }
  }
}

/* ------------------------------- Bankruptcy ------------------------------ */

function bankruptBank(s: MonopolyState, bank: number, creditor: number | null, now: number) {
  const members = s.bankMembers[bank]!;
  // A bankrupt bank can never win a running auction.
  if (s.auction?.leader === bank) s.auction.leader = null;
  // Transfer assets.
  if (creditor !== null && creditor !== bank) {
    s.banks[creditor] = s.banks[creditor]! + s.banks[bank]!;
    s.banks[bank] = 0;
    for (let i = 0; i < 40; i++) if (s.properties[i]!.owner === bank) s.properties[i]!.owner = creditor;
    pushLog(s, 'Банкротство: активы переданы кредитору');
  } else {
    for (let i = 0; i < 40; i++) {
      const prop = s.properties[i]!;
      if (prop.owner === bank) { prop.owner = null; prop.level = 0; prop.mortgaged = false; }
    }
    s.banks[bank] = 0;
    pushLog(s, 'Банкротство: собственность возвращена банку');
  }
  for (const seat of members) {
    s.seats[seat]!.out = true;
    s.seats[seat]!.inJail = false;
  }
  s.forfeited = [...new Set([...s.forfeited, ...members])];
  // Drop trades touching any member seat.
  s.trades = s.trades.filter(t => !members.includes(t.from) && !members.includes(t.to));
  if (s.pending?.type === 'debt' && members.includes(s.pending.forSeat)) s.pending = null;
  // A debt owed TO the dead bank must not keep paying into it.
  if (s.pending?.type === 'debt' && s.pending.creditor === bank) s.pending.creditor = null;
  if (s.auction) {
    s.auction.passed = s.auction.passed.filter(b => bankActive(s, b));
    resolveAuction(s, now);
  }
  pushLog(s, 'Банк ' + (bank + 1) + ' обанкротился');
  checkFinished(s);
  if (s.phase !== 'finished' && s.phase !== 'auction' && members.includes(s.turn)) {
    try { s.turn = nextTurnSeat(s, s.turn); } catch { /* finished handled above */ }
    s.doubles = 0; s.extraRollPending = false; s.pending = null; s.phase = 'awaitRoll';
    s.deadline = now + s.turnSeconds * 1000;
  }
}

/* ------------------------------ Manage rules ----------------------------- */

function groupComplete(s: MonopolyState, bank: number, groupId: string): boolean {
  const group = GROUPS.find(g => g.id === groupId)!;
  return group.indices.every(i => s.properties[i]!.owner === bank);
}
function canBuildOn(s: MonopolyState, index: number, bank: number): boolean {
  const def = BOARD[index]!.property;
  if (!def || def.kind !== 'property' || def.houseCost === 0) return false;
  const prop = s.properties[index]!;
  if (prop.owner !== bank || prop.mortgaged || prop.level >= MAX_LEVEL) return false;
  const group = groupOfProperty(def);
  if (!group || !groupComplete(s, bank, group.id)) return false;
  // Classic rules: no construction while any group-mate is mortgaged.
  if (group.indices.some(i => s.properties[i]!.mortgaged)) return false;
  if (s.evenBuild) {
    const min = Math.min(...group.indices.map(i => s.properties[i]!.level));
    if (prop.level > min) return false;
  }
  return s.banks[bank]! >= def.houseCost;
}
function canSellBuilding(s: MonopolyState, index: number, bank: number): boolean {
  const prop = s.properties[index]!;
  return prop.owner === bank && prop.level > 0;
}
function canMortgage(s: MonopolyState, index: number, bank: number): boolean {
  const prop = s.properties[index]!;
  const def = BOARD[index]!.property;
  return !!def && prop.owner === bank && !prop.mortgaged && prop.level === 0;
}
function canUnmortgage(s: MonopolyState, index: number, bank: number): boolean {
  const prop = s.properties[index]!;
  const def = BOARD[index]!.property;
  return !!def && prop.owner === bank && prop.mortgaged && s.banks[bank]! >= unmortgageCost(def.price);
}
function isTradable(s: MonopolyState, index: number, bank: number): boolean {
  const prop = s.properties[index]!;
  return prop.owner === bank && prop.level === 0 && isPurchasable(index);
}

/* ------------------------------- Validation ------------------------------ */

export function invalidReason(s: MonopolyState, action: MonopolyAction, actorId: string, now: number): string | null {
  if (!Number.isFinite(now) || now < 0) return 'Некорректное время';
  if (s.phase === 'finished') return 'Партия завершена';
  const seat = seatOf(s, actorId);
  if (seat < 0) return 'Вы не участник партии';
  const bank = bankOf(s, seat);
  const mine = s.turn === seat;

  // Trade responses are allowed off-turn, any time before finish.
  if (action.type === 'accept' || action.type === 'decline' || action.type === 'cancel') {
    const offer = s.trades.find(t => t.id === action.offerId);
    if (!offer) return 'Предложение не найдено или истекло';
    if (action.type === 'accept' && now > offer.expiresAt) return 'Срок предложения истёк';
    if (action.type === 'accept' && seat !== offer.to) return 'Это предложение адресовано другому игроку';
    if (action.type === 'decline' && seat !== offer.to) return 'Это предложение адресовано другому игроку';
    if (action.type === 'cancel' && seat !== offer.from) return 'Отменить может только автор предложения';
    if (!seatActive(s, offer.from) || !seatActive(s, offer.to)) return 'Один из участников сделки выбыл';
    // Accepting mid-auction can push a bidder below their live bid →
    // resolveAuction would drive a bank negative and wedge the match.
    if (action.type === 'accept' && s.phase === 'auction' && s.auction) return 'Нельзя принять сделку во время аукциона';
    if (action.type === 'accept') {
      // Revalidate everything at confirmation time — assets may have moved on.
      const fromBank = bankOf(s, offer.from), toBank = bankOf(s, offer.to);
      if (s.banks[fromBank]! < offer.giveMoney || s.banks[toBank]! < offer.getMoney) return 'Недостаточно средств для сделки';
      for (const i of offer.giveProps) if (!isTradable(s, i, fromBank)) return 'Собственность изменилась — сделка невозможна';
      for (const i of offer.getProps) if (!isTradable(s, i, toBank)) return 'Собственность изменилась — сделка невозможна';
    }
    return null;
  }
  if (action.type === 'surrender') return seatActive(s, seat) ? null : 'Вы уже не участвуете в партии';

  // Auction bids: any active bank, before auction deadline.
  if (action.type === 'bid' || action.type === 'pass') {
    if (s.phase !== 'auction' || !s.auction) return 'Аукцион не идёт';
    if (now >= s.auction.deadline) return 'Время аукциона истекло';
    if (!bankActive(s, bank)) return 'Ваш банк не участвует в аукционе';
    if (s.auction.passed.includes(bank)) return 'Вы уже отказались от аукциона';
    if (action.type === 'pass') return s.auction.leader === bank ? 'Лидер не может пасовать — его должны перебить' : null;
    if (s.auction.leader === bank) return 'Вы уже делаете текущую ставку';
    const min = minNextBid(s);
    if (action.amount < min) return 'Минимальная ставка ' + min;
    if (action.amount > s.banks[bank]!) return 'Недостаточно средств для ставки';
    return null;
  }

  // Everything below is bound to the current turn seat.
  if (!mine) return 'Сейчас ход другого игрока';
  if (s.pausedRemaining !== null) return 'Партия приостановлена';
  if (now >= s.deadline) return 'Время хода истекло';

  switch (action.type) {
    case 'roll': {
      if (s.phase !== 'awaitRoll') return 'Сейчас нельзя бросать кубики';
      const p = s.seats[seat]!;
      if (p.inJail && p.jailTurns >= 3) return 'Третья попытка: заплатите залог, используйте пропуск или ждите';
      return null;
    }
    case 'payJail': {
      const p = s.seats[seat]!;
      if (s.phase !== 'awaitRoll' || !p.inJail) return 'Вы не в тюрьме';
      return s.banks[bank]! >= JAIL_BAIL ? null : 'Недостаточно средств для залога';
    }
    case 'jailCard': {
      const p = s.seats[seat]!;
      if (s.phase !== 'awaitRoll' || !p.inJail || p.getOutCards <= 0) return 'Нет пропуска из тюрьмы';
      return null;
    }
    case 'buy': {
      if (s.phase !== 'buy' || s.pending?.type !== 'purchase') return 'Покупка недоступна';
      const index = s.pending.index;
      if (s.properties[index]!.owner !== null) return 'Объект уже продан';
      const price = BOARD[index]!.property!.price;
      return s.banks[bank]! >= price ? null : 'Недостаточно средств для покупки';
    }
    case 'refuse': {
      if (s.phase !== 'buy' || s.pending?.type !== 'purchase') return 'Отказ от покупки недоступен';
      return null;
    }
    case 'endTurn': {
      if (s.phase !== 'awaitEnd') return 'Сейчас нельзя завершить ход';
      return null;
    }
    case 'build': return (s.phase === 'awaitRoll' || s.phase === 'awaitEnd') && canBuildOn(s, action.property, bank) ? null : 'Строительство здесь недоступно';
    case 'sell': return (s.phase === 'awaitRoll' || s.phase === 'awaitEnd' || s.phase === 'debt') && canSellBuilding(s, action.property, bank) ? null : 'Продажа построек здесь недоступна';
    case 'mortgage': return (s.phase === 'awaitRoll' || s.phase === 'awaitEnd' || s.phase === 'debt') && canMortgage(s, action.property, bank) ? null : 'Залог здесь недоступен';
    case 'unmortgage': return (s.phase === 'awaitRoll' || s.phase === 'awaitEnd') && canUnmortgage(s, action.property, bank) ? null : 'Выкуп здесь недоступен';
    case 'offer': {
      if (s.phase === 'auction') return 'Сделки сейчас недоступны';
      return validateOffer(s, seat, action, now);
    }
    default: return 'Неизвестное действие';
  }
}

function validateOffer(s: MonopolyState, from: number, action: Extract<MonopolyAction, { type: 'offer' }>, now: number): string | null {
  const to = seatOf(s, action.to);
  if (to < 0) return 'Игрок не найден';
  if (to === from) return 'Нельзя торговать с самим собой';
  if (!seatActive(s, to)) return 'Игрок выбыл из партии';
  const giveProps = [...new Set(action.giveProps)], getProps = [...new Set(action.getProps)];
  if (giveProps.length !== action.giveProps.length || getProps.length !== action.getProps.length) return 'Дубликаты в списке собственности';
  if (giveProps.some(i => !isPurchasable(i)) || getProps.some(i => !isPurchasable(i))) return 'Недопустимая клетка';
  if (giveProps.some(i => !isTradable(s, i, bankOf(s, from)))) return 'Можно передавать только свою незастроенную собственность';
  if (getProps.some(i => !isTradable(s, i, bankOf(s, to)))) return 'У партнёра нет такой незастроенной собственности';
  if (giveProps.some(i => getProps.includes(i))) return 'Один объект нельзя передать в обе стороны';
  if (action.giveMoney < 0 || action.getMoney < 0) return 'Некорректная сумма';
  if (s.banks[bankOf(s, from)]! < action.giveMoney) return 'Недостаточно средств для сделки';
  const liveTrades = s.trades.filter(t => t.expiresAt > now);
  if (liveTrades.filter(t => t.from === from).length >= 20 || liveTrades.length >= 100) return 'Слишком много активных предложений';
  if (liveTrades.some(t => t.from === from && t.to === to && t.giveMoney === action.giveMoney && t.getMoney === action.getMoney && t.giveProps.join() === giveProps.join() && t.getProps.join() === getProps.join())) return 'Такое предложение уже отправлено';
  return null;
}

/* ------------------------------- Transitions ----------------------------- */

export function transition(s: MonopolyState, raw: MonopolyAction, actorId: string, now: number): MonopolyState {
  const reason = invalidReason(s, raw, actorId, now);
  if (reason) throw new Error(reason);
  const next = copy(s);
  const seat = seatOf(next, actorId)!;
  const bank = bankOf(next, seat);
  next.lastEvent = raw.type;

  switch (raw.type) {
    case 'roll': doRoll(next, now); break;
    case 'endTurn': doEndTurn(next, now); break;
    case 'payJail': {
      const p = next.seats[seat]!;
      transfer(next, bank, null, JAIL_BAIL);
      p.inJail = false; p.jailTurns = 0;
      pushLog(next, playerName(next, seat) + ' заплатил залог ' + JAIL_BAIL, seat);
      break; // stays awaitRoll — player may now roll
    }
    case 'jailCard': {
      const p = next.seats[seat]!;
      p.getOutCards--; p.inJail = false; p.jailTurns = 0;
      pushLog(next, playerName(next, seat) + ' использовал пропуск из тюрьмы', seat);
      break;
    }
    case 'buy': {
      const d = next.pending!;
      if (d.type !== 'purchase') throw new Error('No purchase pending');
      const def = BOARD[d.index]!.property!;
      transfer(next, bank, null, def.price);
      next.properties[d.index] = { owner: bank, level: 0, mortgaged: false };
      pushLog(next, playerName(next, seat) + ' купил ' + def.name + ' за ' + def.price, seat);
      next.pending = null;
      next.phase = 'awaitEnd';
      finishStep(next, now);
      break;
    }
    case 'refuse': {
      const d = next.pending!;
      if (d.type !== 'purchase') throw new Error('No purchase pending');
      pushLog(next, playerName(next, seat) + ' отказался от ' + BOARD[d.index]!.name, seat);
      startAuction(next, d.index, now);
      break;
    }
    case 'bid': {
      const a = next.auction!;
      a.currentBid = raw.amount; a.leader = bank;
      a.passed = a.passed.filter(b => b !== bank);
      a.deadline = now + next.auctionSeconds * 1000;
      next.deadline = a.deadline;
      pushLog(next, 'Ставка ' + raw.amount + ' на ' + BOARD[a.index]!.name);
      // Early finish: everyone else passed.
      const others = activeBanks(next).filter(b => b !== bank);
      if (others.every(b => a.passed.includes(b))) resolveAuction(next, now);
      break;
    }
    case 'pass': {
      const a = next.auction!;
      a.passed.push(bank);
      const others = activeBanks(next).filter(b => b !== a.leader);
      if ((a.leader !== null && others.every(b => a.passed.includes(b))) ||
          (a.leader === null && activeBanks(next).every(b => a.passed.includes(b)))) resolveAuction(next, now);
      break;
    }
    case 'build': {
      const def = BOARD[raw.property]!.property!;
      next.properties[raw.property]!.level++;
      transfer(next, bank, null, def.houseCost);
      pushLog(next, playerName(next, seat) + ' построил уровень ' + next.properties[raw.property]!.level + ' на ' + def.name, seat);
      next.deadline = deadlineFor(next, now);
      break;
    }
    case 'sell': {
      const prop = next.properties[raw.property]!;
      const def = BOARD[raw.property]!.property!;
      const refund = Math.floor(def.houseCost / 2);
      prop.level--;
      gain(next, bank, refund);
      pushLog(next, playerName(next, seat) + ' продал постройку на ' + def.name + ' (+ ' + refund + ')', seat);
      next.deadline = deadlineFor(next, now);
      break;
    }
    case 'mortgage': {
      const def = BOARD[raw.property]!.property!;
      next.properties[raw.property]!.mortgaged = true;
      gain(next, bank, mortgageValue(def.price));
      pushLog(next, playerName(next, seat) + ' заложил ' + def.name, seat);
      next.deadline = deadlineFor(next, now);
      break;
    }
    case 'unmortgage': {
      const def = BOARD[raw.property]!.property!;
      const cost = unmortgageCost(def.price);
      transfer(next, bank, null, cost);
      next.properties[raw.property]!.mortgaged = false;
      pushLog(next, playerName(next, seat) + ' выкупил ' + def.name + ' (' + cost + ')', seat);
      next.deadline = deadlineFor(next, now);
      break;
    }
    case 'offer': {
      const to = seatOf(next, raw.to)!;
      next.tradeSeq++;
      next.trades.push({
        id: 't' + next.tradeSeq, from: seat, to,
        giveMoney: raw.giveMoney, giveProps: [...new Set(raw.giveProps)],
        getMoney: raw.getMoney, getProps: [...new Set(raw.getProps)],
        createdAt: now, expiresAt: now + next.tradeSeconds * 1000,
      });
      pushLog(next, playerName(next, seat) + ' предложил сделку ' + playerName(next, to), seat);
      break;
    }
    case 'accept': {
      const offer = next.trades.find(t => t.id === raw.offerId)!;
      next.trades = next.trades.filter(t => t.id !== offer.id);
      const fromBank = bankOf(next, offer.from), toBank = bankOf(next, offer.to);
      next.banks[fromBank] = next.banks[fromBank]! + offer.getMoney - offer.giveMoney;
      next.banks[toBank] = next.banks[toBank]! + offer.giveMoney - offer.getMoney;
      for (const i of offer.giveProps) next.properties[i]!.owner = toBank;
      for (const i of offer.getProps) next.properties[i]!.owner = fromBank;
      pushLog(next, 'Сделка ' + playerName(next, offer.from) + ' - ' + playerName(next, offer.to) + ' завершена', offer.from);
      settleDebtIfPossible(next, now);
      settleDebtIfPossible(next, now);
      break;
    }
    case 'decline': case 'cancel': {
      next.trades = next.trades.filter(t => t.id !== raw.offerId);
      break;
    }
    case 'surrender': {
      pushLog(next, playerName(next, seat) + ' сдаётся', seat);
      bankruptBank(next, bank, null, now);
      break;
    }
  }

  // Debt can be settled by any balance-increasing action above.
  if (next.phase === 'debt' && next.pending?.type === 'debt') settleDebtIfPossible(next, now);
  checkFinished(next);
  assertInvariants(next);
  return next;
}

/* ------------------------------ System actions --------------------------- */

const systemSchema = z.object({ type: z.enum(['timeout', 'pause', 'resume', 'recover']) }).strict();

function sweepExpiredTrades(s: MonopolyState, now: number) {
  const before = s.trades.length;
  s.trades = s.trades.filter(t => t.expiresAt > now);
  if (s.trades.length !== before) pushLog(s, 'Часть предложений обмена истекла');
}

function autoTimeout(s: MonopolyState, now: number) {
  sweepExpiredTrades(s, now);
  switch (s.phase) {
    case 'awaitRoll': {
      const seat = s.turn;
      const p = s.seats[seat]!;
      if (p.inJail && p.jailTurns >= 3) {
        // Forced resolution mirrors the third failed attempt.
        releaseFromJailForced(s, seat, now);
        finishStep(s, now);
      } else {
        doRoll(s, now);
      }
      break;
    }
    case 'awaitEnd': doEndTurn(s, now); break;
    case 'buy': {
      const d = s.pending!;
      if (d.type === 'purchase') {
        pushLog(s, playerName(s, s.turn) + ' не ответил — запущен аукцион', s.turn);
        startAuction(s, d.index, now);
      }
      break;
    }
    case 'auction': resolveAuction(s, now); break;
    case 'debt': {
      const d = s.pending;
      if (d?.type === 'debt') {
        liquidateForDebt(s, d.forSeat);
        if (!settleDebtIfPossible(s, now)) {
          // Nothing left to raise: forced bankruptcy to the creditor.
          bankruptBank(s, bankOf(s, d.forSeat), d.creditor, now);
        }
      }
      break;
    }
    case 'finished': break;
  }
}

export function systemAction(s: MonopolyState, now: number, online: boolean) {
  if (s.phase === 'finished') return null;
  if (!online && s.pausedRemaining === null) return { type: 'pause' };
  if (online && s.pausedRemaining !== null) return { type: 'resume' };
  return online && now >= s.deadline ? { type: 'timeout' } : null;
}
export function applySystem(s: MonopolyState, raw: unknown, now: number): MonopolyState {
  const action = systemSchema.parse(raw);
  if (s.phase === 'finished') throw new Error('Finished game');
  if (action.type === 'recover') return { ...copy(s), deadline: Math.max(s.deadline, now + s.turnSeconds * 1000), lastEvent: 'resume' };
  if (action.type === 'pause') {
    if (s.pausedRemaining !== null) throw new Error('Already paused');
    return { ...copy(s), pausedRemaining: Math.max(0, s.deadline - now), lastEvent: 'pause' };
  }
  if (action.type === 'resume') {
    if (s.pausedRemaining === null) throw new Error('Not paused');
    const remaining = s.pausedRemaining;
    const next = copy(s);
    next.deadline = now + remaining;
    // Auction deadlines are absolute rolling values; resume shifts them too.
    if (next.auction) next.auction.deadline += remaining;
    next.pausedRemaining = null;
    next.lastEvent = 'resume';
    return next;
  }
  if (s.pausedRemaining !== null || now < s.deadline) throw new Error('Timer not due');
  const next = copy(s);
  autoTimeout(next, now);
  assertInvariants(next);
  return next;
}

/* --------------------------------- Result -------------------------------- */

export function isFinished(s: MonopolyState): boolean { return s.phase === 'finished'; }
export function result(s: MonopolyState): GameResult | null {
  if (s.phase !== 'finished') return null;
  const alive = activeBanks(s);
  const winnerSeats = alive.length === 1 ? s.bankMembers[alive[0]!]! : [];
  const winners = winnerSeats.map(seat => s.players[seat]!);
  const losers = s.players.filter((_, seat) => !winnerSeats.includes(seat));
  if (!winners.length) return { winners: [], losers: [], draw: true };
  return { winners, losers, draw: false };
}

/* ---------------------------------- View --------------------------------- */

function viewFlags(s: MonopolyState, seat: number) {
  const bank = bankOf(s, seat);
  const p = s.seats[seat]!;
  const mine = s.turn === seat;
  const active = s.pausedRemaining === null;
  const managePhase = mine && active && (s.phase === 'awaitRoll' || s.phase === 'awaitEnd');
  const debtPhase = mine && active && s.phase === 'debt';
  return {
    canRoll: mine && s.phase === 'awaitRoll' && active && !(p.inJail && p.jailTurns >= 3),
    canPayJail: mine && s.phase === 'awaitRoll' && active && p.inJail && s.banks[bank]! >= JAIL_BAIL,
    canUseJailCard: mine && s.phase === 'awaitRoll' && active && p.inJail && p.getOutCards > 0,
    canEndTurn: mine && s.phase === 'awaitEnd' && active,
    canBuy: mine && s.phase === 'buy' && active && s.pending?.type === 'purchase' && s.banks[bank]! >= BOARD[s.pending.index]!.property!.price,
    canRefuse: mine && s.phase === 'buy' && active && s.pending?.type === 'purchase',
    canBid: s.phase === 'auction' && s.auction !== null && active && bankActive(s, bank) && !s.auction.passed.includes(bank) && s.auction.leader !== bank,
    canAuctionPass: s.phase === 'auction' && s.auction !== null && active && bankActive(s, bank) && !s.auction.passed.includes(bank),
    canSurrender: seatActive(s, seat) && s.phase !== 'finished',
    canTrade: seatActive(s, seat) && s.phase !== 'finished' && s.phase !== 'auction',
    buildable: managePhase ? s.properties.map((_, i) => i).filter(i => canBuildOn(s, i, bank)) : [],
    sellable: (managePhase || debtPhase) ? s.properties.map((_, i) => i).filter(i => canSellBuilding(s, i, bank)) : [],
    mortgageable: (managePhase || debtPhase) ? s.properties.map((_, i) => i).filter(i => canMortgage(s, i, bank)) : [],
    unmortgageable: managePhase ? s.properties.map((_, i) => i).filter(i => canUnmortgage(s, i, bank)) : [],
    tradable: s.properties.map((_, i) => i).filter(i => isTradable(s, i, bank)),
  };
}

export function playerView(s: MonopolyState, playerId: string) {
  const seat = seatOf(s, playerId);
  if (seat < 0) throw new Error('Not a participant');
  const toMe = s.trades.filter(t => t.to === seat).map(t => ({ ...t, giveProps: [...t.giveProps], getProps: [...t.getProps] }));
  const byMe = s.trades.filter(t => t.from === seat).map(t => ({ ...t, giveProps: [...t.giveProps], getProps: [...t.getProps] }));
  return {
    mode: s.mode,
    players: s.players.map((id, i) => ({
      id, seat: i, bank: s.seatBank[i]!, bankBalance: s.banks[s.seatBank[i]!]!, team: s.bankMembers[s.seatBank[i]!]!.length > 1 ? s.seatBank[i]! : null,
      position: s.seats[i]!.position, inJail: s.seats[i]!.inJail, jailTurns: s.seats[i]!.jailTurns,
      out: s.seats[i]!.out, getOutCards: s.seats[i]!.getOutCards, lastDice: s.seats[i]!.lastDice ? [...s.seats[i]!.lastDice] : null,
    })),
    banks: s.banks.map((balance, i) => ({ id: i, balance, active: bankActive(s, i), members: [...s.bankMembers[i]!] })),
    properties: s.properties.map((p, i) => ({ index: i, owner: p.owner, level: p.level, mortgaged: p.mortgaged })),
    phase: s.phase, turnSeat: s.turn, turnPlayerId: s.players[s.turn]!, doubles: s.doubles,
    pending: s.pending ? { ...s.pending } : null,
    auction: s.auction ? { index: s.auction.index, currentBid: s.auction.currentBid, leader: s.auction.leader, passed: [...s.auction.passed], deadline: s.auction.deadline, minNextBid: minNextBid(s) } : null,
    trades: { toMe, byMe, pendingCount: s.trades.length - toMe.length - byMe.length },
    dice: s.dice ? [...s.dice] : null,
    deadline: s.deadline, paused: s.pausedRemaining !== null,
    deckCounts: { chance: s.decks.chance.length, community: s.decks.community.length },
    flags: viewFlags(s, seat),
    log: s.log.slice(-40),
    result: result(s),
  };
}
export type MonopolyView = ReturnType<typeof playerView>;

/* ------------------------------- Invariants ------------------------------ */

export function assertInvariants(s: MonopolyState): void {
  if (s.players.length !== s.seats.length || s.seatBank.length !== s.players.length) throw new Error('Seat mismatch');
  if (s.banks.length !== s.bankMembers.length || s.banks.length < 2 || s.banks.length > 6) throw new Error('Bank mismatch');
  if (s.banks.some(b => !Number.isInteger(b) || b < 0)) throw new Error('Negative balance');
  const allSeats = s.bankMembers.flat();
  if (allSeats.length !== s.players.length || new Set(allSeats).size !== allSeats.length) throw new Error('Bank membership mismatch');
  if (s.properties.length !== 40) throw new Error('Board size');
  for (let i = 0; i < 40; i++) {
    const p = s.properties[i]!;
    if (p.owner !== null && (p.owner < 0 || p.owner >= s.banks.length)) throw new Error('Bad owner');
    if (p.level < 0 || p.level > MAX_LEVEL) throw new Error('Bad level');
    if (!isPurchasable(i) && (p.owner !== null || p.level !== 0 || p.mortgaged)) throw new Error('Non-purchasable cell mutated');
    if (p.mortgaged && p.level > 0) throw new Error('Mortgaged property with buildings');
  }
  if (s.phase !== 'finished') {
    if (!seatActive(s, s.turn)) throw new Error('Turn seat inactive');
    if (s.phase === 'buy' && s.pending?.type !== 'purchase') throw new Error('Bad buy phase');
    if (s.phase === 'debt' && s.pending?.type !== 'debt') throw new Error('Bad debt phase');
    if (s.phase === 'auction' && !s.auction) throw new Error('Bad auction phase');
    if (s.phase !== 'auction' && s.auction) throw new Error('Orphan auction');
    if (s.phase !== 'buy' && s.pending?.type === 'purchase') throw new Error('Orphan purchase');
  }
  const deckTotal = s.decks.chance.length + s.decks.chanceOut.length + s.decks.community.length + s.decks.communityOut.length;
  if (deckTotal !== CHANCE_CARDS.length + COMMUNITY_CARDS.length) throw new Error('Card conservation violated');
  if (s.trades.some(t => s.seats[t.from]!.out || s.seats[t.to]!.out)) throw new Error('Trade with inactive seat');
  const outSeats = s.seats.flatMap((p, i) => p.out ? [i] : []);
  if (new Set(s.forfeited).size !== s.forfeited.length || s.forfeited.some(i => !outSeats.includes(i)) || outSeats.some(i => !s.forfeited.includes(i))) throw new Error('Forfeited mismatch');
}
