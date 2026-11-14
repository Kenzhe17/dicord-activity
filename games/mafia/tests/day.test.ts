import { describe, expect, it } from 'vitest';
import { transition, playerView, result, assertInvariants, actionSchema } from '../engine';
import {
  makeState, toNight, toPhase, toVoting, seatsWith, seatWith, vote, skipAllVotes, aliveSeats, advance,
} from './fixture';
import type { MafiaState } from '../engine';

const P = (s: MafiaState, seat: number) => s.players[seat]!;

describe('voting', () => {
  it('a unique top above skips excludes the target and feeds the result', () => {
    let s = toVoting(makeState(6, 12));
    const target = seatsWith(s, 'town')[0]!;
    const skip = new Set([target, seatsWith(s, 'town')[1]!]);
    for (let i = 0; i < 6; i++) s = vote(s, i, skip.has(i) ? 'skip' : target);
    s = advance(s);
    expect(s.phase).toBe('night');
    expect(s.alive[target]).toBe(false);
    expect(s.deadThisCycle).toBe(false); // beginNight resets the cycle flag
    const item = [...s.feed].reverse().find(f => f.kind === 'vote')!; // night banner is pushed after it
    expect(item.text).toContain('исключён');
    expect(item.text).toContain(P(s, target));
    assertInvariants(s);
  });

  it('voters who elected a mafia seat earn voteKills stats (hidden until finish)', () => {
    let s = toVoting(makeState(8, 13));
    const mafias = seatsWith(s, 'mafia');
    const target = mafias[0]!;
    const otherMafia = mafias[1]!;
    const voters: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (i === target || i === otherMafia) s = vote(s, i, 'skip');
      else { s = vote(s, i, target); voters.push(i); }
    }
    s = advance(s);
    expect(s.phase).toBe('night'); // one mafia remains, game continues
    expect(s.alive[target]).toBe(false);
    for (const i of voters) expect(s.stats[i]!.voteKills).toBe(1);
    expect(s.stats[otherMafia]!.voteKills).toBe(0);
    expect(s.stats[target]!.voteKills).toBe(0);
    expect(playerView(s, P(s, 0)).stats).toBeNull();
  });

  it.each([2, 3])('top count %i not exceeding skips excludes nobody', voteCount => {
    let s = toVoting(makeState(6, 14));
    const target = 4; // never a voter, so no self-votes
    for (let i = 0; i < 6; i++) s = vote(s, i, i < voteCount ? target : 'skip');
    s = advance(s);
    expect(s.phase).toBe('night');
    expect(s.alive.every(Boolean)).toBe(true);
    expect(s.quietCycles).toBe(1);
    const item = [...s.feed].reverse().find(f => f.kind === 'vote')!;
    expect(item.text).toContain('не дало результата');
  });

  it('a tie triggers a runoff limited to the tied candidates; a second tie excludes nobody', () => {
    let s = toVoting(makeState(6, 15));
    // Candidates seats 0 and 1; three votes each, respecting the no-self rule.
    const split = (cur: MafiaState) => {
      let next = cur;
      for (const voter of [1, 2, 3]) next = vote(next, voter, 0);
      for (const voter of [0, 4, 5]) next = vote(next, voter, 1);
      return next;
    };
    s = advance(split(s));
    expect(s.phase).toBe('runoff');
    expect(s.runoff).toEqual([0, 1]);
    expect(s.feed.at(-1)!.text).toContain('Равное голосование');
    expect(playerView(s, P(s, 0)).runoff).toEqual([0, 1]);
    // Only the tied candidates are votable in the runoff.
    expect(() => vote(s, 2, 2)).toThrow('равные кандидаты');
    expect(() => vote(s, 2, 3)).toThrow('равные кандидаты');
    s = advance(split(s));
    expect(s.phase).toBe('night');
    expect(s.alive.every(Boolean)).toBe(true);
    expect(s.quietCycles).toBe(1);
  });

  it('runoff with a unique top still excludes that candidate', () => {
    let s = toVoting(makeState(6, 15));
    // Candidates are town seats so exclusion cannot end the game early.
    const [a, b] = seatsWith(s, 'town');
    const others = [0, 1, 2, 3, 4, 5].filter(i => i !== a && i !== b);
    // 3-3 split: a gets {b, o0, o1}; b gets {a, o2, o3}.
    const split = (cur: MafiaState) => {
      let next = cur;
      for (const voter of [b!, others[0]!, others[1]!]) next = vote(next, voter, a!);
      for (const voter of [a!, others[2]!, others[3]!]) next = vote(next, voter, b!);
      return next;
    };
    s = advance(split(s));
    expect(s.phase).toBe('runoff');
    expect(s.runoff).toEqual([Math.min(a!, b!), Math.max(a!, b!)]);
    // In the runoff everyone piles onto seat a (a itself skips).
    for (let i = 0; i < 6; i++) s = vote(s, i, i === a ? 'skip' : a!);
    s = advance(s);
    expect(s.phase).toBe('night');
    expect(s.alive[a!]).toBe(false);
    expect(s.alive[b!]).toBe(true);
  });

  it('no votes at all excludes nobody', () => {
    let s = toVoting(makeState(6, 16));
    s = advance(s);
    expect(s.phase).toBe('night');
    expect(s.alive.every(Boolean)).toBe(true);
    expect(s.quietCycles).toBe(1);
  });

  it('enforces vote ACL: dead, self, dead targets, forfeited and wrong phase', () => {
    // Dead player cannot vote.
    let s = makeState(6, 17);
    s = toNight(s);
    const m = seatWith(s, 'mafia');
    const victim = seatsWith(s, 'town')[0]!;
    s = transition(s, { type: 'nightKill', target: victim }, P(s, m), s.deadline);
    s = advance(s); // dawn
    s = toVoting(s);
    expect(() => vote(s, victim, 'skip')).toThrow('не голосуют');
    // Alive players: no self-vote, no voting for the dead.
    const alive = aliveSeats(s);
    const a1 = alive.find(i => i !== victim)!;
    expect(() => vote(s, a1, a1)).toThrow('Недопустимый кандидат');
    expect(() => vote(s, a1, victim)).toThrow('Недопустимый кандидат');
    // Changing a vote: the last one wins.
    let s2 = vote(s, a1, alive.find(i => i !== a1 && i !== victim)!);
    const finalTarget = alive.find(i => i !== a1 && i !== victim && i !== s2.votes[a1])!;
    s2 = vote(s2, a1, finalTarget);
    expect(s2.votes[a1]).toBe(finalTarget);
    // Votes outside voting/runoff are rejected.
    const d = toPhase(makeState(6, 18), 'discussion');
    expect(() => vote(d, 0, 'skip')).toThrow('не проводится');
    const n = toNight(makeState(6, 19));
    expect(() => vote(n, 0, 'skip')).toThrow('не проводится');
    // A forfeited player cannot vote even though the engine still tracks the seat.
    let f = toVoting(makeState(6, 20));
    f = transition(f, { type: 'forfeit' }, P(f, 0), f.deadline);
    expect(() => vote(f, 0, 'skip')).toThrow('покинули');
  });
});

describe('draw', () => {
  it('three consecutive quiet cycles (no deaths, no exclusions) end in a draw', () => {
    let s = toNight(makeState(6, 21));
    for (let cycle = 0; cycle < 3; cycle++) {
      s = advance(s); // night -> dawn, nobody died
      expect(s.phase).toBe('dawn');
      s = advance(s); // dawn -> discussion
      s = advance(s); // discussion -> voting
      s = skipAllVotes(s);
      s = advance(s); // voting resolves -> next night or finished
      if (cycle < 2) expect(s.phase).toBe('night');
    }
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('draw');
    expect(s.quietCycles).toBe(3);
    expect(result(s)).toEqual({ winners: [], losers: [], draw: true });
    assertInvariants(s);
  });

  it('a single death resets the quiet-cycle counter', () => {
    let s = toNight(makeState(6, 22));
    // Cycle 1: mafia kills someone -> quietCycles stays 0.
    const m = seatWith(s, 'mafia');
    const victim = seatsWith(s, 'town')[0]!;
    s = transition(s, { type: 'nightKill', target: victim }, P(s, m), s.deadline);
    s = advance(s);
    s = advance(s);
    s = advance(s); // -> voting
    s = skipAllVotes(s);
    s = advance(s); // -> night 2, quietCycles 0 because someone died
    expect(s.phase).toBe('night');
    expect(s.quietCycles).toBe(0);
  });
});

describe('chat', () => {
  it('town chat works in day phases for alive players and is channel-filtered per view', () => {
    let s = toPhase(makeState(6, 23), 'discussion');
    const townSeat = seatsWith(s, 'town')[0]!;
    s = transition(s, { type: 'chat', channel: 'town', text: 'hello town' }, P(s, townSeat), 1000);
    const view = playerView(s, P(s, townSeat));
    expect(view.chat.town).toHaveLength(1);
    expect(view.chat.town[0]!.text).toBe('hello town');
    expect(view.chat.mafia).toHaveLength(0);
    expect(view.chat.dead).toHaveLength(0);
    const other = aliveSeats(s).find(i => i !== townSeat)!;
    expect(playerView(s, P(s, other)).chat.town).toHaveLength(1);
  });

  it('mafia chat is night-only and mafia-only, and hidden again at dawn', () => {
    let s = toNight(makeState(8, 24));
    const [m1] = seatsWith(s, 'mafia');
    const sheriff = seatWith(s, 'sheriff');
    const town = seatsWith(s, 'town')[0]!;
    s = transition(s, { type: 'chat', channel: 'mafia', text: 'сходка' }, P(s, m1!), 21000);
    expect(playerView(s, P(s, m1!)).chat.mafia).toHaveLength(1);
    expect(playerView(s, P(s, sheriff)).chat.mafia).toHaveLength(0);
    expect(playerView(s, P(s, town)).chat.mafia).toHaveLength(0);
    expect(() => transition(s, { type: 'chat', channel: 'mafia', text: 'x' }, P(s, town), 21000)).toThrow('только мафии ночью');
    expect(() => transition(s, { type: 'chat', channel: 'town', text: 'x' }, P(s, town), 21000)).toThrow('днём');
    const dawn = advance(s); // night -> dawn
    expect(playerView(dawn, P(s, m1!)).chat.mafia).toHaveLength(0);
    const discussion = advance(dawn); // dawn -> discussion
    expect(() => transition(discussion, { type: 'chat', channel: 'mafia', text: 'x' }, P(s, m1!), discussion.deadline)).toThrow('только мафии ночью');
    // Mafiosi can still use the public town chat during the day.
    const ok = transition(discussion, { type: 'chat', channel: 'town', text: 'день' }, P(s, m1!), discussion.deadline);
    expect(playerView(ok, P(s, town)).chat.town.at(-1)!.text).toBe('день');
  });

  it('dead chat is restricted to eliminated/forfeited players and filtered from the living', () => {
    let s = makeState(6, 25);
    s = toNight(s);
    const m = seatWith(s, 'mafia');
    const victim = seatsWith(s, 'town')[0]!;
    const aliveSeat = aliveSeats(s).find(i => i !== victim)!;
    s = transition(s, { type: 'nightKill', target: victim }, P(s, m), s.deadline);
    s = advance(s);
    s = toPhase(s, 'discussion');
    s = transition(s, { type: 'chat', channel: 'dead', text: 'спокойной ночи' }, P(s, victim), 5000);
    expect(() => transition(s, { type: 'chat', channel: 'dead', text: 'x' }, P(s, aliveSeat), 5000)).toThrow('только после выхода');
    // The cooldown is checked before channel ACL, so move past the 1s window.
    expect(() => transition(s, { type: 'chat', channel: 'town', text: 'x' }, P(s, victim), 6000)).toThrow('общий чат');
    expect(() => transition(s, { type: 'chat', channel: 'mafia', text: 'x' }, P(s, victim), 6000)).toThrow();
    const deadView = playerView(s, P(s, victim));
    expect(deadView.chat.dead).toHaveLength(1);
    expect(deadView.chat.town).toHaveLength(0);
    expect(deadView.chat.mafia).toHaveLength(0);
    expect(deadView.you.alive).toBe(false);
    expect(playerView(s, P(s, aliveSeat)).chat.dead).toHaveLength(0);
  });

  it('enforces the 1s per-player chat cooldown', () => {
    let s = toPhase(makeState(6, 26), 'discussion');
    const id = P(s, 0);
    const other = P(s, 1);
    s = transition(s, { type: 'chat', channel: 'town', text: 'a' }, id, 1000);
    expect(() => transition(s, { type: 'chat', channel: 'town', text: 'b' }, id, 1999)).toThrow('Слишком часто');
    s = transition(s, { type: 'chat', channel: 'town', text: 'b' }, id, 2000); // exactly 1s later: allowed
    expect(s.chat.filter(m => m.seat === 0)).toHaveLength(2);
    // Cooldown is per player.
    s = transition(s, { type: 'chat', channel: 'town', text: 'c' }, other, 1500);
    expect(s.chat.filter(m => m.seat === 1)).toHaveLength(1);
  });

  it('forfeited players keep only the dead chat channel', () => {
    let s = toPhase(makeState(6, 27), 'discussion');
    const seat = seatsWith(s, 'town')[0]!;
    const id = P(s, seat);
    s = transition(s, { type: 'forfeit' }, id, s.deadline);
    const view = playerView(s, id);
    expect(view.you.abilities.canChatDead).toBe(true);
    expect(view.you.abilities.canChatTown).toBe(false);
    expect(() => transition(s, { type: 'chat', channel: 'town', text: 'x' }, id, s.deadline)).toThrow('покинули');
    expect(() => transition(s, { type: 'chat', channel: 'mafia', text: 'x' }, id, s.deadline)).toThrow('покинули');
    expect(() => transition(s, { type: 'vote', target: 'skip' }, id, s.deadline)).toThrow('покинули');
    const next = transition(s, { type: 'chat', channel: 'dead', text: 'bye' }, id, s.deadline);
    expect(next.chat.at(-1)).toMatchObject({ channel: 'dead', seat, text: 'bye' });
    expect(() => transition(next, { type: 'forfeit' }, id, s.deadline)).toThrow('уже покинули');
    expect(view.you.forfeited).toBe(true);
  });

  it('chat schema enforces the 300-char limit and non-empty text', () => {
    expect(actionSchema.safeParse({ type: 'chat', channel: 'town', text: 'x'.repeat(300) }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'chat', channel: 'town', text: 'x'.repeat(301) }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'chat', channel: 'town', text: '   ' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'chat', channel: 'town', text: '' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'chat', channel: 'sideways', text: 'hi' }).success).toBe(false);
  });
});

describe('forfeit', () => {
  it('an alive player forfeits: marked dead, announced once, cannot repeat or rejoin chat', () => {
    let s = toPhase(makeState(6, 28), 'discussion');
    const seat = seatsWith(s, 'town')[0]!;
    const id = P(s, seat);
    const feedBefore = s.feed.length;
    s = transition(s, { type: 'forfeit' }, id, s.deadline);
    expect(s.alive[seat]).toBe(false);
    expect(s.forfeited).toContain(seat);
    expect(s.feed.length).toBe(feedBefore + 1);
    expect(s.feed.at(-1)!.kind).toBe('death');
    expect(s.feed.at(-1)!.text).toContain(id);
    const view = playerView(s, id);
    expect(view.you.forfeited).toBe(true);
    expect(view.you.alive).toBe(false);
    expect(view.players[seat]!.out).toBe(true);
    // The forfeited-seat guard fires before the forfeit case's own message.
    expect(() => transition(s, { type: 'forfeit' }, id, s.deadline)).toThrow('покинули');
    expect(() => transition(s, { type: 'forfeit' }, 'ghost', s.deadline)).toThrow('не участник');
    assertInvariants(s);
  });

  it('a dead player can forfeit to leave without a second death announcement', () => {
    let s = toNight(makeState(6, 29));
    const m = seatWith(s, 'mafia');
    const victim = seatsWith(s, 'town')[0]!;
    s = transition(s, { type: 'nightKill', target: victim }, P(s, m), s.deadline);
    s = advance(s); // dawn
    const feedBefore = s.feed.length;
    s = transition(s, { type: 'forfeit' }, P(s, victim), s.deadline);
    expect(s.forfeited).toContain(victim);
    expect(s.feed.length).toBe(feedBefore); // wasAlive=false: no new feed item
    expect(s.alive[victim]).toBe(false);
    assertInvariants(s);
  });

  it('assertInvariants rejects a forfeited seat still marked alive', () => {
    const s = makeState(6, 30);
    expect(() => assertInvariants({ ...s, forfeited: [0] })).toThrow('Forfeited');
    const fixed = { ...s, forfeited: [0], alive: [...s.alive] };
    fixed.alive[0] = false;
    expect(() => assertInvariants(fixed)).not.toThrow();
    expect(() => assertInvariants({ ...s, winner: 'town' })).toThrow('Winner before finish');
    expect(() => assertInvariants({ ...s, phase: 'finished' })).toThrow('Finished without winner');
  });
});
