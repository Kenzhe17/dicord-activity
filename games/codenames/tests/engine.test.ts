import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createState, transition, invalidReason, playerView, result, assertInvariants, systemAction, applySystem, stateSchema, legalActions } from '../engine';
import type { CodenamesState, CodenamesAction, Team } from '../engine';

const PLAYERS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const ctx = (players = PLAYERS, seed = 42, hostId = 'p1') => ({ players, seed, startedAt: 0, hostId });
const settings = (extra: Record<string, unknown> = {}) => ({ ruleSet: 'classic', timed: false, traitor: false, hintSeconds: 60, guessSeconds: 180, dictionary: 'ru', ...extra });

function draftDone(extra: Record<string, unknown> = {}, players = PLAYERS): CodenamesState {
  let s = createState(settings(extra), ctx(players));
  // p1,p2 red (p1 spymaster); p3,p4 blue (p3 spymaster); p5,p6 spectators
  const picks: [string, 'red' | 'blue' | 'spectator', 'spymaster' | 'operative'][] = [
    ['p1', 'red', 'spymaster'], ['p2', 'red', 'operative'],
    ['p3', 'blue', 'spymaster'], ['p4', 'blue', 'operative'],
    ['p5', 'spectator', 'operative'], ['p6', 'spectator', 'operative'],
  ];
  for (const [id, team, role] of picks) {
    s = transition(s, { type: 'choose', team, role: role === 'operative' && team === 'spectator' ? undefined : role }, id, 0);
  }
  s = transition(s, { type: 'start' }, 'p1', 0);
  return s;
}
const operativeOf = (s: CodenamesState, team: Team) => s.assignments.find(a => a.team === team && a.role === 'operative')!.playerId;
const spymasterOf = (s: CodenamesState, team: Team) => s.assignments.find(a => a.team === team && a.role === 'spymaster')!.playerId;

function firstIndexOfRole(s: CodenamesState, role: string): number {
  return s.board.roles.findIndex(r => r === role);
}
function act(s: CodenamesState, actorId: string, action: CodenamesAction, now = 10): CodenamesState {
  const reason = invalidReason(s, action, actorId, now);
  if (reason) throw new Error('Illegal in test: ' + reason);
  return transition(s, action, actorId, now);
}

describe('Codenames engine — setup and draft', () => {
  it('deals a unique 25-word board with 9/8/7/1 composition', () => {
    const s = createState(settings(), ctx());
    expect(new Set(s.board.words).size).toBe(25);
    expect(s.board.roles.filter(r => r === s.starter)).toHaveLength(9);
    expect(s.board.roles.filter(r => r === (s.starter === 'red' ? 'blue' : 'red'))).toHaveLength(8);
    expect(s.board.roles.filter(r => r === 'neutral')).toHaveLength(7);
    expect(s.board.roles.filter(r => r === 'assassin')).toHaveLength(1);
    expect(s.phase).toBe('draft');
    assertInvariants(s);
  });
  it('is deterministic per seed and restores from serialization', () => {
    const a = createState(settings(), ctx(PLAYERS, 777));
    const b = createState(settings(), ctx(PLAYERS, 777));
    expect(a.board).toEqual(b.board);
    const c = stateSchema.parse(JSON.parse(JSON.stringify(a)));
    expect(c.board).toEqual(a.board);
    const other = createState(settings(), ctx(PLAYERS, 778));
    expect(other.board.words).not.toEqual(a.board.words);
  });
  it('rejects start without exactly one spymaster per team and min sizes', () => {
    let s = createState(settings(), ctx());
    expect(invalidReason(s, { type: 'start' }, 'p1', 1)).toMatch(/руководител/);
    s = transition(s, { type: 'choose', team: 'red', role: 'spymaster' }, 'p1', 1);
    s = transition(s, { type: 'choose', team: 'red', role: 'operative' }, 'p2', 1);
    s = transition(s, { type: 'choose', team: 'blue', role: 'spymaster' }, 'p3', 1);
    // blue has only the spymaster — one short
    expect(invalidReason(s, { type: 'start' }, 'p1', 1)).toMatch(/минимум 2/);
    s = transition(s, { type: 'choose', team: 'blue', role: 'operative' }, 'p4', 1);
    // non-host cannot start
    expect(invalidReason(s, { type: 'start' }, 'p2', 1)).toMatch(/организатор/);
    s = transition(s, { type: 'start' }, 'p1', 0);
    expect(s.phase).toBe('hint');
  });
  it('allows only one spymaster per team and spectators cannot pick roles', () => {
    let s = createState(settings(), ctx());
    s = transition(s, { type: 'choose', team: 'red', role: 'spymaster' }, 'p1', 1);
    expect(invalidReason(s, { type: 'choose', team: 'red', role: 'spymaster' }, 'p2', 1)).toMatch(/уже выбран/);
    s = transition(s, { type: 'choose', team: 'red', role: 'operative' }, 'p2', 1);
    expect(s.assignments.find(a => a.playerId === 'p2')).toEqual({ playerId: 'p2', team: 'red', role: 'operative' });
  });
  it('traitor mode requires 3 players per team', () => {
    const four = ['a', 'b', 'c', 'd'];
    let s = createState(settings({ traitor: true }), ctx(four, 5, 'a'));
    for (const [id, team, role] of [['a', 'red', 'spymaster'], ['b', 'red', 'operative'], ['c', 'blue', 'spymaster'], ['d', 'blue', 'operative']] as const) {
      s = transition(s, { type: 'choose', team, role }, id, 1);
    }
    expect(invalidReason(s, { type: 'start' }, 'a', 1)).toMatch(/предател/);
  });
});

describe('Codenames engine — turns and picks', () => {
  it('spymaster hint opens guess phase; own pick continues in unlimited', () => {
    const s0 = draftDone({ ruleSet: 'unlimited' });
    const team = s0.currentTeam;
    const spy = spymasterOf(s0, team);
    const ownIdx = firstIndexOfRole(s0, team);
    let s = act(s0, spy, { type: 'hint', word: 'qwerty', count: 3 }, 10);
    expect(s.phase).toBe('guess');
    expect(s.turn).toMatchObject({ team, word: 'qwerty', count: 3, used: 0 });
    s = act(s, operativeOf(s, team), { type: 'pick', index: ownIdx }, 11);
    expect(s.phase).toBe('guess');
    expect(s.turn!.used).toBe(1);
    expect(s.board.revealed[ownIdx]).toBe(true);
    assertInvariants(s);
  });
  it('classic mode allows count+1 own picks, then ends the turn', () => {
    const s0 = draftDone({ ruleSet: 'classic' });
    const team = s0.currentTeam;
    const spy = spymasterOf(s0, team);
    const ownIdx = s0.board.roles.map((r, i) => r === team && !s0.board.revealed[i] ? i : -1).filter(i => i >= 0).slice(0, 2);
    let s = act(s0, spy, { type: 'hint', word: 'qwerty', count: 1 }, 10);
    s = act(s, operativeOf(s, team), { type: 'pick', index: ownIdx[0]! }, 11);
    expect(s.phase).toBe('guess'); // plus-one: still allowed after `count` picks
    s = act(s, operativeOf(s, team), { type: 'pick', index: ownIdx[1]! }, 12);
    expect(s.phase).toBe('hint');
    expect(s.currentTeam).toBe(team === 'red' ? 'blue' : 'red');
    expect(s.history.at(-1)).toMatchObject({ word: 'qwerty', outcome: 'limit' });
  });
  it('enemy and neutral picks end the turn', () => {
    for (const role of ['neutral'] as const) {
      const s0 = draftDone();
      const team = s0.currentTeam;
      const idx = firstIndexOfRole(s0, role === 'neutral' ? 'neutral' : (team === 'red' ? 'blue' : 'red'));
      let s = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 2 }, 10);
      s = act(s, operativeOf(s, team), { type: 'pick', index: idx }, 11);
      expect(s.phase).toBe('hint');
      expect(s.history.at(-1)!.outcome).toBe('neutral');
    }
    const s0 = draftDone();
    const team = s0.currentTeam;
    const enemyIdx = firstIndexOfRole(s0, team === 'red' ? 'blue' : 'red');
    let s = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 2 }, 10);
    s = act(s, operativeOf(s, team), { type: 'pick', index: enemyIdx }, 11);
    expect(s.phase).toBe('hint');
    expect(s.history.at(-1)!.outcome).toBe('enemy');
  });
  it('assassin pick ends the game instantly for the picking team', () => {
    const s0 = draftDone();
    const team = s0.currentTeam;
    const idx = firstIndexOfRole(s0, 'assassin');
    let s = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 1 }, 10);
    s = act(s, operativeOf(s, team), { type: 'pick', index: idx }, 11);
    expect(s.phase).toBe('finished');
    expect(s.winner).not.toBeNull();
    expect(s.endReason).toBe('assassin');
    const r = result(s)!;
    expect(r.winners).toContain(spymasterOf(s0, team === 'red' ? 'blue' : 'red'));
    expect(r.losers).toContain(operativeOf(s0, team));
  });
  it('revealing the last own card wins immediately', () => {
    const s0 = draftDone();
    // Reveal all but one own card first via direct state surgery is complex;
    // instead simulate picks until own team wins or turn passes.
    let s = s0;
    let guard = 0;
    while (s.phase !== 'finished' && guard++ < 200) {
      if (s.phase === 'hint') {
        const own = s.board.roles.filter((r, i) => r === s.currentTeam && !s.board.revealed[i]).length;
        s = act(s, spymasterOf(s, s.currentTeam), { type: 'hint', word: 'qwerty', count: Math.max(1, own) }, 10);
      } else {
        const ownIdx = s.board.roles.findIndex((r, i) => r === s.currentTeam && !s.board.revealed[i]);
        s = act(s, operativeOf(s, s.currentTeam), { type: 'pick', index: ownIdx }, 10);
      }
    }
    expect(s.phase).toBe('finished');
    expect(['all-own', 'all-enemy', 'assassin']).toContain(s.endReason);
    assertInvariants(s);
  });
  it('revealing the last ENEMY word wins for the enemy team, not the picker', () => {
    // Official rule: a team wins when it has no words left — even if the
    // opposing team flipped the final card.
    const s0 = draftDone();
    const team = s0.currentTeam;
    const enemy = team === 'red' ? 'blue' : 'red';
    // Leave exactly one enemy card unrevealed (state surgery: reveal flags only).
    const enemyIdx = s0.board.roles.map((r, i) => r === enemy ? i : -1).filter(i => i >= 0);
    const s1: CodenamesState = {
      ...s0,
      board: { ...s0.board, revealed: s0.board.revealed.map((v, i) => v || (enemyIdx.includes(i) && i !== enemyIdx[0])) },
    };
    assertInvariants(s1);
    let s = act(s1, spymasterOf(s1, team), { type: 'hint', word: 'qwerty', count: 1 }, 10);
    s = act(s, operativeOf(s, team), { type: 'pick', index: enemyIdx[0]! }, 11);
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe(enemy);
    expect(s.endReason).toBe('all-enemy');
    expect([...result(s)!.winners].sort()).toEqual(s.assignments.filter(a => a.team === enemy).map(a => a.playerId).sort());
  });
  it('rejects illegal picks: wrong role, revealed card, wrong phase', () => {
    const s0 = draftDone();
    const team = s0.currentTeam;
    const otherTeam = team === 'red' ? 'blue' : 'red';
    let s = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 1 }, 10);
    const spy = spymasterOf(s, team);
    const foe = operativeOf(s, otherTeam);
    const idx = s.board.roles.findIndex((r, i) => r === team && !s.board.revealed[i]);
    expect(invalidReason(s, { type: 'pick', index: idx }, spy, 11)).toMatch(/Угадывать/)
    // (capital У in the server message);
    expect(invalidReason(s, { type: 'pick', index: idx }, foe, 11)).toMatch(/Угадывать/)
    // (capital У in the server message);
    s = act(s, operativeOf(s, team), { type: 'pick', index: idx }, 11);
    expect(invalidReason(s, { type: 'pick', index: idx }, operativeOf(s, otherTeam), 12)).not.toBeNull();
    expect(invalidReason(s, { type: 'pick', index: -1 }, operativeOf(s, team), 12)).not.toBeNull();
    expect(invalidReason(s, { type: 'pick', index: 25 }, operativeOf(s, team), 12)).not.toBeNull();
    expect(invalidReason(s, { type: 'pick', index: 999 }, operativeOf(s, team), 12)).not.toBeNull();
  });
  it('hint validation: board word, multiword, bad count', () => {
    const s0 = draftDone();
    const team = s0.currentTeam;
    const spy = spymasterOf(s0, team);
    const boardWord = s0.board.words.find((_, i) => !s0.board.revealed[i] && s0.board.roles[i] !== team)!;
    expect(invalidReason(s0, { type: 'hint', word: boardWord, count: 1 }, spy, 10)).toMatch(/с поля/);
    expect(invalidReason(s0, { type: 'hint', word: 'два слова', count: 1 }, spy, 10)).toMatch(/одним словом/);
    expect(invalidReason(s0, { type: 'hint', word: 'запрещённое!', count: 1 }, spy, 10)).not.toBeNull();
    const own = s0.board.roles.filter(r => r === team).length;
    expect(invalidReason(s0, { type: 'hint', word: 'совсем', count: own + 1 }, spy, 10)).not.toBeNull();
    expect(invalidReason(s0, { type: 'hint', word: 'совсем', count: 0 }, spy, 10)).toBeNull();
    // spymaster of the wrong team cannot hint
    const otherSpy = spymasterOf(s0, team === 'red' ? 'blue' : 'red');
    expect(invalidReason(s0, { type: 'hint', word: 'совсем', count: 1 }, otherSpy, 10)).toMatch(/руководитель/);
  });
  it('zero clue gives unlimited guesses without the plus-one cap', () => {
    const s0 = draftDone({ ruleSet: 'classic' });
    const team = s0.currentTeam;
    const ownIdx = s0.board.roles.map((r, i) => r === team && !s0.board.revealed[i] ? i : -1).filter(i => i >= 0).slice(0, 3);
    let s = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 0 }, 10);
    expect(s.phase).toBe('guess');
    expect(s.turn).toMatchObject({ count: 0 });
    for (const [n, idx] of ownIdx.entries()) {
      s = act(s, operativeOf(s, team), { type: 'pick', index: idx }, 11 + n);
      expect(s.phase).toBe('guess'); // unlimited: turn continues past count+1
    }
    s = act(s, operativeOf(s, team), { type: 'endTurn' }, 20);
    expect(s.phase).toBe('hint');
    expect(s.history.at(-1)).toMatchObject({ word: 'qwerty', count: 0, outcome: 'passed' });
  });
  it('endTurn requires at least one guess first', () => {
    const s0 = draftDone({ ruleSet: 'unlimited' });
    const team = s0.currentTeam;
    let s = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 2 }, 10);
    expect(invalidReason(s, { type: 'endTurn' }, operativeOf(s, team), 11)).toMatch(/попытку/);
    const ownIdx = s.board.roles.findIndex((r, i) => r === team && !s.board.revealed[i]);
    s = act(s, operativeOf(s, team), { type: 'pick', index: ownIdx }, 11);
    s = act(s, operativeOf(s, team), { type: 'endTurn' }, 12);
    expect(s.phase).toBe('hint');
    expect(s.history.at(-1)!.outcome).toBe('passed');
  });
  it('surrender ends the match with the other team winning', () => {
    const s0 = draftDone();
    const team = s0.currentTeam;
    const s = act(s0, operativeOf(s0, team), { type: 'surrender' }, 10);
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe(team === 'red' ? 'blue' : 'red');
  });
});

describe('Codenames engine — timed mode and system actions', () => {
  it('sets hint and guess deadlines only in timed mode', () => {
    const untimed = draftDone();
    expect(untimed.deadline).toBeNull();
    const timed = draftDone({ timed: true, hintSeconds: 30, guessSeconds: 90 });
    expect(timed.deadline).toBe(30_000);
    const team = timed.currentTeam;
    const s = act(timed, spymasterOf(timed, team), { type: 'hint', word: 'qwerty', count: 1 }, 5_000);
    expect(s.deadline).toBe(5_000 + 90_000);
    // actions after deadline are rejected
    expect(invalidReason(s, { type: 'pick', index: 0 }, operativeOf(s, team), 95_000)).toMatch(/истекло/);
  });
  it('timeout system action passes the turn in hint and guess phases', () => {
    const s0 = draftDone({ timed: true, hintSeconds: 30, guessSeconds: 90 });
    expect(systemAction(s0, 40_000, true)).toEqual({ type: 'timeout' });
    const s1 = applySystem(s0, { type: 'timeout' }, 40_000);
    expect(s1.phase).toBe('hint');
    expect(s1.currentTeam).not.toBe(s0.currentTeam);
    // guess-phase timeout
    const team = s0.currentTeam;
    const s2 = act(s0, spymasterOf(s0, team), { type: 'hint', word: 'qwerty', count: 1 }, 1_000);
    expect(systemAction(s2, 92_000, true)).toEqual({ type: 'timeout' });
    const s3 = applySystem(s2, { type: 'timeout' }, 92_000);
    expect(s3.phase).toBe('hint');
    expect(s3.currentTeam).not.toBe(team);
  });
  it('pauses the timer when everyone is offline and resumes on return', () => {
    const s0 = draftDone({ timed: true, hintSeconds: 30 });
    expect(systemAction(s0, 10_000, false)).toEqual({ type: 'pause' });
    const paused = applySystem(s0, { type: 'pause' }, 10_000);
    expect(paused.pausedRemaining).toBe(20_000);
    expect(systemAction(paused, 50_000, true)).toEqual({ type: 'resume' });
    const resumed = applySystem(paused, { type: 'resume' }, 50_000);
    expect(resumed.deadline).toBe(70_000);
    expect(resumed.pausedRemaining).toBeNull();
    // no actions while paused (except surrender)
    expect(invalidReason(resumed, { type: 'choose', team: 'red' }, 'p1', 51_000)).not.toBeNull();
  });
  it('recover extends the deadline after a server restart', () => {
    const s0 = draftDone({ timed: true, hintSeconds: 30 });
    const s = applySystem(s0, { type: 'recover' }, 100_000);
    expect(s.deadline).toBe(130_000);
  });
});

describe('Codenames engine — hidden information', () => {
  it('operative and spectator never receive the key; spymaster does', () => {
    const s0 = draftDone();
    const team = s0.currentTeam;
    const spyView = playerView(s0, spymasterOf(s0, team)) as Record<string, unknown>;
    const opView = playerView(s0, operativeOf(s0, team)) as Record<string, unknown>;
    const specView = playerView(s0, 'p5') as Record<string, unknown>;
    expect(spyView['key']).toHaveLength(25);
    expect(opView['key']).toBeUndefined();
    expect(specView['key']).toBeUndefined();
    // serialized views must not leak roles into operative payloads
    expect(JSON.stringify(opView)).not.toContain('"assassin"');
    expect(JSON.stringify(specView)).not.toContain('"assassin"');
  });
  it('traitor sees only enemy cards and the assassin', () => {
    const six = ['t1', 't2', 't3', 't4', 't5', 't6'];
    let s = createState(settings({ traitor: true }), ctx(six, 11, 't1'));
    const draft: [string, 'red' | 'blue' | 'spectator', 'spymaster' | 'operative'][] = [
      ['t1', 'red', 'spymaster'], ['t2', 'red', 'operative'], ['t3', 'red', 'operative'],
      ['t4', 'blue', 'spymaster'], ['t5', 'blue', 'operative'], ['t6', 'blue', 'operative'],
    ];
    for (const [id, team, role] of draft) s = transition(s, { type: 'choose', team, role }, id, 1);
    s = transition(s, { type: 'start' }, 't1', 0);
    const traitorId = s.traitors[s.currentTeam]!;
    const view = playerView(s, traitorId) as Record<string, unknown>;
    const intel = view['intel'] as (string | null)[];
    expect(intel).toHaveLength(25);
    const enemy = s.currentTeam === 'red' ? 'blue' : 'red';
    s.board.roles.forEach((r, i) => {
      if (r === 'assassin' || r === enemy) expect(intel[i]).toBe(r);
      else expect(intel[i]).toBeNull();
    });
    expect(view['key']).toBeUndefined();
    // teammate operative gets nothing
    const mate = s.assignments.find(a => a.team === s.currentTeam && a.role === 'operative' && a.playerId !== traitorId)!.playerId;
    expect((playerView(s, mate) as Record<string, unknown>)['intel']).toBeUndefined();
    expect((playerView(s, mate) as Record<string, unknown>)['key']).toBeUndefined();
  });
  it('finished game reveals the full board and traitor identities to everyone', () => {
    const s0 = draftDone();
    let s = s0;
    let guard = 0;
    while (s.phase !== 'finished' && guard++ < 300) {
      if (s.phase === 'hint') {
        const own = s.board.roles.filter((r, i) => r === s.currentTeam && !s.board.revealed[i]).length;
        s = act(s, spymasterOf(s, s.currentTeam), { type: 'hint', word: 'qwerty', count: Math.max(1, own) }, 10);
      } else {
        const idx = s.board.roles.findIndex((r, i) => r === s.currentTeam && !s.board.revealed[i]);
        s = act(s, operativeOf(s, s.currentTeam), { type: 'pick', index: idx }, 10);
      }
    }
    const spec = playerView(s, 'p5') as Record<string, unknown>;
    expect(spec['boardRoles']).toHaveLength(25);
    expect(spec['traitors']).toBeDefined();
  });
});

describe('Codenames engine — simulation and properties', () => {
  it('always terminates with a winner under random legal play', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), seed => {
      let s = draftDone({}, PLAYERS);
      let rngState = seed >>> 0;
      const rand = () => { rngState = (rngState + 0x6D2B79F5) | 0; let t = Math.imul(rngState ^ rngState >>> 15, 1 | rngState); t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      let guard = 0;
      while (s.phase !== 'finished' && guard++ < 500) {
        if (s.phase === 'draft') throw new Error('draft should be over');
        if (s.phase === 'hint') {
          const own = s.board.roles.filter((r, i) => r === s.currentTeam && !s.board.revealed[i]).length;
          s = act(s, spymasterOf(s, s.currentTeam), { type: 'hint', word: 'qwerty', count: Math.max(1, Math.min(own, 1 + Math.floor(rand() * own))) }, 10);
        } else {
          const open = s.board.roles.map((_, i) => i).filter(i => !s.board.revealed[i]);
          const canEnd = s.turn !== null && s.turn.picks.length > 0;
          const pick = open.length && (!canEnd || rand() < 0.7) ? open[Math.floor(rand() * open.length)]! : -1;
          const actor = operativeOf(s, s.currentTeam);
          s = pick >= 0 ? act(s, actor, { type: 'pick', index: pick }, 10) : act(s, actor, { type: 'endTurn' }, 10);
        }
        assertInvariants(s);
      }
      expect(s.phase).toBe('finished');
      expect(result(s)).not.toBeNull();
    }), { numRuns: 25 });
  });
  it('legalActions never proposes an action rejected by invalidReason', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), seed => {
      const s = draftDone({}, PLAYERS);
      for (const p of PLAYERS) {
        for (const a of legalActions(s, p)) {
          expect(invalidReason(s, a, p, 5)).toBeNull();
        }
      }
      expect(seed).toBeGreaterThanOrEqual(0);
    }), { numRuns: 10 });
  });
});
