import { describe, expect, it } from 'vitest';
import { transition, playerView, assertInvariants } from '../engine';
import { makeState, toNight, toPhase, nextNight, seatsWith, seatWith, stateWithRoles, advance } from './fixture';
import type { MafiaState } from '../engine';

const P = (s: MafiaState, seat: number) => s.players[seat]!;

describe('night resolution', () => {
  it('mafia kill eliminates the target at dawn and announces it publicly', () => {
    let s = toNight(makeState(6, 3));
    const m = seatWith(s, 'mafia');
    const target = s.roles.findIndex((r, i) => i !== m && r !== 'mafia');
    s = transition(s, { type: 'nightKill', target }, P(s, m), s.deadline);
    expect(s.alive[target]).toBe(true); // kill resolves when the night ends
    s = advance(s);
    expect(s.phase).toBe('dawn');
    expect(s.alive[target]).toBe(false);
    expect(s.lastNight).toEqual({ victim: target, saved: false });
    expect(s.deadThisCycle).toBe(true);
    const death = [...s.feed].reverse().find(f => f.kind === 'death');
    expect(death?.text).toContain(P(s, target));
    expect(playerView(s, P(s, m)).lastNight).toEqual({ victim: target });
    assertInvariants(s);
  });

  it('no mafia action means nobody dies', () => {
    let s = toNight(makeState(6, 4));
    s = advance(s);
    expect(s.phase).toBe('dawn');
    expect(s.alive.every(Boolean)).toBe(true);
    expect(s.lastNight).toEqual({ victim: null, saved: false });
    expect(s.feed.at(-1)?.kind).toBe('info');
    expect(s.feed.at(-1)?.text).toContain('никто не погиб');
  });

  it('tied mafia votes resolve through the stored rng, deterministically', () => {
    const tieNight = (seed: number) => {
      let s = toNight(makeState(8, seed));
      const [m1, m2] = seatsWith(s, 'mafia');
      const nonMafia = s.roles.map((r, i) => (r !== 'mafia' ? i : -1)).filter(i => i >= 0);
      const t1 = nonMafia.find(i => i !== m1)!;
      const t2 = nonMafia.find(i => i !== t1)!;
      s = transition(s, { type: 'nightKill', target: t1 }, P(s, m1!), s.deadline);
      s = transition(s, { type: 'nightKill', target: t2 }, P(s, m2!), s.deadline);
      s = advance(s);
      return { s, t1, t2 };
    };
    const a = tieNight(7);
    const b = tieNight(7);
    const victim = a.s.lastNight!.victim!;
    expect(victim).toBe(b.s.lastNight!.victim);
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
    expect([a.t1, a.t2]).toContain(victim);
    expect(a.s.alive[victim]).toBe(false);
    expect(a.s.alive[victim === a.t1 ? a.t2 : a.t1]).toBe(true);
    const victims = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) victims.add(tieNight(seed).s.lastNight!.victim!);
    expect(victims.size).toBeGreaterThan(1);
  });
});

describe('doctor', () => {
  it('heals the mafia victim: target survives and the save is recorded', () => {
    let s = toNight(makeState(6, 5));
    const m = seatWith(s, 'mafia');
    const doc = seatWith(s, 'doctor');
    const target = s.roles.findIndex(r => r === 'town');
    s = transition(s, { type: 'nightKill', target }, P(s, m), s.deadline);
    s = transition(s, { type: 'doctorHeal', target }, P(s, doc), s.deadline);
    s = advance(s);
    expect(s.phase).toBe('dawn');
    expect(s.alive[target]).toBe(true);
    expect(s.lastNight).toEqual({ victim: null, saved: true });
    expect(s.stats[doc]).toMatchObject({ heals: 1, saves: 1 });
    // The save detail must not leak through the player view before the finish.
    const view = playerView(s, P(s, doc));
    expect(view.stats).toBeNull();
    expect(view.lastNight).toEqual({ victim: null });
    expect(JSON.stringify(view)).not.toContain('saved');
  });

  it('allows self-heal and counts the heal even without a kill', () => {
    let s = toNight(makeState(6, 6));
    const doc = seatWith(s, 'doctor');
    s = transition(s, { type: 'doctorHeal', target: doc }, P(s, doc), s.deadline);
    s = advance(s);
    expect(s.alive[doc]).toBe(true);
    expect(s.lastNight).toEqual({ victim: null, saved: false });
    expect(s.stats[doc]).toMatchObject({ heals: 1, saves: 0 });
  });

  it('rejects healing the same target on two consecutive nights', () => {
    let s = toNight(makeState(6, 7));
    const doc = seatWith(s, 'doctor');
    const towns = seatsWith(s, 'town');
    const t1 = towns[0]!;
    const t2 = towns.find(i => i !== t1)!;
    s = transition(s, { type: 'doctorHeal', target: t1 }, P(s, doc), s.deadline);
    s = nextNight(s);
    expect(s.phase).toBe('night');
    expect(s.night).toBe(2);
    expect(() => transition(s, { type: 'doctorHeal', target: t1 }, P(s, doc), s.deadline)).toThrow('две ночи подряд');
    s = transition(s, { type: 'doctorHeal', target: t2 }, P(s, doc), s.deadline);
    s = nextNight(s);
    expect(s.phase).toBe('night');
    expect(s.night).toBe(3);
    // After healing t2 on night 2, t1 is allowed again on night 3.
    s = transition(s, { type: 'doctorHeal', target: t1 }, P(s, doc), s.deadline);
    expect(s.doctorHeal[doc]).toBe(t1);
  });
});

describe('sheriff', () => {
  it('records private check results visible only to the sheriff', () => {
    let s = toNight(makeState(8, 8));
    const sheriff = seatWith(s, 'sheriff');
    const [m1] = seatsWith(s, 'mafia');
    const townSeat = seatsWith(s, 'town')[0]!;
    s = transition(s, { type: 'sheriffCheck', target: m1! }, P(s, sheriff), s.deadline);
    s = advance(s);
    expect(s.phase).toBe('dawn');
    expect(s.sheriffResults[sheriff]).toEqual({ target: m1, isMafia: true, night: 1 });
    expect(s.stats[sheriff]).toMatchObject({ checks: 1, checksCorrect: 1 });
    const sv = playerView(s, P(s, sheriff));
    expect(sv.you.sheriffResult).toEqual({ target: m1, isMafia: true, night: 1 });
    for (const id of s.players.filter((_, i) => i !== sheriff)) {
      expect(playerView(s, id).you.sheriffResult).toBeNull();
    }
    expect(JSON.stringify(playerView(s, P(s, townSeat)))).not.toContain('isMafia');
    // Next night: checking a town player yields isMafia false and no correct-check stat.
    s = toPhase(s, 'night');
    s = transition(s, { type: 'sheriffCheck', target: townSeat }, P(s, sheriff), s.deadline);
    s = advance(s);
    expect(s.sheriffResults[sheriff]).toEqual({ target: townSeat, isMafia: false, night: 2 });
    expect(s.stats[sheriff]!.checks).toBe(2);
    expect(s.stats[sheriff]!.checksCorrect).toBe(1);
  });
});

describe('night action ACL', () => {
  it('enforces role, phase and target rules for night actions', () => {
    const s = toNight(makeState(8, 9));
    const [m1, m2] = seatsWith(s, 'mafia');
    const sheriff = seatWith(s, 'sheriff');
    const doctor = seatWith(s, 'doctor');
    const town = seatsWith(s, 'town')[0]!;
    const dl = s.deadline;
    for (const seat of [town, sheriff, doctor]) {
      expect(() => transition(s, { type: 'nightKill', target: town }, P(s, seat), dl)).toThrow('только мафии');
    }
    expect(() => transition(s, { type: 'sheriffCheck', target: town }, P(s, m1!), dl)).toThrow('только комиссару');
    expect(() => transition(s, { type: 'doctorHeal', target: town }, P(s, m1!), dl)).toThrow('только доктору');
    expect(() => transition(s, { type: 'sheriffCheck', target: m1! }, P(s, doctor), dl)).toThrow('только комиссару');
    expect(() => transition(s, { type: 'doctorHeal', target: town }, P(s, sheriff), dl)).toThrow('только доктору');
    // Invalid targets.
    expect(() => transition(s, { type: 'nightKill', target: m2! }, P(s, m1!), dl)).toThrow('Недопустимая цель'); // mafia seat
    expect(() => transition(s, { type: 'nightKill', target: m1! }, P(s, m1!), dl)).toThrow('Недопустимая цель'); // self is mafia
    expect(() => transition(s, { type: 'nightKill', target: 11 }, P(s, m1!), dl)).toThrow('Недопустимая цель'); // out of range
    expect(() => transition(s, { type: 'sheriffCheck', target: sheriff }, P(s, sheriff), dl)).toThrow('Недопустимая цель проверки'); // self
    expect(() => transition(s, { type: 'doctorHeal', target: 11 }, P(s, doctor), dl)).toThrow('Недопустимая цель лечения');
    // Night actions are unavailable outside the night phase.
    const d = toPhase(makeState(6, 10), 'discussion');
    const dm = seatWith(d, 'mafia');
    expect(() => transition(d, { type: 'nightKill', target: 0 }, P(d, dm), d.deadline)).toThrow('Ночное действие недоступно');
    const r = toPhase(makeState(6, 10), 'reveal');
    expect(() => transition(r, { type: 'doctorHeal', target: 0 }, P(r, seatWith(r, 'doctor')), r.deadline)).toThrow('Ночное действие недоступно');
  });

  it('rejects dead actors and dead targets on the following night', () => {
    let s = toNight(makeState(6, 11));
    const m = seatWith(s, 'mafia');
    const doc = seatWith(s, 'doctor');
    const sheriff = seatWith(s, 'sheriff');
    s = transition(s, { type: 'nightKill', target: doc }, P(s, m), s.deadline);
    s = advance(s); // dawn, doctor is dead
    s = toPhase(s, 'night'); // night 2
    expect(s.night).toBe(2);
    expect(() => transition(s, { type: 'doctorHeal', target: sheriff }, P(s, doc), s.deadline)).toThrow('Выбывшие не действуют ночью');
    expect(() => transition(s, { type: 'nightKill', target: doc }, P(s, m), s.deadline)).toThrow('Недопустимая цель');
    expect(() => transition(s, { type: 'sheriffCheck', target: doc }, P(s, sheriff), s.deadline)).toThrow('Недопустимая цель проверки');
  });

  it('a seat scanned for a matching role layout works via stateWithRoles', () => {
    const s = stateWithRoles(9, st => seatsWith(st, 'mafia').length === 2 && seatWith(st, 'sheriff') === 4, 1, 500);
    expect(seatWith(s, 'sheriff')).toBe(4);
    expect(seatsWith(s, 'mafia')).toHaveLength(2);
    assertInvariants(s);
  });
});
