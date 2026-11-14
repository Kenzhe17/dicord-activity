import { z } from 'zod';
import type { GameContext, GameResult } from '@rize/platform-core';
import { codenamesSettingsSchema } from '../server/definition';
import { getDictionary } from './words';

export type Team = 'red' | 'blue';
export type CardRole = 'red' | 'blue' | 'neutral' | 'assassin';

const teamSchema = z.enum(['red', 'blue']);
const cardRoleSchema = z.enum(['red', 'blue', 'neutral', 'assassin']);
const assignmentSchema = z.object({
  playerId: z.string(),
  team: z.enum(['red', 'blue', 'spectator']),
  role: z.enum(['spymaster', 'operative', 'spectator']),
}).strict();
const turnSchema = z.object({
  team: teamSchema, word: z.string(), count: z.number().int().min(0).max(25),
  picks: z.array(z.number().int().min(0).max(24)).max(25), used: z.number().int().min(0).max(25),
}).strict();
const historySchema = z.object({
  team: teamSchema, word: z.string(), count: z.number().int().min(0).max(25),
  picks: z.array(z.number().int().min(0).max(24)).max(25),
  outcome: z.enum(['own', 'enemy', 'neutral', 'assassin', 'limit', 'passed', 'timeout']),
}).strict();

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choose'), team: z.enum(['red', 'blue', 'spectator']), role: z.enum(['spymaster', 'operative']).optional() }).strict(),
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('hint'), word: z.string(), count: z.number().int() }).strict(),
  z.object({ type: z.literal('pick'), index: z.number().int().min(0).max(24) }).strict(),
  z.object({ type: z.literal('endTurn') }).strict(),
  z.object({ type: z.literal('surrender') }).strict(),
]);
export type CodenamesAction = z.infer<typeof actionSchema>;

export const stateSchema = z.object({
  players: z.array(z.string()).min(4).max(12),
  hostId: z.string(),
  ruleSet: z.enum(['classic', 'unlimited']),
  timed: z.boolean(), hintSeconds: z.number().int().min(10).max(600), guessSeconds: z.number().int().min(15).max(900),
  traitor: z.boolean(), dictionary: z.string(), dictionaryVersion: z.string(),
  assignments: z.array(assignmentSchema).min(4).max(12),
  board: z.object({
    words: z.array(z.string()).length(25),
    roles: z.array(cardRoleSchema).length(25),
    revealed: z.array(z.boolean()).length(25),
  }).strict(),
  starter: teamSchema, currentTeam: teamSchema, winner: teamSchema.nullable(),
  phase: z.enum(['draft', 'hint', 'guess', 'finished']),
  turn: turnSchema.nullable(), history: z.array(historySchema).max(2000),
  traitors: z.object({ red: z.string().nullable(), blue: z.string().nullable() }).strict(),
  endReason: z.string().nullable(),
  deadline: z.number().finite().nullable(), pausedRemaining: z.number().min(0).nullable(),
  rng: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  lastEvent: z.string(),
}).strict();
export type CodenamesState = z.infer<typeof stateSchema>;
export type CodenamesView = ReturnType<typeof playerView>;

/** Deterministic PRNG state (mulberry32). Stored in state so replays match. */
function nextRandom(state: number): { value: number; state: number } {
  const value = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(value ^ (value >>> 15), 1 | value);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: value >>> 0 };
}

const other = (team: Team): Team => team === 'red' ? 'blue' : 'red';
const copy = (s: CodenamesState): CodenamesState => ({
  ...s, players: [...s.players], assignments: s.assignments.map(a => ({ ...a })),
  board: { words: [...s.board.words], roles: [...s.board.roles], revealed: [...s.board.revealed] },
  turn: s.turn ? { ...s.turn, picks: [...s.turn.picks] } : null,
  history: s.history.map(h => ({ ...h, picks: [...h.picks] })),
  traitors: { ...s.traitors },
});
const assignmentOf = (s: CodenamesState, playerId: string) => s.assignments.find(a => a.playerId === playerId);
const teamMembers = (s: CodenamesState, team: Team | 'spectator') => s.assignments.filter(a => a.team === team).map(a => a.playerId);
const remaining = (s: CodenamesState, team: Team) => s.board.roles.filter((r, i) => r === team && !s.board.revealed[i]).length;
const phaseSeconds = (s: CodenamesState) => s.phase === 'hint' ? s.hintSeconds : s.guessSeconds;
const timedDeadline = (s: CodenamesState, phase: 'hint' | 'guess', now: number) => s.timed ? now + (phase === 'hint' ? s.hintSeconds : s.guessSeconds) * 1000 : null;

function normalizeWord(raw: string): string | null {
  const word = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!word || word.length > 30 || /\s/.test(word)) return null;
  if (!/^[\p{L}][\p{L}'’-]{0,29}$/u.test(word)) return null;
  return word;
}

export function createState(raw: unknown, context: GameContext): CodenamesState {
  const settings = codenamesSettingsSchema.parse(raw);
  const n = context.players.length;
  if (n < 4 || n > 12 || new Set(context.players).size !== n) throw new Error('Invalid player count');
  const dictionary = getDictionary(settings.dictionary);
  if (dictionary.words.length < 100) throw new Error('Dictionary too small');
  // Board: 25 unique words sampled by a seeded Fisher–Yates shuffle.
  let rng = (context.seed >>> 0) || 1;
  const pool = [...dictionary.words];
  const words: string[] = [];
  for (let i = 0; i < 25; i++) {
    const r = nextRandom(rng); rng = r.state;
    const j = i + Math.floor(r.value * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    words.push(pool[i]!);
  }
  const starterRoll = nextRandom(rng); rng = starterRoll.state;
  const starter: Team = starterRoll.value < 0.5 ? 'red' : 'blue';
  const enemy = other(starter);
  const roles: CardRole[] = [
    ...Array<CardRole>(9).fill(starter), ...Array<CardRole>(8).fill(enemy),
    ...Array<CardRole>(7).fill('neutral'), 'assassin',
  ];
  for (let i = roles.length - 1; i > 0; i--) {
    const r = nextRandom(rng); rng = r.state;
    const j = Math.floor(r.value * (i + 1));
    [roles[i], roles[j]] = [roles[j]!, roles[i]!];
  }
  const state: CodenamesState = {
    players: [...context.players], hostId: context.hostId ?? context.players[0]!,
    ruleSet: settings.ruleSet, timed: settings.timed,
    hintSeconds: settings.hintSeconds, guessSeconds: settings.guessSeconds,
    traitor: settings.traitor, dictionary: settings.dictionary, dictionaryVersion: dictionary.version,
    assignments: context.players.map(playerId => ({ playerId, team: 'spectator' as const, role: 'spectator' as const })),
    board: { words, roles, revealed: Array(25).fill(false) },
    starter, currentTeam: starter, winner: null,
    phase: 'draft', turn: null, history: [],
    traitors: { red: null, blue: null }, endReason: null,
    deadline: null, pausedRemaining: null, rng, turnCount: 0, lastEvent: 'deal',
  };
  assertInvariants(state);
  return state;
}

function startBlockReason(s: CodenamesState): string | null {
  if (s.players.length < 4) return 'Минимум 4 игрока';
  for (const team of ['red', 'blue'] as const) {
    const label = team === 'red' ? 'красных' : 'синих';
    const members = s.assignments.filter(a => a.team === team);
    const spymasters = members.filter(a => a.role === 'spymaster');
    if (spymasters.length !== 1) return `В команде ${label} нужен ровно один руководитель`;
    if (members.length < 2) return `В команде ${label} должно быть минимум 2 игрока`;
    if (s.traitor && members.length < 3) return 'В режиме предателя в каждой команде минимум 3 игрока';
  }
  return null;
}

function beginGame(s: CodenamesState, now: number): CodenamesState {
  const next = copy(s);
  if (next.traitor) {
    // One secret traitor per team, drawn deterministically from the rng stream.
    for (const team of ['red', 'blue'] as const) {
      const operatives = next.assignments.filter(a => a.team === team && a.role === 'operative').map(a => a.playerId);
      const r = nextRandom(next.rng); next.rng = r.state;
      next.traitors[team] = operatives[Math.floor(r.value * operatives.length)]!;
    }
  }
  next.phase = 'hint';
  next.currentTeam = next.starter;
  next.turnCount = 1;
  next.deadline = timedDeadline(next, 'hint', now);
  next.lastEvent = 'start';
  assertInvariants(next);
  return next;
}

function closeTurn(s: CodenamesState, outcome: CodenamesState['history'][number]['outcome'], now: number): CodenamesState {
  const next = copy(s);
  if (next.turn) {
    next.history.push({ team: next.turn.team, word: next.turn.word, count: next.turn.count, picks: [...next.turn.picks], outcome });
    if (next.history.length > 2000) next.history.shift();
  }
  next.turn = null;
  next.currentTeam = other(next.currentTeam);
  next.phase = 'hint';
  next.turnCount++;
  next.deadline = timedDeadline(next, 'hint', now);
  next.lastEvent = outcome === 'timeout' ? 'timeout' : 'pass';
  assertInvariants(next);
  return next;
}

function finish(s: CodenamesState, winner: Team, reason: string): CodenamesState {
  const next = copy(s);
  if (next.turn) {
    const outcome = reason === 'assassin' ? 'assassin' : reason === 'surrender' ? 'passed' : 'own';
    next.history.push({ team: next.turn.team, word: next.turn.word, count: next.turn.count, picks: [...next.turn.picks], outcome });
    next.turn = null;
  }
  next.phase = 'finished';
  next.winner = winner;
  next.endReason = reason;
  next.deadline = null;
  next.pausedRemaining = null;
  next.lastEvent = 'finished';
  assertInvariants(next);
  return next;
}

function afterPick(s: CodenamesState, index: number, now: number): CodenamesState {
  const next = copy(s);
  const role = next.board.roles[index]!;
  const team = next.currentTeam;
  next.board.revealed[index] = true;
  if (next.turn) next.turn.picks.push(index);
  if (role === 'assassin') return finish(next, other(team), 'assassin');
  if (role === team) {
    if (next.turn) next.turn.used++;
    if (remaining(next, team) === 0) return finish(next, team, 'all-own');
    // Official rules: classic allows count+1 own guesses ("plus one"); a 0
    // clue and the unlimited ruleset remove the cap entirely.
    const turn = next.turn;
    const capped = turn !== null && next.ruleSet === 'classic' && turn.count > 0 && turn.used >= turn.count + 1;
    if (capped) return closeTurn(next, 'limit', now);
    next.lastEvent = 'pick-own';
    next.deadline = timedDeadline(next, 'guess', now);
    assertInvariants(next);
    return next;
  }
  // Enemy card or neutral: the turn always ends. If the revealed enemy card
  // was the owning team's last word, THAT team wins — they have nothing left
  // to guess, no matter who flipped the card (official "other team guesses
  // your last word" rule).
  if (role === other(team) && remaining(next, other(team)) === 0) {
    if (next.turn) {
      next.history.push({ team: next.turn.team, word: next.turn.word, count: next.turn.count, picks: [...next.turn.picks], outcome: 'enemy' });
      next.turn = null;
    }
    return finish(next, other(team), 'all-enemy');
  }
  return closeTurn(next, role === 'neutral' ? 'neutral' : 'enemy', now);
}

/** Mirrors every rejection transition() can raise, so validateAction is total. */
function chooseBlockReason(s: CodenamesState, action: Extract<CodenamesAction, { type: 'choose' }>, actorId: string): string | null {
  const team = action.team === 'spectator' ? 'spectator' : action.team;
  const role = team === 'spectator' ? 'spectator' : action.role ?? 'operative';
  if (role === 'spymaster' && s.assignments.some(a => a.playerId !== actorId && a.team === team && a.role === 'spymaster')) {
    return 'Руководитель в команде уже выбран';
  }
  return null;
}

export function invalidReason(s: CodenamesState, action: CodenamesAction, actorId: string, now: number): string | null {
  if (!Number.isFinite(now) || now < 0) return 'Некорректное время';
  if (s.phase === 'finished') return 'Партия завершена';
  if (action.type === 'surrender') {
    const me = assignmentOf(s, actorId);
    return me && me.team !== 'spectator' ? null : 'Наблюдатель не может сдаться';
  }
  if (s.pausedRemaining !== null) return 'Партия приостановлена';
  if (s.phase === 'draft') {
    if (action.type === 'choose') return chooseBlockReason(s, action, actorId);
    if (action.type === 'start') {
      if (s.hostId !== actorId) return 'Только организатор может начать партию';
      return startBlockReason(s);
    }
    return 'Сначала завершите распределение по командам';
  }
  if (s.timed && s.deadline !== null && now >= s.deadline) return 'Время хода истекло';
  const me = assignmentOf(s, actorId);
  switch (action.type) {
    case 'choose': return 'Команды выбираются только до начала партии';
    case 'start': return 'Партия уже идёт';
    case 'hint': {
      if (s.phase !== 'hint') return 'Сейчас не фаза подсказки';
      if (!me || me.team !== s.currentTeam || me.role !== 'spymaster') return 'Подсказку даёт только руководитель текущей команды';
      const word = normalizeWord(action.word);
      if (!word) return 'Подсказка должна быть одним словом до 30 символов';
      const open = s.board.words.some((w, i) => !s.board.revealed[i] && w.toLowerCase() === word);
      if (open) return 'Нельзя подсказывать слово с поля';
      const own = remaining(s, s.currentTeam);
      if (!Number.isInteger(action.count) || action.count < 0 || action.count > own) return `Число должно быть от 0 до ${own}`;
      return null;
    }
    case 'pick': {
      if (s.phase !== 'guess') return 'Сейчас не фаза угадывания';
      if (!me || me.team !== s.currentTeam || me.role !== 'operative') return 'Угадывать могут только игроки текущей команды';
      if (action.index < 0 || action.index >= s.board.roles.length || s.board.revealed[action.index]) return 'Эта карточка уже открыта';
      return null;
    }
    case 'endTurn': {
      if (s.phase !== 'guess') return 'Ход уже завершён';
      if (!me || me.team !== s.currentTeam || me.role === 'spectator') return 'Завершить ход может только текущая команда';
      if (!s.turn || s.turn.picks.length === 0) return 'Сначала сделайте хотя бы одну попытку';
      return null;
    }
  }
}

export function transition(s: CodenamesState, raw: CodenamesAction, actorId: string, now: number): CodenamesState {
  const reason = invalidReason(s, raw, actorId, now);
  if (reason) throw new Error(reason);
  const action = raw;
  if (action.type === 'surrender') {
    const me = assignmentOf(s, actorId)!;
    return finish(s, other(me.team as Team), 'surrender');
  }
  if (s.phase === 'draft') {
    if (action.type === 'choose') {
      const next = copy(s);
      const index = next.assignments.findIndex(a => a.playerId === actorId);
      const team = action.team === 'spectator' ? 'spectator' as const : action.team;
      const role: 'spymaster' | 'operative' | 'spectator' = team === 'spectator' ? 'spectator' : action.role ?? 'operative';
      next.assignments[index] = { playerId: actorId, team, role };
      next.lastEvent = 'choose';
      assertInvariants(next);
      return next;
    }
    return beginGame(s, now);
  }
  if (action.type === 'hint') {
    const next = copy(s);
    const word = normalizeWord(action.word)!;
    // count = 0 is the official "zero clue": unlimited guesses, no plus-one.
    next.phase = 'guess';
    next.turn = { team: next.currentTeam, word, count: action.count, picks: [], used: 0 };
    next.deadline = timedDeadline(next, 'guess', now);
    next.lastEvent = 'hint';
    assertInvariants(next);
    return next;
  }
  if (action.type === 'pick') return afterPick(s, action.index, now);
  return closeTurn(s, 'passed', now);
}

export function legalActions(s: CodenamesState, playerId: string): CodenamesAction[] {
  if (s.phase === 'finished' || s.pausedRemaining !== null) return [];
  const me = assignmentOf(s, playerId);
  if (!me) return [];
  const out: CodenamesAction[] = [];
  if (s.phase === 'draft') {
    out.push({ type: 'choose', team: 'red', role: 'operative' }, { type: 'choose', team: 'blue', role: 'operative' }, { type: 'choose', team: 'spectator' });
    if (s.hostId === playerId && !startBlockReason(s)) out.push({ type: 'start' });
    return out;
  }
  if (me.team === 'spectator') return out;
  if (s.phase === 'guess' && me.team === s.currentTeam) {
    if (me.role === 'operative') {
      for (let i = 0; i < 25; i++) if (!s.board.revealed[i]) out.push({ type: 'pick', index: i });
    }
    if (s.turn && s.turn.picks.length > 0) out.push({ type: 'endTurn' });
  }
  out.push({ type: 'surrender' });
  return out;
}

export function result(s: CodenamesState): GameResult | null {
  if (s.phase !== 'finished' || !s.winner) return null;
  return { winners: teamMembers(s, s.winner), losers: teamMembers(s, other(s.winner)), draw: false };
}

export function playerView(s: CodenamesState, playerId: string) {
  const me = assignmentOf(s, playerId);
  if (!me) throw new Error('Not a participant');
  const inGame = s.phase === 'hint' || s.phase === 'guess';
  const isTraitor = !!(s.traitor && (s.traitors.red === playerId || s.traitors.blue === playerId));
  const spymasterTeam = (team: Team) => s.assignments.find(a => a.team === team && a.role === 'spymaster')?.playerId ?? null;
  const base = {
    phase: s.phase, ruleSet: s.ruleSet, timed: s.timed, traitorMode: s.traitor,
    hintSeconds: s.hintSeconds, guessSeconds: s.guessSeconds, dictionaryVersion: s.dictionaryVersion,
    starter: s.starter, currentTeam: s.currentTeam,
    board: s.board.words.map((word, i) => ({
      index: i, word, revealed: s.board.revealed[i],
      color: s.board.revealed[i] ? s.board.roles[i]! : null,
    })),
    remaining: { red: remaining(s, 'red'), blue: remaining(s, 'blue') },
    teams: {
      red: {
        members: teamMembers(s, 'red'), spymasterId: spymasterTeam('red'),
        operatives: s.assignments.filter(a => a.team === 'red' && a.role === 'operative').map(a => a.playerId),
      },
      blue: {
        members: teamMembers(s, 'blue'), spymasterId: spymasterTeam('blue'),
        operatives: s.assignments.filter(a => a.team === 'blue' && a.role === 'operative').map(a => a.playerId),
      },
    },
    spectators: teamMembers(s, 'spectator'),
    me: { playerId, team: me.team, role: me.role, isHost: s.hostId === playerId, isTraitor },
    turn: s.turn ? { team: s.turn.team, word: s.turn.word, count: s.turn.count, used: s.turn.used, picks: [...s.turn.picks] } : null,
    history: s.history.map(h => ({ ...h, picks: [...h.picks] })),
    turnCount: s.turnCount,
    deadline: s.deadline, paused: s.pausedRemaining !== null,
    endReason: s.endReason, winner: s.winner,
    canStart: s.phase === 'draft' && s.hostId === playerId && !startBlockReason(s),
    startBlockReason: s.phase === 'draft' ? startBlockReason(s) : null,
    legalActions: legalActions(s, playerId),
    lastEvent: s.lastEvent,
  };
  if (s.phase === 'finished') {
    return {
      ...base,
      boardRoles: [...s.board.roles],
      traitors: { red: s.traitors.red, blue: s.traitors.blue },
    };
  }
  if (inGame && me.role === 'spymaster') return { ...base, key: [...s.board.roles] };
  if (inGame && isTraitor) {
    const enemyTeam = other(me.team as Team);
    return { ...base, intel: s.board.roles.map(r => r === 'assassin' || r === enemyTeam ? r : null) };
  }
  return base;
}

const systemSchema = z.object({ type: z.enum(['timeout', 'pause', 'resume', 'recover']) }).strict();
export function systemAction(s: CodenamesState, now: number, online: boolean, recovering = false) {
  if (s.phase === 'finished' || s.phase === 'draft') return null;
  if (recovering) return { type: 'recover' };
  if (!s.timed || s.deadline === null) return null;
  if (s.pausedRemaining === null && !online) return { type: 'pause' };
  if (s.pausedRemaining !== null && online) return { type: 'resume' };
  return s.pausedRemaining === null && now >= s.deadline ? { type: 'timeout' } : null;
}
export function applySystem(s: CodenamesState, raw: unknown, now: number): CodenamesState {
  const action = systemSchema.parse(raw);
  if (s.phase === 'finished' || s.phase === 'draft') throw new Error('No system action in this phase');
  const next = copy(s);
  if (action.type === 'recover') {
    if (next.deadline !== null) next.deadline = Math.max(next.deadline, now + phaseSeconds(next) * 1000);
    next.lastEvent = 'resume';
    assertInvariants(next);
    return next;
  }
  if (action.type === 'pause') {
    if (next.pausedRemaining !== null || next.deadline === null) throw new Error('Already paused');
    next.pausedRemaining = Math.max(0, next.deadline - now);
    next.lastEvent = 'pause';
    assertInvariants(next);
    return next;
  }
  if (action.type === 'resume') {
    if (next.pausedRemaining === null || next.deadline === null) throw new Error('Not paused');
    next.deadline = now + next.pausedRemaining;
    next.pausedRemaining = null;
    next.lastEvent = 'resume';
    assertInvariants(next);
    return next;
  }
  if (!next.timed || next.deadline === null || next.pausedRemaining !== null || now < next.deadline) throw new Error('Timer not due');
  return closeTurn(next, 'timeout', now);
}

export function assertInvariants(s: CodenamesState): void {
  const { words, roles, revealed } = s.board;
  if (words.length !== 25 || roles.length !== 25 || revealed.length !== 25) throw new Error('Board must have 25 cards');
  if (new Set(words).size !== 25 || words.some(w => typeof w !== 'string' || !w)) throw new Error('Board words must be unique');
  const counts: Record<CardRole, number> = { red: 0, blue: 0, neutral: 0, assassin: 0 };
  roles.forEach(r => counts[r]++);
  if (counts.assassin !== 1 || counts.neutral !== 7) throw new Error('Invalid board composition');
  if (counts[s.starter] !== 9 || counts[other(s.starter)] !== 8) throw new Error('Invalid team card counts');
  if (s.assignments.length !== s.players.length || new Set(s.assignments.map(a => a.playerId)).size !== s.players.length) throw new Error('Invalid assignments');
  if (!s.assignments.every(a => s.players.includes(a.playerId))) throw new Error('Assignment for unknown player');
  for (const team of ['red', 'blue'] as const) {
    if (s.assignments.filter(a => a.team === team && a.role === 'spymaster').length > 1) throw new Error('Two spymasters in one team');
  }
  if (s.phase === 'finished') {
    if (!s.endReason || !s.winner) throw new Error('Finished without result');
  } else if (s.phase === 'guess') {
    if (!s.turn || s.turn.team !== s.currentTeam) throw new Error('Guess phase without active turn');
  } else if (s.phase === 'hint') {
    if (s.turn !== null) throw new Error('Hint phase with active turn');
  }
  if (s.pausedRemaining !== null && s.deadline === null) throw new Error('Paused without deadline');
  if (s.phase !== 'draft' && s.phase !== 'finished') {
    for (const team of ['red', 'blue'] as const) {
      if (s.assignments.filter(a => a.team === team && a.role === 'spymaster').length !== 1) throw new Error('Team without spymaster after start');
    }
  }
}
