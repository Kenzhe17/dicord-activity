import { z } from 'zod';
import type { GameContext, GameResult } from '@rize/platform-core';
import { mafiaSettingsSchema, mafiaPaceSchema, MAFIA_PACE } from '../server/definition';
import type { MafiaPace } from '../server/definition';

export const roleSchema = z.enum(['mafia', 'town', 'sheriff', 'doctor']);
export type MafiaRole = z.infer<typeof roleSchema>;

const seatIndex = z.number().int().min(0).max(11);
const nullableSeat = seatIndex.nullable();
export const chatChannelSchema = z.enum(['town', 'mafia', 'dead']);
export type MafiaChatChannel = z.infer<typeof chatChannelSchema>;

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('nightKill'), target: seatIndex }).strict(),
  z.object({ type: z.literal('sheriffCheck'), target: seatIndex }).strict(),
  z.object({ type: z.literal('doctorHeal'), target: seatIndex }).strict(),
  z.object({ type: z.literal('vote'), target: z.union([seatIndex, z.literal('skip')]) }).strict(),
  z.object({ type: z.literal('chat'), channel: chatChannelSchema, text: z.string().trim().min(1).max(300) }).strict(),
  z.object({ type: z.literal('forfeit') }).strict(),
]);
export type MafiaAction = z.infer<typeof actionSchema>;

const feedItemSchema = z.object({
  seq: z.number().int().positive(), day: z.number().int().nonnegative(),
  text: z.string().max(300), kind: z.enum(['info', 'death', 'vote', 'system']),
});
const chatMessageSchema = z.object({
  id: z.number().int().positive(), channel: chatChannelSchema,
  seat: z.number().int().min(0).max(11), text: z.string().max(300), at: z.number().nonnegative(),
});
const sheriffResultSchema = z.object({ target: seatIndex, isMafia: z.boolean(), night: z.number().int().positive() });
const seatStatsSchema = z.object({
  heals: z.number().int().nonnegative(), saves: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(), checksCorrect: z.number().int().nonnegative(),
  voteKills: z.number().int().nonnegative(),
});
const lastNightSchema = z.object({ victim: nullableSeat, saved: z.boolean() });

export const stateSchema = z.object({
  players: z.array(z.string()).min(6).max(12),
  roles: z.array(roleSchema),
  alive: z.array(z.boolean()),
  forfeited: z.array(z.number().int()),
  day: z.number().int().nonnegative(),
  night: z.number().int().nonnegative(),
  phase: z.enum(['reveal', 'night', 'dawn', 'discussion', 'voting', 'runoff', 'finished']),
  deadline: z.number().finite().nonnegative(),
  pace: mafiaPaceSchema,
  rng: z.number().int().nonnegative(),
  deadThisCycle: z.boolean(),
  quietCycles: z.number().int().nonnegative(),
  nightKill: z.array(nullableSeat),
  sheriffCheck: z.array(nullableSeat),
  doctorHeal: z.array(nullableSeat),
  doctorHealTarget: z.array(nullableSeat),
  doctorHealNight: z.array(z.number().int().nonnegative()),
  votes: z.array(z.union([seatIndex, z.literal('skip')]).nullable()),
  runoff: z.array(seatIndex).nullable(),
  sheriffResults: z.array(sheriffResultSchema.nullable()),
  feed: z.array(feedItemSchema).max(80),
  chat: z.array(chatMessageSchema).max(240),
  chatAt: z.array(z.number().nonnegative()),
  stats: z.array(seatStatsSchema),
  lastNight: lastNightSchema.nullable(),
  winner: z.enum(['town', 'mafia', 'draw']).nullable(),
  seq: z.number().int().nonnegative(),
});
export type MafiaState = z.infer<typeof stateSchema>;
export type MafiaFeedItem = z.infer<typeof feedItemSchema>;
export type MafiaChatMessage = z.infer<typeof chatMessageSchema>;
export type MafiaSeatStats = z.infer<typeof seatStatsSchema>;
export type MafiaView = ReturnType<typeof playerView>;

const CHAT_MIN_INTERVAL = 1000;
const FEED_LIMIT = 60;
const CHAT_LIMIT = 200;
const CHAT_DAY_PHASES = new Set<MafiaState['phase']>(['reveal', 'dawn', 'discussion', 'voting', 'runoff']);

/** Deterministic mulberry32 step. All randomness flows through the stored rng state. */
function nextRandom(state: number): { value: number; next: number } {
  const next = (state + 0x6D2B79F5) >>> 0;
  let r = next;
  r = Math.imul(r ^ (r >>> 15), r | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return { value: ((r ^ (r >>> 14)) >>> 0) / 4294967296, next };
}

/** Mafia seats per player count (6..12), sheriff and doctor are always 1 each. */
export function mafiaCount(players: number): number {
  if (players < 6 || players > 12) throw new Error('Invalid player count');
  return players <= 7 ? 1 : players <= 10 ? 2 : 3;
}

function roleDeck(count: number): MafiaRole[] {
  const mafia = mafiaCount(count);
  return [...Array.from({ length: mafia }, () => 'mafia' as const), 'sheriff' as const, 'doctor' as const,
    ...Array.from({ length: count - mafia - 2 }, () => 'town' as const)];
}

function blankSeatFields(count: number) {
  return {
    nightKill: Array.from({ length: count }, () => null),
    sheriffCheck: Array.from({ length: count }, () => null),
    doctorHeal: Array.from({ length: count }, () => null),
    votes: Array.from({ length: count }, () => null),
  };
}

function seatStats(): MafiaSeatStats {
  return { heals: 0, saves: 0, checks: 0, checksCorrect: 0, voteKills: 0 };
}

export function createState(raw: unknown, context: GameContext): MafiaState {
  const settings = mafiaSettingsSchema.parse(raw);
  const pace: MafiaPace = settings.pace;
  const n = context.players.length;
  if (n < 6 || n > 12 || new Set(context.players).size !== n) throw new Error('Invalid player count');
  let rng = context.seed >>> 0;
  const deck = roleDeck(n);
  for (let i = deck.length - 1; i > 0; i--) {
    const draw = nextRandom(rng); rng = draw.next;
    const j = Math.floor(draw.value * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  const durations = MAFIA_PACE[pace];
  const state: MafiaState = {
    players: [...context.players], roles: deck, alive: Array.from({ length: n }, () => true),
    forfeited: [], day: 0, night: 0, phase: 'reveal',
    deadline: context.startedAt + durations.reveal * 1000, pace, rng,
    deadThisCycle: false, quietCycles: 0,
    ...blankSeatFields(n),
    doctorHealTarget: Array.from({ length: n }, () => null),
    doctorHealNight: Array.from({ length: n }, () => 0),
    runoff: null, sheriffResults: Array.from({ length: n }, () => null),
    feed: [], chat: [], chatAt: Array.from({ length: n }, () => 0),
    stats: Array.from({ length: n }, seatStats),
    lastNight: null, winner: null, seq: 1,
  };
  pushFeed(state, 'system', 'Партия началась. Роли розданы — закройте глаза до рассвета.', 0);
  assertInvariants(state);
  return state;
}

function pushFeed(s: MafiaState, kind: MafiaFeedItem['kind'], text: string, day: number): void {
  s.feed.push({ seq: s.seq++, day, text, kind });
  if (s.feed.length > FEED_LIMIT) s.feed.splice(0, s.feed.length - FEED_LIMIT);
}

function name(s: MafiaState, seat: number): string { return s.players[seat] ?? '?'; }

function aliveSeats(s: MafiaState): number[] {
  return s.players.map((_, i) => i).filter(i => s.alive[i]);
}

function isMafiaSeat(s: MafiaState, seat: number): boolean { return s.roles[seat] === 'mafia'; }

function aliveMafia(s: MafiaState): number[] { return aliveSeats(s).filter(i => isMafiaSeat(s, i)); }

/** Town wins when no mafia remains; mafia wins at numeric parity with the rest. */
function checkWinner(s: MafiaState): 'town' | 'mafia' | null {
  const mafia = aliveMafia(s).length;
  const total = aliveSeats(s).length;
  if (mafia === 0) return 'town';
  if (mafia * 2 >= total) return 'mafia';
  return null;
}

function finish(s: MafiaState, winner: 'town' | 'mafia' | 'draw'): MafiaState {
  s.phase = 'finished';
  s.deadline = 0;
  s.winner = winner;
  pushFeed(s, 'system', winner === 'town' ? 'Город победил: мафия обезврежена.' : winner === 'mafia' ? 'Мафия победила: город не смог её вычислить.' : 'Три тихих цикла без потерь — ничья.', s.day);
  return s;
}

function copy(s: MafiaState): MafiaState {
  return {
    ...s, players: [...s.players], roles: [...s.roles], alive: [...s.alive], forfeited: [...s.forfeited],
    nightKill: [...s.nightKill], sheriffCheck: [...s.sheriffCheck], doctorHeal: [...s.doctorHeal],
    doctorHealTarget: [...s.doctorHealTarget], doctorHealNight: [...s.doctorHealNight],
    votes: [...s.votes], runoff: s.runoff ? [...s.runoff] : null,
    sheriffResults: s.sheriffResults.map(r => r ? { ...r } : null),
    feed: s.feed.map(f => ({ ...f })), chat: s.chat.map(m => ({ ...m })), chatAt: [...s.chatAt],
    stats: s.stats.map(st => ({ ...st })), lastNight: s.lastNight ? { ...s.lastNight } : null,
  };
}

function validNightTarget(s: MafiaState, target: number | null | undefined): target is number {
  return typeof target === 'number' && target >= 0 && target < s.players.length && s.alive[target]! && !isMafiaSeat(s, target);
}

function healStillAllowed(s: MafiaState, seat: number, target: number): boolean {
  return !(s.doctorHealTarget[seat] === target && s.doctorHealNight[seat] === s.night - 1);
}

export function invalidReason(s: MafiaState, raw: MafiaAction, actorId: string, now: number): string | null {
  if (!Number.isFinite(now) || now < 0) return 'Некорректное время';
  if (s.phase === 'finished') return 'Партия завершена';
  const seat = s.players.indexOf(actorId);
  if (seat < 0) return 'Вы не участник партии';
  if (s.forfeited.includes(seat)) {
    if (raw.type === 'chat' && raw.channel === 'dead') {
      // выбывшие сохраняют доступ к своему чату
    } else if (raw.type === 'forfeit') return 'Вы уже покинули партию';
    else return 'Вы покинули партию';
  }
  const alive = s.alive[seat]!;
  const role = s.roles[seat]!;
  switch (raw.type) {
    case 'nightKill': {
      if (s.phase !== 'night') return 'Ночное действие недоступно';
      if (!alive) return 'Выбывшие не действуют ночью';
      if (role !== 'mafia') return 'Это действие доступно только мафии';
      return validNightTarget(s, raw.target) ? null : 'Недопустимая цель';
    }
    case 'sheriffCheck': {
      if (s.phase !== 'night') return 'Ночное действие недоступно';
      if (!alive) return 'Выбывшие не действуют ночью';
      if (role !== 'sheriff') return 'Проверка доступна только комиссару';
      const t = raw.target;
      return t >= 0 && t < s.players.length && s.alive[t]! && t !== seat ? null : 'Недопустимая цель проверки';
    }
    case 'doctorHeal': {
      if (s.phase !== 'night') return 'Ночное действие недоступно';
      if (!alive) return 'Выбывшие не действуют ночью';
      if (role !== 'doctor') return 'Лечение доступно только доктору';
      const t = raw.target;
      if (!(t >= 0 && t < s.players.length && s.alive[t]!)) return 'Недопустимая цель лечения';
      return healStillAllowed(s, seat, t) ? null : 'Нельзя лечить одного игрока две ночи подряд';
    }
    case 'vote': {
      if (!alive) return 'Выбывшие не голосуют';
      if (s.phase === 'voting') {
        if (raw.target === 'skip') return null;
        return raw.target >= 0 && raw.target < s.players.length && s.alive[raw.target]! && raw.target !== seat ? null : 'Недопустимый кандидат';
      }
      if (s.phase === 'runoff') {
        if (raw.target === 'skip') return null;
        return typeof raw.target === 'number' && raw.target !== seat && (s.runoff?.includes(raw.target) ?? false) ? null : 'В повторном голосовании участвуют только равные кандидаты';
      }
      return 'Голосование сейчас не проводится';
    }
    case 'chat': {
      const channel = raw.channel;
      const cooldown = s.chatAt[seat]! > 0 && now - s.chatAt[seat]! < CHAT_MIN_INTERVAL ? 'Слишком часто' : null;
      if (cooldown) return cooldown;
      if (channel === 'dead') return alive && !s.forfeited.includes(seat) ? 'Чат выбывших доступен только после выхода из игры' : null;
      if (!alive || s.forfeited.includes(seat)) return 'Выбывшие не пишут в общий чат';
      if (channel === 'town') return CHAT_DAY_PHASES.has(s.phase) ? null : 'Общий чат доступен днём';
      // mafia channel
      return s.phase === 'night' && role === 'mafia' ? null : 'Секретный чат доступен только мафии ночью';
    }
    case 'forfeit':
      return s.forfeited.includes(seat) ? 'Вы уже покинули партию' : null;
  }
}

export function transition(s: MafiaState, raw: MafiaAction, actorId: string, now: number): MafiaState {
  const reason = invalidReason(s, raw, actorId, now);
  if (reason) throw new Error(reason);
  const next = copy(s);
  const seat = next.players.indexOf(actorId);
  switch (raw.type) {
    case 'nightKill': next.nightKill[seat] = raw.target; break;
    case 'sheriffCheck': next.sheriffCheck[seat] = raw.target; break;
    case 'doctorHeal': next.doctorHeal[seat] = raw.target; break;
    case 'vote': next.votes[seat] = raw.target; break;
    case 'chat': {
      if (next.chatAt[seat]! > 0 && now - next.chatAt[seat]! < CHAT_MIN_INTERVAL) throw new Error('Слишком часто');
      next.chatAt[seat] = now;
      next.chat.push({ id: ++next.seq, channel: raw.channel, seat, text: raw.text, at: now });
      if (next.chat.length > CHAT_LIMIT) next.chat.splice(0, next.chat.length - CHAT_LIMIT);
      break;
    }
    case 'forfeit': {
      const wasAlive = next.alive[seat]!;
      next.alive[seat] = false;
      next.forfeited.push(seat);
      next.deadThisCycle = true;
      if (wasAlive) pushFeed(next, 'death', name(next, seat) + ' покинул(а) партию.', next.day);
      const winner = checkWinner(next);
      if (winner) finish(next, winner);
      break;
    }
  }
  assertInvariants(next);
  return next;
}

type PaceDurations = (typeof MAFIA_PACE)[MafiaPace];
function beginNight(s: MafiaState, now: number, durations: PaceDurations): MafiaState {
  s.night += 1;
  s.deadThisCycle = false;
  s.phase = 'night';
  s.deadline = now + durations.night * 1000;
  s.nightKill = Array.from({ length: s.players.length }, () => null);
  s.sheriffCheck = Array.from({ length: s.players.length }, () => null);
  s.doctorHeal = Array.from({ length: s.players.length }, () => null);
  pushFeed(s, 'system', 'Город засыпает. Ночь ' + s.night + ' — роли скрыты, говорите только в игре.', s.day);
  return s;
}

function beginDiscussion(s: MafiaState, now: number): MafiaState {
  s.day += 1;
  s.phase = 'discussion';
  s.deadline = now + MAFIA_PACE[s.pace].discussion * 1000;
  pushFeed(s, 'system', 'Город просыпается. День ' + s.day + ' — обсуждение.', s.day);
  return s;
}

function beginVoting(s: MafiaState, now: number): MafiaState {
  s.phase = 'voting';
  s.runoff = null;
  s.votes = Array.from({ length: s.players.length }, () => null);
  s.deadline = now + MAFIA_PACE[s.pace].vote * 1000;
  pushFeed(s, 'system', 'Время голосования.', s.day);
  return s;
}

function resolveNight(s: MafiaState, now: number): MafiaState {
  const n = s.players.length;
  // Mafia ballot: every living mafioso casts one vote; ties resolve randomly.
  const tally = new Map<number, number>();
  for (let seat = 0; seat < n; seat++) {
    if (!s.alive[seat] || !isMafiaSeat(s, seat)) continue;
    const target = s.nightKill[seat];
    if (validNightTarget(s, target)) tally.set(target, (tally.get(target) ?? 0) + 1);
  }
  let victim: number | null = null;
  if (tally.size) {
    let best = 0;
    for (const count of tally.values()) best = Math.max(best, count);
    const tied = [...tally.entries()].filter(([, c]) => c === best).map(([t]) => t).sort((a, b) => a - b);
    const draw = nextRandom(s.rng); s.rng = draw.next;
    victim = tied[Math.min(tied.length - 1, Math.floor(draw.value * tied.length))]!;
  }
  // Doctor: single living doctor, last submitted heal wins.
  let doctorSeat = -1;
  for (let seat = 0; seat < n; seat++) if (s.alive[seat] && s.roles[seat] === 'doctor') { doctorSeat = seat; break; }
  let healTarget: number | null = null;
  if (doctorSeat >= 0) {
    const target = s.doctorHeal[doctorSeat];
    if (typeof target === 'number' && target >= 0 && target < n && s.alive[target] && healStillAllowed(s, doctorSeat, target)) healTarget = target;
  }
  const saved = victim !== null && healTarget === victim;
  if (doctorSeat >= 0 && healTarget !== null) {
    s.stats[doctorSeat]!.heals += 1;
    if (saved) s.stats[doctorSeat]!.saves += 1;
    s.doctorHealTarget[doctorSeat] = healTarget;
    s.doctorHealNight[doctorSeat] = s.night;
  }
  // Sheriff: private results, recorded for the checking sheriff only.
  for (let seat = 0; seat < n; seat++) {
    if (!s.alive[seat] || s.roles[seat] !== 'sheriff') continue;
    const target = s.sheriffCheck[seat];
    if (typeof target !== 'number' || target < 0 || target >= n || !s.alive[target] || target === seat) continue;
    const isMafia = isMafiaSeat(s, target);
    s.sheriffResults[seat] = { target, isMafia, night: s.night };
    s.stats[seat]!.checks += 1;
    if (isMafia) s.stats[seat]!.checksCorrect += 1;
  }
  if (victim !== null && !saved) {
    s.alive[victim] = false;
    s.deadThisCycle = true;
    s.lastNight = { victim, saved: false };
    pushFeed(s, 'death', 'Ночью погиб(ла) ' + name(s, victim) + '.', s.day);
  } else {
    s.lastNight = { victim: null, saved };
    pushFeed(s, 'info', 'Город проснулся: ночью никто не погиб.', s.day);
  }
  const winner = checkWinner(s);
  if (winner) return finish(s, winner);
  s.phase = 'dawn';
  s.deadline = now + MAFIA_PACE[s.pace].dawn * 1000;
  return s;
}

function tallyVotes(s: MafiaState, allowed: ReadonlySet<number> | null): { skips: number; counts: Map<number, number> } {
  let skipCount = 0;
  const counts = new Map<number, number>();
  for (let seat = 0; seat < s.players.length; seat++) {
    if (!s.alive[seat]) continue;
    const vote = s.votes[seat];
    if (vote === null || vote === undefined || vote === 'skip') { if (vote === 'skip') skipCount++; continue; }
    if (allowed && !allowed.has(vote)) continue;
    if (!s.alive[vote] || vote === seat) continue;
    counts.set(vote, (counts.get(vote) ?? 0) + 1);
  }
  return { skips: skipCount, counts };
}

function nextNightOrFinish(s: MafiaState, now: number): MafiaState {
  const winner = checkWinner(s);
  if (winner) return finish(s, winner);
  return beginNight(s, now, MAFIA_PACE[s.pace]);
}

function resolveVote(s: MafiaState, now: number, isRunoff: boolean): MafiaState {
  const allowed = isRunoff && s.runoff ? new Set(s.runoff) : null;
  const { skips, counts } = tallyVotes(s, allowed);
  let topCount = 0;
  for (const count of counts.values()) topCount = Math.max(topCount, count);
  const tied = [...counts.entries()].filter(([, c]) => c === topCount).map(([t]) => t).sort((a, b) => a - b);
  const durations = MAFIA_PACE[s.pace];
  // A runoff only makes sense when exclusion is still on the table.
  if (topCount > skips && tied.length > 1 && !isRunoff) {
    s.phase = 'runoff';
    s.runoff = tied;
    s.votes = Array.from({ length: s.players.length }, () => null);
    s.deadline = now + durations.runoff * 1000;
    pushFeed(s, 'vote', 'Равное голосование. Повторное голосование: ' + tied.map(t => name(s, t)).join(', ') + '.', s.day);
    return s;
  }
  if (topCount > skips && tied.length === 1) {
    const target = tied[0]!;
    s.alive[target] = false;
    s.deadThisCycle = true;
    if (isMafiaSeat(s, target)) {
      for (let seat = 0; seat < s.players.length; seat++) {
        if (s.alive[seat] && s.votes[seat] === target) s.stats[seat]!.voteKills += 1;
      }
    }
    pushFeed(s, 'vote', name(s, target) + ' исключён(а) из города.', s.day);
  } else {
    pushFeed(s, 'vote', 'Голосование не дало результата — никто не исключён.', s.day);
  }
  s.runoff = null;
  // End of a full day/night cycle: three quiet cycles in a row end in a draw.
  if (s.deadThisCycle) s.quietCycles = 0; else s.quietCycles += 1;
  if (s.quietCycles >= 3) return finish(s, 'draw');
  return nextNightOrFinish(s, now);
}

function advancePhase(s: MafiaState, now: number): MafiaState {
  const durations = MAFIA_PACE[s.pace];
  switch (s.phase) {
    case 'reveal': return beginNight(s, now, durations);
    case 'night': return resolveNight(s, now);
    case 'dawn': return beginDiscussion(s, now);
    case 'discussion': return beginVoting(s, now);
    case 'voting': return resolveVote(s, now, false);
    case 'runoff': return resolveVote(s, now, true);
    case 'finished': return s;
  }
}

const systemSchema = z.object({ type: z.enum(['advance', 'recover']) }).strict();
export function systemAction(s: MafiaState, now: number, online: boolean) {
  void online; // Mafia timers always run: absent players simply miss their actions.
  if (s.phase === 'finished') return null;
  return now >= s.deadline ? { type: 'advance' } : null;
}
export function applySystem(s: MafiaState, raw: unknown, now: number): MafiaState {
  const action = systemSchema.parse(raw);
  if (s.phase === 'finished') throw new Error('Finished game');
  if (action.type === 'recover') return { ...copy(s), deadline: Math.max(s.deadline, now + 30000) };
  if (now < s.deadline) throw new Error('Timer not due');
  const next = copy(s);
  return advancePhase(next, now);
}

const DAY_CHAT_PHASES = new Set<MafiaState['phase']>(['reveal', 'dawn', 'discussion', 'voting', 'runoff']);

export function playerView(s: MafiaState, playerId: string) {
  const seat = s.players.indexOf(playerId);
  if (seat < 0) throw new Error('Not a participant');
  const alive = s.alive[seat]!;
  const role = s.roles[seat]!;
  const isMafia = role === 'mafia';
  const dead = !alive || s.forfeited.includes(seat);
  const chat: Record<MafiaChatChannel, MafiaChatMessage[]> = { town: [], mafia: [], dead: [] };
  for (const message of s.chat) {
    if (message.channel === 'town') { if (alive && !s.forfeited.includes(seat)) chat.town.push({ ...message }); }
    else if (message.channel === 'mafia') { if (isMafia && alive && s.phase === 'night') chat.mafia.push({ ...message }); }
    else if (dead) chat.dead.push({ ...message });
  }
  const poll = s.phase === 'voting' || s.phase === 'runoff' ? (() => {
    const counts = new Map<string, number>();
    let skips = 0;
    for (let i = 0; i < s.players.length; i++) {
      if (!s.alive[i]) continue;
      const vote = s.votes[i];
      if (vote === null) continue;
      if (vote === 'skip') skips++; else counts.set(String(vote), (counts.get(String(vote)) ?? 0) + 1);
    }
    return { skips, counts: Object.fromEntries(counts) };
  })() : null;
  return {
    phase: s.phase, day: s.day, night: s.night, deadline: s.deadline, pace: s.pace,
    players: s.players.map((id, i) => ({
      seat: i, id, alive: s.alive[i]!, out: !s.alive[i]!,
      // Roles stay hidden until the end; mafiosi additionally see their own team.
      role: s.phase === 'finished' ? s.roles[i]! : isMafia && isMafiaSeat(s, i) ? 'mafia' as const : null,
    })),
    you: {
      seat, role: {
        kind: role,
        ...(isMafia ? { allies: s.players.map((_, i) => i).filter(i => i !== seat && isMafiaSeat(s, i) && s.alive[i]) } : {}),
      },
      alive, forfeited: s.forfeited.includes(seat),
      sheriffResult: role === 'sheriff' ? s.sheriffResults[seat] ?? null : null,
      nightAction: { kill: s.nightKill[seat] ?? null, check: s.sheriffCheck[seat] ?? null, heal: s.doctorHeal[seat] ?? null },
      vote: s.votes[seat] ?? null,
      abilities: {
        canNightKill: role === 'mafia' && alive && s.phase === 'night',
        canSheriffCheck: role === 'sheriff' && alive && s.phase === 'night',
        canDoctorHeal: role === 'doctor' && alive && s.phase === 'night',
        canVote: alive && (s.phase === 'voting' || s.phase === 'runoff'),
        canChatTown: alive && !s.forfeited.includes(seat) && DAY_CHAT_PHASES.has(s.phase),
        canChatMafia: isMafia && alive && s.phase === 'night',
        canChatDead: dead,
        canForfeit: !s.forfeited.includes(seat),
      },
    },
    runoff: s.runoff,
    poll,
    // `saved` stays server-side: publicly we only learn whether someone died.
    lastNight: s.lastNight ? { victim: s.lastNight.victim } : null,
    feed: s.feed.slice(-FEED_LIMIT).map(f => ({ ...f })),
    chat,
    winner: s.winner,
    stats: s.phase === 'finished' ? s.stats.map((st, i) => ({ seat: i, ...st })) : null,
  };
}

export function result(s: MafiaState): GameResult | null {
  if (s.phase !== 'finished' || !s.winner) return null;
  if (s.winner === 'draw') return { winners: [], losers: [], draw: true };
  // Winners are team-based: every player of the winning side, dead or alive.
  const winningTeam = s.winner === 'mafia' ? (i: number) => isMafiaSeat(s, i) : (i: number) => !isMafiaSeat(s, i);
  const winIds = s.players.filter((_, i) => winningTeam(i));
  const loseIds = s.players.filter((_, i) => !winningTeam(i));
  return { winners: winIds, losers: loseIds, draw: false };
}

export function assertInvariants(s: MafiaState): void {
  const n = s.players.length;
  if (n < 6 || n > 12 || new Set(s.players).size !== n) throw new Error('Invalid seats');
  if (s.roles.length !== n || s.alive.length !== n) throw new Error('Invalid role/alive length');
  const expectedMafia = mafiaCount(n);
  if (s.roles.filter(r => r === 'mafia').length !== expectedMafia || s.roles.filter(r => r === 'sheriff').length !== 1 || s.roles.filter(r => r === 'doctor').length !== 1) throw new Error('Invalid role mix');
  for (const list of [s.nightKill, s.sheriffCheck, s.doctorHeal, s.votes, s.sheriffResults, s.chatAt, s.stats, s.doctorHealTarget, s.doctorHealNight]) {
    if (list.length !== n) throw new Error('Invalid seat field length');
  }
  if (new Set(s.forfeited).size !== s.forfeited.length || s.forfeited.some(i => i < 0 || i >= n)) throw new Error('Invalid forfeited seats');
  if (s.forfeited.some(i => s.alive[i])) throw new Error('Forfeited seat still alive');
  if (s.runoff && (s.runoff.length < 2 || s.runoff.some(i => i < 0 || i >= n))) throw new Error('Invalid runoff');
  if (s.phase === 'finished' && !s.winner) throw new Error('Finished without winner');
  if (s.phase !== 'finished' && s.winner) throw new Error('Winner before finish');
  if (s.chat.length > CHAT_LIMIT || s.feed.length > FEED_LIMIT) throw new Error('Log overflow');
}
