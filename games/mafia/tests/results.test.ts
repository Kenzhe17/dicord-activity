import { describe, expect, it } from 'vitest';
import { transition, playerView, result, assertInvariants, stateSchema } from '../engine';
import { mafiaModule } from '../server/module';
import {
  makeState, toNight, toPhase, toVoting, seatsWith, seatWith, vote, aliveSeats, advance,
} from './fixture';
import type { MafiaState } from '../engine';

const P = (s: MafiaState, seat: number) => s.players[seat]!;

describe('win conditions', () => {
  it('town wins when the last mafia is voted out; dead teammates stay winners', () => {
    let s = makeState(6, 40);
    s = toNight(s);
    const m = seatWith(s, 'mafia');
    const victim = seatsWith(s, 'town')[0]!; // a town player dies at night
    s = transition(s, { type: 'nightKill', target: victim }, P(s, m), s.deadline);
    s = advance(s); // dawn
    s = toVoting(s);
    // Every living non-mafia votes for the last mafia; the mafia skips.
    for (const seat of aliveSeats(s)) {
      s = vote(s, seat, seat === m ? 'skip' : m);
    }
    s = advance(s);
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('town');
    const r = result(s)!;
    expect(r.draw).toBe(false);
    expect(r.losers).toEqual([P(s, m)]);
    // Winners are team-based: all five non-mafia ids, including the dead victim.
    expect(r.winners).toHaveLength(5);
    expect(r.winners).toContain(P(s, victim));
    expect(r.winners).not.toContain(P(s, m));
    // At finish every role is public and stats are exposed.
    const view = playerView(s, P(s, 0));
    expect(view.players.every(p => p.role !== null)).toBe(true);
    expect(view.stats).not.toBeNull();
    expect(view.stats).toHaveLength(6);
    assertInvariants(s);
  });

  it('mafia wins at numeric parity after enough forfeits', () => {
    let s = makeState(6, 41);
    const mafia = seatWith(s, 'mafia');
    const others = [0, 1, 2, 3, 4, 5].filter(i => i !== mafia);
    for (const seat of others.slice(0, 3)) {
      s = transition(s, { type: 'forfeit' }, P(s, seat), s.deadline);
      expect(s.phase).not.toBe('finished'); // 1 mafia vs 3 alive: no parity yet
    }
    s = transition(s, { type: 'forfeit' }, P(s, others[3]!), s.deadline);
    // Now alive = mafia + one townie = 2; 1*2 >= 2 -> mafia parity.
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('mafia');
    const r = result(s)!;
    expect(r.winners).toEqual([P(s, mafia)]);
    expect(r.losers).toEqual(s.players.filter((_, i) => i !== mafia));
    assertInvariants(s);
  });

  it('mafia parity also triggers with three mafiosi at eight players', () => {
    // 8 players -> 2 mafia; forfeit 4 non-mafia -> alive = 2 mafia + 2 town = 4.
    let s = makeState(8, 42);
    const mafias = seatsWith(s, 'mafia');
    const nonMafia = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => !mafias.includes(i));
    for (const seat of nonMafia.slice(0, 4)) {
      s = transition(s, { type: 'forfeit' }, P(s, seat), s.deadline);
    }
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('mafia');
    expect([...result(s)!.winners].sort()).toEqual(mafias.map(i => P(s, i)).sort());
  });

  it('a mafia forfeit hands the game to town immediately', () => {
    let s = makeState(6, 43);
    const mafia = seatWith(s, 'mafia');
    s = transition(s, { type: 'forfeit' }, P(s, mafia), s.deadline);
    expect(s.phase).toBe('finished');
    expect(s.winner).toBe('town');
    const r = result(s)!;
    expect(r.losers).toEqual([P(s, mafia)]);
    expect(r.winners).toHaveLength(5);
    expect(result(s)!.draw).toBe(false);
  });
});

describe('privacy and hidden stats', () => {
  it('eliminated players keep hidden roles; mafiosi see only their own team', () => {
    let s = toVoting(makeState(8, 44));
    const [m1, m2] = seatsWith(s, 'mafia');
    // Vote out m1 while m2 stays alive: game continues into the night.
    for (const seat of aliveSeats(s)) s = vote(s, seat, seat === m1 ? 'skip' : m1!);
    // Everyone except m1 votes m1 (m2 may vote their ally down): 7 votes vs 1 skip.
    s = advance(s);
    expect(s.phase).toBe('night');
    expect(s.alive[m1!]).toBe(false);
    const mafiaView = playerView(s, P(s, m2!));
    expect(mafiaView.players[m1!]!.role).toBe('mafia'); // allies stay visible to mafia
    expect(mafiaView.players[m2!]!.role).toBe('mafia');
    const townSeat = seatsWith(s, 'town')[0]!;
    const townView = playerView(s, P(s, townSeat));
    expect(townView.players[m1!]!.role).toBeNull();
    expect(townView.players[m2!]!.role).toBeNull();
    expect(townView.you.role.kind).toBe('town');
    // The dead mafioso still sees their own role and the living ally.
    const deadMafiaView = playerView(s, P(s, m1!));
    expect(deadMafiaView.you.role.kind).toBe('mafia');
    expect(deadMafiaView.you.alive).toBe(false);
  });

  it('stats and the saved flag stay hidden until the game finishes', () => {
    let s = toNight(makeState(6, 45));
    const m = seatWith(s, 'mafia');
    const doc = seatWith(s, 'doctor');
    const target = s.roles.findIndex(r => r === 'town');
    s = transition(s, { type: 'nightKill', target }, P(s, m), s.deadline);
    s = transition(s, { type: 'doctorHeal', target }, P(s, doc), s.deadline);
    s = advance(s); // dawn
    expect(s.stats[doc]).toMatchObject({ heals: 1, saves: 1 }); // engine knows…
    const view = playerView(s, P(s, doc));
    expect(view.stats).toBeNull(); // …the view does not
    expect(view.lastNight).toEqual({ victim: null }); // neither victim nor saved leaks
    expect(JSON.stringify(view)).not.toContain('saved');
    expect(JSON.stringify(view)).not.toContain('saves');
  });

  it('sheriff results never appear in another player\u2019s view', () => {
    let s = toNight(makeState(8, 46));
    const sheriff = seatWith(s, 'sheriff');
    const [m1] = seatsWith(s, 'mafia');
    s = transition(s, { type: 'sheriffCheck', target: m1! }, P(s, sheriff), s.deadline);
    s = advance(s);
    for (const id of s.players.filter((_, i) => i !== sheriff)) {
      const view = playerView(s, id);
      expect(view.you.sheriffResult).toBeNull();
      expect(JSON.stringify(view)).not.toContain('isMafia'); // no check outcome leaks
    }
  });
});

describe('serialization and module surface', () => {
  it('serialize -> restore round-trips a mid-game state through the module', () => {
    let s = toPhase(makeState(6, 47), 'discussion');
    s = transition(s, { type: 'chat', channel: 'town', text: 'привет' }, P(s, 0), s.deadline);
    const serialized = mafiaModule.serialize(s);
    const restored = mafiaModule.restore(serialized);
    expect(restored).toEqual(s);
    assertInvariants(restored);
    expect(stateSchema.parse(JSON.parse(serialized))).toEqual(s);
    expect(() => mafiaModule.restore('{}')).toThrow();
    const corrupted = JSON.parse(serialized) as Record<string, unknown>;
    corrupted.phase = 'bogus';
    expect(() => mafiaModule.restore(JSON.stringify(corrupted))).toThrow();
  });

  it('module helpers mirror the engine (validateAction, getPlayerView, isFinished)', () => {
    const s = toNight(makeState(6, 48));
    const m = seatWith(s, 'mafia');
    const town = seatsWith(s, 'town')[0]!;
    const ctx = { actorId: P(s, m), now: s.deadline };
    expect(mafiaModule.validateAction(s, { type: 'nightKill', target: town }, ctx).allowed).toBe(true);
    const bad = mafiaModule.validateAction(s, { type: 'nightKill', target: town }, { actorId: P(s, town), now: s.deadline });
    expect(bad.allowed).toBe(false);
    if (!bad.allowed) expect(bad.reason).toBeTruthy();
    expect(mafiaModule.getPlayerView(s, P(s, 0))).toEqual(playerView(s, P(s, 0)));
    expect(mafiaModule.isFinished(s)).toBe(false);
    const fin = transition(s, { type: 'forfeit' }, P(s, m), s.deadline);
    expect(fin.phase).toBe('finished'); // last mafia leaves -> town wins
    expect(fin.winner).toBe('town');
    expect(mafiaModule.isFinished(fin)).toBe(true);
    expect(mafiaModule.getResult(fin)).toEqual(result(fin));
  });
});
