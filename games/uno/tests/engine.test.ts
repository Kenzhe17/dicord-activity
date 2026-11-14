import { describe, expect, it } from 'vitest';
import { createState, transition, invalidReason, playerView, result, assertInvariants, applySystem, CHALLENGE_MS } from '../engine';
import type { UnoState, UnoAction } from '../engine';
import { COLORS, cardColor, cardInfo, cardPoints, isPlayable, shuffled } from '../engine/cards';
import { unoModule } from '../server/module';

export const ctx = (n: number, seed = 42, startedAt = 1000) => ({ players: Array.from({ length: n }, (_, i) => 'p' + i), seed, startedAt });

/** Build a deterministic mid-game state: `hands` are exact card ids, the
 * remaining ids fill the deck (shuffled) and one chosen `top` starts the
 * discard. */
export function fixture(hands: number[][], options: Partial<UnoState> & { topCard?: number } = {}): UnoState {
  const n = hands.length;
  const used = new Set(hands.flat());
  const rest = Array.from({ length: 108 }, (_, i) => i).filter(c => !used.has(c));
  const { topCard: topOption, ...restOptions } = options;
  const top = topOption ?? rest[0]!;
  const deck = shuffled(7, 3).filter(c => rest.includes(c) && c !== top);
  const s: UnoState = {
    players: hands.map((_, i) => 'p' + i), mode: 'points', target: 500,
    hands: hands.map(h => [...h]), deck, discard: [top], out: [],
    currentColor: cardColor(top) ?? 'red', direction: 1, actor: 0,
    phase: 'turn', pendingDraw: null, awaiting: null, challenge: null,
    deadline: 1e12, pausedRemaining: null,
    scores: Array.from({ length: n }, () => 0), round: 1, roundWinner: -1, roundPoints: 0,
    seed: 7, shuffles: 5, uno: hands.map(h => h.length === 1 ? { card: h[0]!, ok: false } : null), forfeited: [], lastEvent: 'deal',
    ...restOptions,
  };
  assertInvariants(s);
  return s;
}

// Card id helpers: red=0..24, blue=25..49, green=50..74, yellow=75..99; wild 100+, draw4 104+.
export const num = (color: number, rank: number) => color * 25 + (rank === 0 ? 0 : (rank - 1) * 2 + 1);
export const action = (color: number, kind: 'skip' | 'reverse' | 'draw2', copy = 0) => color * 25 + 19 + ['skip', 'reverse', 'draw2'].indexOf(kind) * 2 + copy;
export const WILD = 100, DRAW4 = 104;
const play = (s: UnoState, seat: number, a: UnoAction, now = 5000) => transition(s, a, s.players[seat]!, now);

describe('UNO deck and deal', () => {
  it.each([2, 3, 4, 6, 10])('deals 7 unique cards to %i players with full conservation', n => {
    const s = createState({}, ctx(n, 99));
    expect(s.hands.every(h => h.length === 7)).toBe(true);
    assertInvariants(s);
    const all = [...s.hands.flat(), ...s.deck, ...s.discard];
    expect(all.length).toBe(108);
    expect(new Set(all).size).toBe(108);
    expect(s.discard).toHaveLength(1);
    expect(cardInfo(s.discard[0]!).rank).not.toBe('draw4');
  });
  it('knows every card: 25 per color plus 8 wilds', () => {
    const counts = new Map<string, number>();
    for (let id = 0; id < 108; id++) {
      const info = cardInfo(id);
      const key = info.color ? info.color + ':' + info.rank : 'wild:' + info.rank;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const color of COLORS) {
      expect(counts.get(color + ':0')).toBe(1);
      for (let r = 1; r <= 9; r++) expect(counts.get(color + ':' + r)).toBe(2);
      for (const k of ['skip', 'reverse', 'draw2']) expect(counts.get(color + ':' + k)).toBe(2);
    }
    expect(counts.get('wild:wild')).toBe(4);
    expect(counts.get('wild:draw4')).toBe(4);
    expect(counts.size).toBe(4 * 13 + 2);
  });
  it('scores cards: numbers face value, actions 20, wilds 50', () => {
    expect(cardPoints(num(0, 7))).toBe(7);
    expect(cardPoints(num(0, 0))).toBe(0);
    expect(cardPoints(action(0, 'skip'))).toBe(20);
    expect(cardPoints(action(2, 'draw2'))).toBe(20);
    expect(cardPoints(WILD)).toBe(50);
    expect(cardPoints(DRAW4)).toBe(50);
  });
});

describe('playability', () => {
  it('matches color, number and action type; wilds always play', () => {
    const top = num(0, 5); // red 5
    expect(isPlayable(num(0, 9), top, 'red')).toBe(true);   // same color
    expect(isPlayable(num(2, 5), top, 'red')).toBe(true);   // same number
    expect(isPlayable(num(1, 4), top, 'red')).toBe(false);  // blue 4: wrong color and rank
    expect(isPlayable(action(2, 'skip'), action(0, 'skip'), 'red')).toBe(true); // same action type
    expect(isPlayable(action(2, 'reverse'), action(0, 'skip'), 'red')).toBe(false);
    expect(isPlayable(WILD, top, 'red')).toBe(true);
    expect(isPlayable(DRAW4, top, 'red')).toBe(true);
  });
  it('rejects wrong actor, missing card and illegal card immutably', () => {
    const s = fixture([[num(0, 1), num(1, 2)], [num(2, 3)]]);
    const before = JSON.stringify(s);
    expect(invalidReason(s, { type: 'play', card: num(0, 1) }, 'p1', 5000)).toMatch(/другого игрока/);
    expect(invalidReason(s, { type: 'play', card: num(3, 4) }, 'p0', 5000)).toMatch(/руке/);
    // top card color is whatever rest[0] is — force a known top:
    const t = fixture([[num(0, 1), num(2, 4)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    expect(invalidReason(t, { type: 'play', card: num(2, 4) }, 'p0', 5000)).toMatch(/не совпадает/);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('turn flow', () => {
  it('plays a matching card, discards it and passes the turn', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2), num(2, 3)]], { topCard: num(0, 5) });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.discard.at(-1)).toBe(num(0, 7));
    expect(s.hands[0]).toEqual([num(0, 1)]);
    expect(s.actor).toBe(1);
    expect(s.uno[0]).toEqual({ card: num(0, 1), ok: false }); // owes UNO
  });
  it('skip jumps two seats; reverse flips direction; draw2 makes victim draw', () => {
    let s = fixture([[action(0, 'skip'), num(0, 8)], [num(1, 1), num(1, 5)], [num(2, 1), num(2, 5)], [num(3, 1), num(3, 5)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'skip') });
    expect(s.actor).toBe(2);

    s = fixture([[action(1, 'reverse'), num(1, 8)], [num(1, 1), num(1, 5)], [num(2, 1), num(2, 5)], [num(3, 1), num(3, 5)]], { topCard: num(0, 5), currentColor: 'blue' });
    s = play(s, 0, { type: 'play', card: action(1, 'reverse') });
    expect(s.direction).toBe(-1);
    expect(s.actor).toBe(3);

    s = fixture([[action(0, 'draw2'), num(0, 8)], [num(1, 1), num(1, 5)], [num(2, 1), num(2, 5)], [num(3, 1), num(3, 5)]], { topCard: num(0, 5), currentColor: 'red' });
    const before = s.hands[1]!.length + s.deck.length;
    s = play(s, 0, { type: 'play', card: action(0, 'draw2') });
    expect(s.actor).toBe(2);
    expect(s.hands[1]!.length).toBe(4);
    expect(s.hands[1]!.length + s.deck.length).toBe(before);
  });
  it('reverse acts as skip with exactly two players', () => {
    // Two seats: the opponent is skipped, so the turn returns to p0 and the
    // direction never flips.
    let s = fixture([[action(0, 'reverse'), num(0, 3)], [num(1, 1), num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'reverse') });
    expect(s.direction).toBe(1);
    expect(s.actor).toBe(0);
    expect(s.phase).toBe('turn');
  });
  it('draw allows only the drawn card; pass ends the turn', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    const deckBefore = s.deck.length;
    s = play(s, 0, { type: 'draw' });
    expect(s.pendingDraw).not.toBeNull();
    expect(s.hands[0]!.length).toBe(3);
    expect(s.deck.length).toBe(deckBefore - 1);
    expect(invalidReason(s, { type: 'play', card: num(0, 7) }, 'p0', 5000)).toMatch(/взятую карту/);
    const drawn = s.pendingDraw!;
    if (isPlayable(drawn, s.discard[s.discard.length - 1]!, s.currentColor)) {
      const next = play(s, 0, { type: 'play', card: drawn });
      expect(next.actor).toBe(1);
    } else {
      s = play(s, 0, { type: 'pass' });
      expect(s.actor).toBe(1);
      expect(s.pendingDraw).toBeNull();
    }
  });
});

describe('wild and color choice', () => {
  it('wild without color opens the color phase; chooseColor applies it', () => {
    let s = fixture([[WILD, num(1, 4)], [num(2, 1)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: WILD });
    expect(s.phase).toBe('color');
    expect(s.awaiting).toMatchObject({ card: WILD, draw4: false });
    expect(invalidReason(s, { type: 'chooseColor', color: 'blue' }, 'p1', 5000)).toMatch(/игрок, сыгравший/);
    s = transition(s, { type: 'chooseColor', color: 'blue' }, 'p0', 5000);
    expect(s.currentColor).toBe('blue');
    expect(s.actor).toBe(1);
    expect(s.phase).toBe('turn');
  });
  it('wild with inline color resolves immediately', () => {
    let s = fixture([[WILD, num(1, 4)], [num(2, 1)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: WILD, color: 'green' });
    expect(s.currentColor).toBe('green');
    expect(s.phase).toBe('turn');
  });
});

describe('wild draw four and challenge', () => {
  /** p0 holds DRAW4 plus `extra`; p1 (no red/wild) challenges, p2 waits. */
  function draw4State(attackerHasMatch: boolean) {
    const p0 = attackerHasMatch ? [DRAW4, num(0, 3)] : [DRAW4, num(1, 9)];
    return fixture([p0, [num(1, 8), num(3, 4)], [num(1, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red' });
  }
  it('opens a challenge window; timeout resolves as unchallenged (+4, skip)', () => {
    let s = draw4State(false);
    const deckBefore = s.deck.length + (s.discard.length > 1 ? s.discard.length - 1 : 0);
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    expect(s.phase).toBe('challenge');
    expect(s.challenge).toMatchObject({ bySeat: 0 });
    expect(playerView(s, 'p1').challenge).toMatchObject({ actorId: 'p0', iAmChallenger: true });
    expect(playerView(s, 'p2').challenge).toMatchObject({ iAmChallenger: false });
    const resolved = applySystem(s, { type: 'timeout' }, 5000 + CHALLENGE_MS + 1);
    expect(resolved.hands[1]!.length).toBe(6);
    expect(resolved.actor).toBe(2);
    expect(resolved.phase).toBe('turn');
    void deckBefore;
  });
  it('failed challenge: innocent challenger draws 6 and loses the turn', () => {
    let s = draw4State(false);
    const attackerCards = s.hands[0]!.length - 1;
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.hands[1]!.length).toBe(8); // 2 + 6
    expect(s.hands[0]!.length).toBe(attackerCards);
    expect(s.actor).toBe(2); // challenger loses turn
    expect(s.phase).toBe('turn');
  });
  it('successful challenge: attacker holding the color draws 4 and the challenger plays', () => {
    let s = draw4State(true);
    const attackerCards = s.hands[0]!.length - 1;
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.hands[0]!.length).toBe(attackerCards + 4);
    expect(s.hands[1]!.length).toBe(2);
    expect(s.actor).toBe(1); // successful challenge: the challenger takes their turn
  });
  it('wild cards count as a color match for +4 legality', () => {
    // Attacker's remaining hand holds a Wild → the +4 was illegal.
    let s = fixture([[DRAW4, WILD], [num(2, 1), num(3, 1)], [num(1, 1), num(2, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.hands[0]!.length).toBe(5); // 1 wild + 4 penalty
    expect(s.hands[1]!.length).toBe(2);
  });
  it('only the next player may challenge, once', () => {
    let s = draw4State(false);
    s = play(s, 0, { type: 'play', card: DRAW4, color: 'blue' });
    expect(invalidReason(s, { type: 'challenge' }, 'p2', 5000)).toMatch(/следующий игрок/);
    s = transition(s, { type: 'challenge' }, 'p1', 5000);
    expect(s.phase).toBe('turn');
    expect(() => transition(s, { type: 'challenge' }, 'p1', 5000)).toThrow();
  });
});

describe('UNO call and catch', () => {
  it('auto-declares with play.callUno and allows late callUno', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: num(0, 7), callUno: true });
    expect(s.uno[0]).toEqual({ card: num(0, 1), ok: true });
    expect(playerView(s, 'p1').legal.catchable).toEqual([]);

    let t = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    t = play(t, 0, { type: 'play', card: num(0, 7) });
    expect(t.uno[0]!.ok).toBe(false);
    t = transition(t, { type: 'callUno' }, 'p0', 5000);
    expect(t.uno[0]!.ok).toBe(true);
  });
  it('catching an undeclared one-card player draws 2 and prevents double penalty', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    const before = s.hands[0]!.length;
    s = transition(s, { type: 'catchUno', target: 'p0' }, 'p1', 5000);
    expect(s.hands[0]!.length).toBe(before + 2);
    expect(s.uno[0]).toBeNull();
    expect(() => transition(s, { type: 'catchUno', target: 'p0' }, 'p1', 5000)).toThrow();
    // The target cannot be caught again for the same episode even after
    // returning to one card — a new card means a new episode.
  });
  it('cannot catch a player who declared UNO', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: num(0, 7), callUno: true });
    expect(invalidReason(s, { type: 'catchUno', target: 'p0' }, 'p1', 5000)).toMatch(/объявил/);
  });
});

describe('round end, scoring and match modes', () => {
  it('ends the round on empty hand, scores opponents cards and starts next round', () => {
    let s = fixture([[num(0, 7)], [num(1, 2), num(1, 3), action(2, 'skip')], [num(3, 4), WILD]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.phase).toBe('roundEnd');
    expect(s.roundWinner).toBe(0);
    // p1: 2+3+20=25, p2: 4+50=54 → 79 points
    expect(s.roundPoints).toBe(79);
    expect(s.scores[0]).toBe(79);
    const view = playerView(s, 'p0');
    expect(view.roundWinner).toBe('p0');
    expect(view.result).toBeNull();
    s = transition(s, { type: 'nextRound' }, 'p1', 6000);
    expect(s.round).toBe(2);
    expect(s.phase).toBe('turn');
    expect(s.scores[0]).toBe(79);
    assertInvariants(s);
  });
  it('quick mode finishes the match after the first round', () => {
    let s = fixture([[num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', mode: 'quick' });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.phase).toBe('finished');
    expect(result(s)).toEqual({ winners: ['p0'], losers: ['p1'], draw: false });
  });
  it('points mode finishes when the target score is reached', () => {
    // p1 holds blue2 + wild = 52 points for the winner.
    let s = fixture([[num(0, 7)], [num(1, 2), WILD]], { topCard: num(0, 5), currentColor: 'red', target: 50 });
    s = play(s, 0, { type: 'play', card: num(0, 7) });
    expect(s.phase).toBe('finished');
    expect(result(s)!.winners).toEqual(['p0']);
  });
  it('last card as draw2 still resolves the penalty before scoring', () => {
    let s = fixture([[action(0, 'draw2')], [num(1, 2), num(1, 3)]], { topCard: num(0, 5), currentColor: 'red' });
    s = play(s, 0, { type: 'play', card: action(0, 'draw2') });
    expect(s.phase).toBe('roundEnd');
    expect(s.hands[1]!.length).toBe(4); // penalty applied before scoring
    expect(s.roundPoints).toBe(s.hands[1]!.reduce((a, c) => a + cardPoints(c), 0));
  });
});

describe('system actions', () => {
  it('timeout draws one card and passes the turn', () => {
    const s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red' });
    const timed = { ...s, deadline: 100 };
    const next = applySystem(timed, { type: 'timeout' }, 200);
    expect(next.actor).toBe(1);
    expect(next.hands[0]!.length).toBe(3);
  });
  it('timeout after drawing only passes', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', deadline: 100 });
    s = play(s, 0, { type: 'draw' }, 50);
    const next = applySystem(s, { type: 'timeout' }, 40000);
    expect(next.actor).toBe(1);
    expect(next.hands[0]!.length).toBe(3);
  });
  it('pauses when nobody is online and resumes with remaining time', () => {
    const s = fixture([[num(0, 1)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', deadline: 1000 });
    const paused = applySystem(s, { type: 'pause' }, 400);
    expect(paused.pausedRemaining).toBe(600);
    const resumed = applySystem(paused, { type: 'resume' }, 5000);
    expect(resumed.deadline).toBe(5600);
    expect(resumed.pausedRemaining).toBeNull();
  });
  it('auto-picks a color on timeout during color phase', () => {
    let s = fixture([[WILD, num(0, 3), num(0, 4)], [num(1, 1)]], { topCard: num(0, 5), currentColor: 'red', deadline: 100 });
    s = play(s, 0, { type: 'play', card: WILD }, 50);
    const next = applySystem(s, { type: 'timeout' }, 40000);
    expect(next.phase).toBe('turn');
    expect(next.currentColor).toBe('red'); // most frequent in hand
    expect(next.actor).toBe(1);
  });
});

describe('surrender and forfeits', () => {
  it('removes the player, keeps conservation and passes their turn', () => {
    let s = fixture([[num(0, 1), num(0, 7)], [num(1, 2)], [num(2, 3)]], { topCard: num(0, 5), currentColor: 'red', actor: 0 });
    s.actor = 0;
    s = transition(s, { type: 'surrender' }, 'p0', 5000);
    expect(s.forfeited).toEqual([0]);
    expect(s.hands[0]).toEqual([]);
    expect(s.out.length).toBe(2);
    expect(s.actor).toBe(1);
    assertInvariants(s);
  });
  it('a lone remaining player wins the round', () => {
    let s = fixture([[num(0, 1)], [num(1, 2)]], { topCard: num(0, 5), currentColor: 'red', mode: 'quick' });
    s = transition(s, { type: 'surrender' }, 'p0', 5000);
    expect(s.phase).toBe('finished');
    expect(result(s)!.winners).toEqual(['p1']);
  });
});

describe('module contract', () => {
  it('serializes and restores state deterministically', () => {
    const s = createState({ mode: 'points', target: 500, maxPlayers: 10 }, ctx(3, 5));
    const restored = unoModule.restore(unoModule.serialize(s));
    expect(restored).toEqual(s);
  });
  it('rejects settings with unknown keys', () => {
    expect(unoModule.settingsSchema.safeParse({ clientBalance: 1 }).success).toBe(false);
    expect(unoModule.settingsSchema.safeParse({}).success).toBe(true);
  });
});
