import { describe, expect, it } from 'vitest';
import { createState, transition, invalidReason, playerView, result, assertInvariants, applySystem, legalView, TURN_MS, CHALLENGE_MS } from '../engine';
import type { UnoState, UnoAction } from '../engine';
import { cardColor, cardPoints, COLORS } from '../engine/cards';
import { unoModule } from '../server/module';
import { ctx, fixture, num, action, WILD, DRAW4 } from './engine.test';

const play = (s: UnoState, seat: number, a: UnoAction, now = 5000) => transition(s, a, s.players[seat]!, now);
const timeout = (s: UnoState, now: number) => applySystem({ ...s, deadline: Math.min(s.deadline, now) }, { type: 'timeout' }, now + 1);

/** Fully controlled state: `hands` are exact, `opts.deck`/`opts.discard`/`opts.out`
 * must partition the remaining card ids or assertInvariants fails. */
function rawState(hands: number[][], opts: Partial<UnoState> = {}): UnoState {
  const used = new Set(hands.flat());
  const rest = Array.from({ length: 108 }, (_, i) => i).filter(c => !used.has(c));
  const top = opts.discard?.at(-1) ?? rest[0]!;
  const deckPool = rest.filter(c => c !== top);
  const s: UnoState = {
    players: hands.map((_, i) => 'p' + i), mode: 'points', target: 500,
    hands: hands.map(h => [...h]), deck: deckPool, discard: [top], out: [],
    currentColor: cardColor(top) ?? 'red', direction: 1, actor: 0,
    phase: 'turn', pendingDraw: null, awaiting: null, challenge: null,
    deadline: 1e12, pausedRemaining: null,
    scores: hands.map(() => 0), round: 1, roundWinner: -1, roundPoints: 0,
    seed: 7, shuffles: 5,
    uno: hands.map(h => h.length === 1 ? { card: h[0]!, ok: false } : null),
    forfeited: [], lastEvent: 'deal',
    ...opts,
  };
  assertInvariants(s);
  return s;
}

/** Cards not held and not used as discard/out — helper for exhaustion tests. */
function leftover(hands: number[][], reserved: number[]): number[] {
  const used = new Set([...hands.flat(), ...reserved]);
  return Array.from({ length: 108 }, (_, i) => i).filter(c => !used.has(c));
}

describe('wild draw four challenge edge cases', () => {
  /** p0 holds DRAW4 + `rest`; current color red. p1 is next (challenger), p2 waits. */
  function draw4State(p0Rest: number[], players = 3) {
    const hands: number[][] = [[DRAW4, ...p0Rest]];
    while (hands.length < players) hands.push([num(1, hands.length), num(2, hands.length)]);
    return fixture(hands, { topCard: num(0, 5), currentColor: 'red' });
  }

  it('challenge is rejected exactly at the deadline boundary', () => {
    let s = draw4State([num(1, 9)]);
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' }, 100);
    expect(s.deadline).toBe(100 + CHALLENGE_MS);
    expect(invalidReason(s, { type: 'challenge' }, 'p1', s.deadline - 1)).toBeNull();
    expect(invalidReason(s, { type: 'challenge' }, 'p1', s.deadline)).toMatch(/истекло/);
  });

  it('successful challenge gives the challenger their turn (official rules)', () => {
    // p0 still holds a red card → +4 was illegal → challenge succeeds.
    let s = draw4State([num(0, 3)]);
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.hands[0]).toHaveLength(5); // 1 remaining + 4 penalty
    expect(s.hands[1]).toHaveLength(2);  // challenger untouched
    expect(s.actor).toBe(1);             // challenger plays, not skipped
    expect(s.phase).toBe('turn');
    assertInvariants(s);
  });

  it('failed challenge: challenger draws 6 and loses the turn', () => {
    let s = draw4State([num(1, 9)]);
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.hands[1]).toHaveLength(8); // 2 + 6
    expect(s.actor).toBe(2);            // player after the challenger
  });

  it('last-card +4 unchallenged: attacker wins after the window, victim penalty counts', () => {
    let s = fixture([[DRAW4], [num(1, 2), num(1, 3), action(2, 'skip')], [num(3, 4), WILD]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    expect(s.phase).toBe('challenge');
    expect(s.hands[0]).toHaveLength(0); // round must NOT end during the window
    const resolved = applySystem({ ...s, deadline: 1 }, { type: 'timeout' }, CHALLENGE_MS + 2);
    expect(resolved.phase).toBe('roundEnd');
    expect(resolved.roundWinner).toBe(0);
    // p1: 2+3+20+4 drawn cards... verify points come from actual hands
    expect(resolved.roundPoints).toBe(resolved.hands[1]!.reduce((a, c) => a + cardPoints(c), 0) + resolved.hands[2]!.reduce((a, c) => a + cardPoints(c), 0));
  });

  it('last-card +4 challenged: challenge always fails (empty hand has no match) and attacker still wins', () => {
    let s = fixture([[DRAW4], [num(1, 2), num(1, 3)], [num(3, 4), num(2, 5)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.hands[1]).toHaveLength(8); // challenger drew 6
    expect(s.phase).toBe('roundEnd');
    expect(s.roundWinner).toBe(0);
  });

  it('a +4 drawn after "draw" can open a challenge window too', () => {
    // pendingDraw forces the drawn card to be the only playable one.
    let s = fixture([[DRAW4, num(0, 8)], [num(1, 2), num(1, 3)], [num(2, 1), num(3, 1)]], { topCard: num(0, 5), currentColor: 'red' });
    s = { ...s, pendingDraw: DRAW4 };
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'green' });
    expect(s.phase).toBe('challenge');
    expect(s.challenge).toMatchObject({ bySeat: 0 });
  });

  it('nobody can challenge when the attacker is the only active seat', () => {
    // 2 players; challenger p1 forfeits mid-window → p0 must not self-challenge.
    let s = fixture([[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'surrender' }, 'p1', 5000);
    expect(s.phase).toBe('challenge');
    expect(s.forfeited).toEqual([1]);
    expect(invalidReason(s, { type: 'challenge' }, 'p0', 5000)).toMatch(/следующий игрок/);
    expect(legalView(s, 'p0').canChallenge).toBe(false);
    expect(playerView(s, 'p0').challenge!.iAmChallenger).toBe(false);
    const resolved = timeout(s, 20000);
    expect(resolved.phase).not.toBe('challenge');
    assertInvariants(resolved);
  });

  it('third player forfeit mid-window keeps the window and the real challenger', () => {
    let s = fixture([[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)], [num(1, 1), num(2, 2)], [num(3, 1), num(2, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'surrender' }, 'p2', 5000);
    expect(s.phase).toBe('challenge');
    expect(s.forfeited).toEqual([2]);
    expect(invalidReason(s, { type: 'challenge' }, 'p1', 5000)).toBeNull();
    expect(invalidReason(s, { type: 'challenge' }, 'p3', 5000)).toMatch(/следующий игрок/);
  });

  it('attacker forfeit mid-window resolves as unchallenged: next active draws 4', () => {
    let s = fixture([[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)], [num(1, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'surrender' }, 'p0', 5000);
    expect(s.forfeited).toEqual([0]);
    expect(s.phase).toBe('turn');
    expect(s.hands[1]!.length).toBe(6); // victim drew 4
    expect(s.actor).toBe(2);            // play continues after the victim
    assertInvariants(s);
  });
});

describe('round ending on special cards', () => {
  it('wild as last card without inline color: round ends only after color choice', () => {
    let s = fixture([[WILD], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: WILD });
    expect(s.phase).toBe('color');
    expect(s.hands[0]).toHaveLength(0);
    s = transition(s, { type: 'chooseColor', color: 'blue' }, 'p0', 5000);
    expect(s.phase).toBe('roundEnd');
    expect(s.roundWinner).toBe(0);
    expect(s.roundPoints).toBe(5); // p1 holds blue 2 + blue 3
  });

  it('wild as last card with inline color ends the round immediately', () => {
    let s = fixture([[WILD], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: WILD, color: 'green' });
    expect(s.phase).toBe('roundEnd');
    expect(s.currentColor).toBe('green');
  });

  it('skip as last card ends the round after jumping seats', () => {
    let s = fixture([[action(0, 'skip')], [num(1, 2)], [num(2, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'skip') });
    expect(s.phase).toBe('roundEnd');
    expect(s.roundWinner).toBe(0);
  });

  it('reverse as last card in a 2-player game acts as skip then ends', () => {
    let s = fixture([[action(0, 'reverse')], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'reverse') });
    expect(s.phase).toBe('roundEnd');
    expect(s.direction).toBe(1);
  });
});

describe('deck exhaustion and reshuffle', () => {
  it('reshuffles the discard (minus top) when the deck runs out mid-draw', () => {
    const hands = [[num(0, 1)], [num(1, 2), num(1, 3)]];
    const extra = leftover(hands, [num(0, 5), num(0, 6), num(0, 7)]);
    // deck empty; discard = top + 3 reshufflable cards; everything else in `out`.
    const s = rawState(hands, {
      deck: [], discard: [num(0, 6), num(0, 7), extra[0]!, num(0, 5)],
      out: extra.slice(1), currentColor: 'red',
    });
    const next = play(s, 0, { type: 'draw' });
    expect(next.phase).toBe('turn');
    expect(next.pendingDraw).not.toBeNull();
    // conservation: the reshuffled cards went to deck/hand, top stayed on discard.
    expect(next.discard).toEqual([num(0, 5)]);
    const all = [...next.deck, ...next.discard, ...next.out, ...next.hands.flat()];
    expect(new Set(all).size).toBe(108);
  });

  it('penalty draw larger than the remaining pool takes what exists and survives', () => {
    const hands = [[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)]];
    const extra = leftover(hands, [num(0, 5), num(0, 6)]);
    const s = rawState(hands, {
      deck: [], discard: [num(0, 6), num(0, 5)], out: extra,
      currentColor: 'red', phase: 'challenge', challenge: { bySeat: 0, hadMatch: false },
    });
    const resolved = applySystem({ ...s, deadline: 1 }, { type: 'timeout' }, CHALLENGE_MS + 2);
    // Only 1 reshufflable card existed (discard minus top) — victim gets fewer than 4.
    expect(resolved.hands[1]!.length).toBe(3); // 2 + 1
    assertInvariants(resolved);
  });

  it('redeal with a pool smaller than a full deal produces short hands, not corruption', () => {
    const hands = [[num(0, 1)], [num(1, 2)]];
    const top = num(0, 5);
    const pool = leftover(hands, [top]);
    const s = rawState(hands, {
      deck: pool.slice(0, 4), discard: [top], out: pool.slice(4),
      currentColor: 'red', phase: 'roundEnd', actor: -1, roundWinner: 0,
    });
    const next = transition(s, { type: 'nextRound' }, 'p1', 6000);
    expect(next.round).toBe(2);
    expect(next.phase).toBe('turn');
    expect(next.discard).toHaveLength(1);
    expect(next.hands[0]!.length).toBeLessThan(7);
    expect(next.hands[1]!.length).toBeLessThan(7);
    assertInvariants(next);
    const all = [...next.deck, ...next.discard, ...next.out, ...next.hands.flat()];
    expect(new Set(all).size).toBe(108);
  });

  it('redeal still deals 7 each and reshuffles everything when the pool is healthy', () => {
    const s = fixture([[num(0, 7)], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red', mode: 'points' });
    let t = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(t.phase).toBe('roundEnd');
    t = transition(t, { type: 'nextRound' }, 'p0', 6000);
    expect(t.hands.every(h => h.length === 7)).toBe(true);
    assertInvariants(t);
  });
});

describe('timeouts in every phase', () => {
  it('turn timeout with exhausted draw pile just passes', () => {
    const hands = [[num(0, 1), num(0, 7)], [num(1, 2)]];
    const extra = leftover(hands, [num(0, 5)]);
    const s = rawState(hands, { deck: [], discard: [num(0, 5)], out: extra, currentColor: 'red', deadline: 100 });
    const next = applySystem(s, { type: 'timeout' }, 200);
    expect(next.actor).toBe(1);
    expect(next.phase).toBe('turn');
  });

  it('color timeout on a Wild Draw Four opens the challenge window, not a turn', () => {
    let s = fixture([[DRAW4, num(0, 3), num(0, 4)], [num(1, 1), num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', deadline: 100 });
    s = play(s, 0, { type: 'play', card: DRAW4 }, 50);
    expect(s.phase).toBe('color');
    const next = applySystem(s, { type: 'timeout' }, 40000);
    expect(next.phase).toBe('challenge');
    expect(next.deadline).toBe(40000 + CHALLENGE_MS);
    expect(next.currentColor).toBe('red'); // most frequent color left in hand
  });

  it('roundEnd timeout auto-starts the next round', () => {
    let s = fixture([[num(0, 7)], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red', mode: 'points' });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.phase).toBe('roundEnd');
    const next = timeout(s, s.deadline + 1);
    expect(next.round).toBe(2);
    expect(next.phase).toBe('turn');
    expect(next.scores[0]).toBe(s.roundPoints);
  });

  it('recover grants a phase-appropriate deadline (challenge stays short)', () => {
    let s = fixture([[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)], [num(2, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' }, 1000);
    const now = 2000;
    const recovered = applySystem(s, { type: 'recover' }, now);
    expect(recovered.phase).toBe('challenge');
    expect(recovered.deadline).toBeLessThanOrEqual(now + CHALLENGE_MS);
    // turn phase keeps the full turn window
    const turnState = fixture([[num(0, 1)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', deadline: 500 });
    const r2 = applySystem(turnState, { type: 'recover' }, 1000);
    expect(r2.deadline).toBe(1000 + TURN_MS);
  });

  it('pause/resume preserves the challenge window remaining time', () => {
    let s = fixture([[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)], [num(2, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red', deadline: 100 });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' }, 50);
    const paused = applySystem(s, { type: 'pause' }, 60);
    expect(paused.pausedRemaining).toBe(s.deadline - 60);
    const resumed = applySystem(paused, { type: 'resume' }, 5000);
    expect(resumed.deadline).toBe(5000 + (s.deadline - 60));
    expect(resumed.phase).toBe('challenge');
  });
});

describe('surrender edge cases', () => {
  it('surrender during color phase auto-picks a color and passes the turn', () => {
    let s = fixture([[WILD, num(1, 4)], [num(1, 2), num(2, 3)], [num(3, 1), num(2, 4)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: WILD });
    expect(s.phase).toBe('color');
    s = transition(s, { type: 'surrender' }, 'p0', 5000);
    expect(s.forfeited).toEqual([0]);
    expect(s.phase).toBe('turn');
    expect(s.actor).toBe(1);
    expect(COLORS.includes(s.currentColor)).toBe(true);
    assertInvariants(s);
  });

  it('forfeited players cannot act, be caught, or start rounds', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)], [num(2, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = transition(s, { type: 'surrender' }, 'p0', 5000);
    expect(invalidReason(s, { type: 'play', card: num(0, 7) }, 'p0', 5000)).toMatch(/сдались/);
    expect(invalidReason(s, { type: 'catchUno', target: 'p0' }, 'p1', 5000)).not.toBeNull();
    expect(legalView(s, 'p0').canSurrender).toBe(false);
  });

  it('last two players surrendering during roundEnd finishes the match', () => {
    let s = fixture([[num(0, 7)], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red', mode: 'points' });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.phase).toBe('roundEnd');
    s = transition(s, { type: 'surrender' }, 'p0', 6000);
    expect(s.phase).toBe('roundEnd');
    s = transition(s, { type: 'surrender' }, 'p1', 6001);
    expect(s.phase).toBe('finished');
    expect(result(s)).toEqual({ winners: [], losers: ['p0', 'p1'], draw: true });
  });

  it('surrender during turn by a non-actor simply removes their seat', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)], [num(2, 3), num(2, 4)]], { topCard: num(0, 5), currentColor: 'red', actor: 0 });
    s = transition(s, { type: 'surrender' }, 'p2', 5000);
    expect(s.forfeited).toEqual([2]);
    expect(s.actor).toBe(0); // turn unchanged
    expect(s.phase).toBe('turn');
    // When p0 passes, the turn must skip the forfeited seat and land on p1.
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.actor).toBe(1);
  });
});

describe('player-count edge cases', () => {
  it('2-player skip returns the turn to the skipper (opponent is skipped)', () => {
    let s = fixture([[action(0, 'skip'), num(0, 8)], [num(1, 1), num(1, 5)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'skip') });
    expect(s.actor).toBe(0);
    expect(s.phase).toBe('turn');
  });

  it('2-player draw2: victim draws 2 and the attacker continues', () => {
    let s = fixture([[action(0, 'draw2'), num(0, 8)], [num(1, 1), num(1, 5)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'draw2') });
    expect(s.hands[1]).toHaveLength(4);
    expect(s.actor).toBe(0);
  });

  it('skip honours direction -1 and skips forfeited seats', () => {
    let s = fixture([[action(0, 'skip'), num(0, 8)], [num(1, 1), num(1, 5)], [num(2, 1), num(2, 5)]], { topCard: num(0, 5), currentColor: 'red', direction: -1 });
    s.actor = 0;
    s = play(s, 0, { type: 'play', card: action(0, 'skip') });
    // direction -1, skip 2 seats back from 0 → seat 1 (0 → 2 → 1)
    expect(s.actor).toBe(1);
  });

  it('10-player game deals and plays normally', () => {
    const s = createState({ mode: 'quick', maxPlayers: 10 }, ctx(10, 7));
    expect(s.hands.every(h => h.length === 7)).toBe(true);
    assertInvariants(s);
    const view = playerView(s, 'p0');
    expect(view.players).toHaveLength(10);
  });

  it('forfeits reduce the active rotation without breaking skip distances', () => {
    let s = fixture(
      [[action(0, 'skip'), num(0, 8)], [num(1, 1), num(1, 5)], [num(2, 1), num(2, 5)], [num(3, 1), num(3, 5)]],
      { topCard: num(0, 5), currentColor: 'red' },
    );
    s = transition(s, { type: 'surrender' }, 'p1', 4000);
    s = play(s, 0, { type: 'play', card: action(0, 'skip') });
    expect(s.forfeited).toEqual([1]);
    expect(s.actor).toBe(3); // skip jumps two ACTIVE seats: 0 → 2 → 3
  });
});

describe('UNO call/catch edge cases', () => {
  it('callUno is accepted during the color phase (late declaration)', () => {
    let s = fixture([[WILD, num(0, 3)], [num(1, 2), num(2, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: WILD });
    expect(s.phase).toBe('color');
    expect(s.uno[0]).toEqual({ card: num(0, 3), ok: false });
    s = transition(s, { type: 'callUno' }, 'p0', 5000);
    expect(s.uno[0]!.ok).toBe(true);
    expect(invalidReason(s, { type: 'catchUno', target: 'p0' }, 'p1', 5000)).toMatch(/объявил/);
  });

  it('catching is allowed during the challenge phase', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [DRAW4, num(1, 9)], [num(2, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: num(0, 7) }); // p0 down to 1, owes UNO
    expect(s.uno[0]!.ok).toBe(false);
    s = play(s, 1, { type: 'play', card: DRAW4, color: 'blue' });
    expect(s.phase).toBe('challenge');
    const before = s.hands[0]!.length;
    s = transition(s, { type: 'catchUno', target: 'p0' }, 'p2', 5000);
    expect(s.hands[0]!.length).toBe(before + 2);
    expect(s.uno[0]).toBeNull();
  });

  it('a player who draws back above one card can no longer be caught', () => {
    // p0 has a single non-matching card and must draw; the draw clears the UNO debt.
    let s = fixture([[num(1, 7)], [num(0, 1), num(0, 2)]], { topCard: num(0, 5), currentColor: 'red', actor: 0 });
    expect(s.uno[0]).toEqual({ card: num(1, 7), ok: false });
    s = play(s, 0, { type: 'draw' });
    expect(s.hands[0]!.length).toBe(2);
    expect(s.uno[0]).toBeNull();
    expect(invalidReason(s, { type: 'catchUno', target: 'p0' }, 'p1', 5000)).toMatch(/одной картой/);
  });

  it('cannot catch yourself', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.uno[0]!.ok).toBe(false);
    expect(invalidReason(s, { type: 'catchUno', target: 'p0' }, 'p0', 5000)).toMatch(/этого игрока/);
  });
});

describe('scoring and result edge cases', () => {
  it('target reached exactly ends the match', () => {
    // scores preset so this round lands exactly on target.
    let s = fixture([[num(0, 7)], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red', target: 100, scores: [95, 10] });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    // p1 hand = 2+3 = 5 points → p0 reaches exactly 100.
    expect(s.scores[0]).toBe(100);
    expect(s.phase).toBe('finished');
    expect(result(s)!.winners).toEqual(['p0']);
  });

  it('result() declares a draw when eligible players tie on score', () => {
    const s = fixture([[num(0, 1)], [num(1, 2)]], {
      topCard: num(0, 5), currentColor: 'red', mode: 'points',
      phase: 'finished', actor: -1, scores: [100, 100],
    });
    expect(result(s)).toEqual({ winners: ['p0', 'p1'], losers: [], draw: true });
  });

  it('forfeited players are excluded from winners even with the best score', () => {
    const gone = num(1, 2);
    const s = rawState([[num(0, 1)], []], {
      discard: [num(0, 5)],
      deck: leftover([[num(0, 1)], []], [num(0, 5), gone]), out: [gone],
      currentColor: 'red', mode: 'points', phase: 'finished', actor: -1,
      scores: [100, 50], forfeited: [1],
    });
    expect(result(s)!.winners).toEqual(['p0']);
  });

  it('all players forfeited yields a draw result', () => {
    const gone = [num(0, 1), num(1, 2)];
    const s = rawState([[], []], {
      discard: [num(0, 5)],
      deck: leftover([[], []], [num(0, 5), ...gone]), out: gone,
      currentColor: 'red', mode: 'quick', phase: 'finished', actor: -1,
      forfeited: [0, 1],
    });
    expect(result(s)).toEqual({ winners: [], losers: ['p0', 'p1'], draw: true });
  });
});

describe('serialization round-trips', () => {
  const cases: Array<[string, () => UnoState]> = [
    ['turn with pendingDraw', () => {
      const s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
      return play(s, 0, { type: 'draw' });
    }],
    ['color phase', () => {
      const s = fixture([[WILD, num(1, 4)], [num(2, 1)]], { topCard: num(0, 5), currentColor: 'red' });
      return play(s, 0, { type: 'play', card: WILD });
    }],
    ['draw4 challenge phase', () => {
      const s = fixture([[DRAW4, num(1, 9)], [num(1, 8), num(3, 4)], [num(2, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red' });
      return play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    }],
    ['roundEnd', () => {
      const s = fixture([[num(0, 7)], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red' });
      return play(s, 0, { type: 'play', card: num(0, 7) });
    }],
    ['finished', () => {
      const s = fixture([[num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', mode: 'quick' });
      return play(s, 0, { type: 'play', card: num(0, 7) });
    }],
    ['paused mid-turn', () => {
      const s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', deadline: 60000 });
      return applySystem(s, { type: 'pause' }, 5000);
    }],
  ];
  it.each(cases)('serialize/restore round-trips %s', (_name, build) => {
    const s = build();
    const restored = unoModule.restore(unoModule.serialize(s));
    expect(restored).toEqual(s);
    assertInvariants(restored);
  });
});
