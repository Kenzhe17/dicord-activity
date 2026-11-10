import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createState, transition, legalActions, assertInvariants, result } from '../games/durak/engine';
import type { DurakAction, DurakState } from '../games/durak/engine';
import { random, rank, suit, beats } from '../games/durak/engine/cards';

const required = Number(process.argv[2] ?? 10000);
if (!Number.isInteger(required) || required < 1) throw new Error('Expected a positive game count per cell');
const rows: { mode: string; players: number; completed: number; attempted: number; draws: number; actions: number; maxActions: number; stalledSeeds: number[]; milliseconds: number }[] = [];
function choose(s: DurakState, moves: DurakAction[], rng: () => number) {
  const transfers = moves.filter(m => m.type === 'transfer');
  if (transfers.length && rng() < 0.55) return transfers[Math.floor(rng() * transfers.length)]!;
  const defenses = moves.filter(m => m.type === 'defend');
  if (defenses.length) {
    defenses.sort((a, b) => (suit(a.card) === s.trump ? 20 : 0) + rank(a.card) - (suit(b.card) === s.trump ? 20 : 0) - rank(b.card));
    return rng() < 0.85 ? defenses[0]! : defenses[Math.floor(rng() * defenses.length)]!;
  }
  if (transfers.length) return transfers[0]!;
  const throwing = moves.filter(m => m.type === 'throw');
  if (throwing.length && rng() < 0.95) return throwing[Math.floor(rng() * throwing.length)]!;
  return moves[Math.floor(rng() * moves.length)]!;
}
function independentCheck(s: DurakState, m: DurakAction) {
  const own = s.hands[s.actor]!;
  if ('cards' in m && m.cards.some(c => !own.includes(c))) throw new Error('Strategy invented a card');
  if (m.type === 'defend' && (!own.includes(m.card) || !s.table.some(p => p.attack === m.target && p.defense === null && beats(p.attack, m.card, s.trump)))) throw new Error('Strategy selected invalid defense');
  if (m.type === 'throw' && m.cards.some(c => !s.table.some(p => rank(p.attack) === rank(c) || p.defense !== null && rank(p.defense) === rank(c)))) throw new Error('Strategy selected invalid throwing rank');
}
for (const mode of ['throw-in', 'transfer'] as const) for (let players = 2; players <= 6; players++) {
  const started = performance.now();
  const row = { mode, players, completed: 0, attempted: 0, draws: 0, actions: 0, maxActions: 0, stalledSeeds: [] as number[], milliseconds: 0 };
  while (row.completed < required) {
    const seed = (mode === 'transfer' ? 100000000 : 0) + players * 1000000 + row.attempted++;
    const rng = random(seed ^ 0xabcdef);
    let s = createState({ mode }, { players: Array.from({ length: players }, (_, i) => 'sim' + i), seed, startedAt: 0 });
    let steps = 0;
    while (s.phase !== 'finished' && steps < 5000) {
      const options = legalActions(s, s.players[s.actor]!);
      if (!options.length) throw new Error('Engine has no legal action at seed ' + seed + ', step ' + steps);
      const action = choose(s, options, rng); independentCheck(s, action);
      try { s = transition(s, action, s.players[s.actor]!, ++steps); }
      catch (error) { throw new Error('Engine rejected advertised action at seed ' + seed + ', step ' + steps, { cause: error }); }
      assertInvariants(s);
    }
    if (s.phase !== 'finished') { row.stalledSeeds.push(seed); if (row.stalledSeeds.length > required / 10 + 10) throw new Error('Strategy stall budget exceeded'); continue; }
    const final = result(s)!;
    if (!final || (!final.draw && final.losers.length !== 1)) throw new Error('Invalid terminal outcome, seed ' + seed);
    row.completed++; row.draws += Number(final.draw); row.actions += steps; row.maxActions = Math.max(row.maxActions, steps);
    if (row.completed % 1000 === 0) console.log(mode + ' / ' + players + ': ' + row.completed + '/' + required);
  }
  row.milliseconds = Math.round(performance.now() - started); rows.push(row); console.log(JSON.stringify(row));
}
const report = { requestedPerCell: required, completed: rows.reduce((sum, r) => sum + r.completed, 0), rows };
await writeFile('docs/rebuild/durak-simulations.json', JSON.stringify(report, null, 2) + '\n');
console.log('Completed games: ' + report.completed);
