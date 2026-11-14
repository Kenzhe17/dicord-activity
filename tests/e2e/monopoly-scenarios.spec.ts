import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import { createState, transition, applySystem } from '../../games/monopoly/engine';
import type { MonopolyAction, MonopolyState, MonopolyView } from '../../games/monopoly/engine';
import { BOARD, GROUPS, MAX_LEVEL, MIN_BID, BID_INCREMENT, mortgageValue, isPurchasable } from '../../games/monopoly/engine/board';

const port = e2ePort(3011);
const base = 'http://127.0.0.1:' + port;

// `pg` is only a dependency of apps/server (pnpm strict resolution), so load
// it through a require anchored at that package.
interface PgClientLike { connect(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void> }
const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { Client: PgClient } = serverRequire('pg') as { Client: new (opts: { connectionString: string }) => PgClientLike };

function databaseUrl() {
  const credentials = JSON.parse(readFileSync(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  return 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
}
function pgUrl() {
  const credentials = JSON.parse(readFileSync(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  return 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase();
}
async function start() {
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl(), ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let pendingLog = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timeout')); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
    child.stdout!.on('data', data => {
      pendingLog += String(data);
      const lines = pendingLog.split('\n'); pendingLog = lines.pop() ?? '';
      for (const line of lines) if (line.includes('Server listening')) { clearTimeout(timeout); resolve(); }
    });
  });
  return child;
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    try { if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM'); }
    catch { child.kill('SIGKILL'); }
    await exited;
  } finally { clearTimeout(watchdog); }
}
interface Session { token: string; player: { id: string } }
async function api<T>(token: string | null, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status + ' ' + (await response.text()).slice(0, 200));
  return response.json() as Promise<T>;
}

/* ==================== Offline journal crafting ====================
 * The match checkpoint cannot be hand-edited: restoreMatch replays the
 * action journal and requires canonical(serialized) to equal the replayed
 * state. Instead we generate a VALID journal offline: rebuild the identical
 * initial state (same settings/players/seed/startedAt) and drive it with
 * legal engine transitions under a fixed policy until a goal predicate
 * holds, recording every applied action. Writing the checkpoint back makes
 * the server restore exactly the crafted state.
 */

const BUILDER = 0, DEBTOR = 1;
const BROWN = [1, 3];
const DEBTOR_BUYS_C = new Set([6, 8, 9]);
const DEBTOR_BUYS_D = new Set([6, 8]);
const BUILDER_BUYS_A = new Set([1, 3, 6, 8, 9]);

interface CraftOpts {
  scenario: 'A' | 'C' | 'D' | 'E';
  players: string[];
  settings: Record<string, unknown>;
  startedAt: number;
  seed: number;
}
interface JournalEntry { actor: string; action: MonopolyAction }
interface CraftResult { ok: boolean; state: MonopolyState; journal: JournalEntry[]; reason: string; group?: number[] | undefined }

function craftBankOf(s: MonopolyState, seat: number) { return s.seatBank[seat]!; }
function craftBalance(s: MonopolyState, seat: number) { return s.banks[craftBankOf(s, seat)]!; }
function minNextBid(s: MonopolyState) { const a = s.auction!; return a.currentBid === 0 ? MIN_BID : a.currentBid + BID_INCREMENT; }

function buildableProps(s: MonopolyState, seat: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 40; i++) {
    const def = BOARD[i]!.property;
    if (!def || def.kind !== 'property' || def.houseCost === 0) continue;
    const prop = s.properties[i]!;
    if (prop.owner !== craftBankOf(s, seat) || prop.mortgaged || prop.level >= MAX_LEVEL) continue;
    const group = GROUPS.find(g => g.id === def.group);
    if (!group || !group.indices.every(j => s.properties[j]!.owner === craftBankOf(s, seat))) continue;
    if (group.indices.some(j => s.properties[j]!.mortgaged)) continue;
    if (s.evenBuild) {
      const min = Math.min(...group.indices.map(j => s.properties[j]!.level));
      if (prop.level > min) continue;
    }
    if (s.banks[craftBankOf(s, seat)]! < def.houseCost) continue;
    out.push(i);
  }
  return out;
}
function brownMinLevel(s: MonopolyState): number {
  return Math.min(...BROWN.map(i => s.properties[i]!.level));
}
function peekRoll(s: MonopolyState, seat: number, now: number): MonopolyState | null {
  try { return transition(s, { type: 'roll' }, s.players[seat]!, now); } catch { return null; }
}
function liquidationOutcome(debtState: MonopolyState, seat: number): 'payable' | 'bankrupt' | 'stuck' {
  try {
    const t = applySystem(debtState, { type: 'timeout' }, debtState.deadline + 1);
    if (t.seats[seat]!.out) return 'bankrupt';
    if (t.phase === 'debt') return 'stuck';
    return 'payable';
  } catch { return 'stuck'; }
}

interface DriverOpts {
  debtorBuys: Set<number>;
  builderBuys: Set<number> | 'all';
  buildTarget: number;
  debtorTargetBalance: number;
  maxSteps: number;
}
function driverOpts(scenario: CraftOpts['scenario']): DriverOpts {
  const base: DriverOpts = { debtorBuys: new Set(), builderBuys: 'all', buildTarget: 3, debtorTargetBalance: scenario === 'D' ? 10 : 30, maxSteps: 2500 };
  if (scenario === 'A') base.builderBuys = BUILDER_BUYS_A;
  if (scenario === 'C' || scenario === 'D') base.builderBuys = new Set(BROWN);
  if (scenario === 'C') base.debtorBuys = DEBTOR_BUYS_C;
  if (scenario === 'D') base.debtorBuys = DEBTOR_BUYS_D;
  return base;
}

function craftDecide(s: MonopolyState, opts: DriverOpts, players: string[], scenario: CraftOpts['scenario'], dumped: { v: boolean }): { actor: string; action: MonopolyAction } | 'STOP' | null {
  // Auto-accept trades addressed to the builder seat (our dump offers).
  if (s.phase !== 'auction' && s.phase !== 'finished') {
    const offer = s.trades.find(t => t.to === BUILDER);
    if (offer) return { actor: players[BUILDER]!, action: { type: 'accept', offerId: offer.id } };
  }
  if (s.phase === 'finished') return 'STOP';
  const turn = s.turn;
  const actor = players[turn]!;
  switch (s.phase) {
    case 'awaitRoll': {
      const p = s.seats[turn]!;
      if (p.inJail) {
        if (p.jailTurns >= 3) {
          if (craftBalance(s, turn) >= 50) return { actor, action: { type: 'payJail' } };
          if (p.getOutCards > 0) return { actor, action: { type: 'jailCard' } };
          return null;
        }
        if (craftBalance(s, turn) >= 50 && scenario !== 'A') return { actor, action: { type: 'payJail' } };
        return { actor, action: { type: 'roll' } };
      }
      return { actor, action: { type: 'roll' } };
    }
    case 'buy': {
      const idx = (s.pending as { index: number }).index;
      const price = BOARD[idx]!.property!.price;
      if (turn === BUILDER) {
        const take = opts.builderBuys === 'all' ? craftBalance(s, turn) >= price : opts.builderBuys.has(idx) && craftBalance(s, turn) >= price;
        return { actor, action: take ? { type: 'buy' } : { type: 'refuse' } };
      }
      if (turn === DEBTOR) {
        const take = opts.debtorBuys.has(idx) && craftBalance(s, turn) >= price;
        return { actor, action: take ? { type: 'buy' } : { type: 'refuse' } };
      }
      return { actor, action: { type: 'refuse' } };
    }
    case 'auction': {
      const a = s.auction!;
      const order = [BUILDER, DEBTOR].filter(b => b < s.banks.length);
      for (const b of order) {
        const seat = s.bankMembers[b]![0]!;
        if (s.seats[seat]!.out) continue;
        if (a.passed.includes(b) || a.leader === b) continue;
        const pid = players[seat]!;
        if (b === BUILDER && (opts.builderBuys === 'all' || opts.builderBuys.has(a.index))) {
          const amount = minNextBid(s);
          if (amount <= s.banks[b]!) return { actor: pid, action: { type: 'bid', amount } };
        }
        return { actor: pid, action: { type: 'pass' } };
      }
      return null;
    }
    case 'awaitEnd': {
      if (turn === BUILDER && (scenario === 'C' || scenario === 'D')) {
        const bp = buildableProps(s, turn);
        if (bp.length && brownMinLevel(s) < opts.buildTarget) {
          const pick = bp.includes(1) ? 1 : bp.includes(3) ? 3 : bp[0]!;
          return { actor, action: { type: 'build', property: pick } };
        }
      }
      if (turn === DEBTOR && (scenario === 'C' || scenario === 'D') && !dumped.v && brownMinLevel(s) >= opts.buildTarget) {
        const verdict = craftPeekDebtorDebt(s, opts, players, scenario);
        if (verdict === scenario) {
          const give = craftBalance(s, turn) - opts.debtorTargetBalance;
          if (give > 0) {
            dumped.v = true;
            return { actor, action: { type: 'offer', to: players[BUILDER]!, giveMoney: give, giveProps: [], getMoney: 0, getProps: [] } };
          }
        }
      }
      return { actor, action: { type: 'endTurn' } };
    }
    case 'debt': {
      const d = s.pending as { forSeat: number };
      const fs = d.forSeat;
      const fact = players[fs]!;
      const fbank = craftBankOf(s, fs);
      for (let i = 0; i < 40; i++) {
        const p = s.properties[i]!;
        if (p.owner === fbank && p.level > 0) return { actor: fact, action: { type: 'sell', property: i } };
      }
      for (let i = 0; i < 40; i++) {
        const p = s.properties[i]!;
        if (p.owner === fbank && !p.mortgaged && p.level === 0 && isPurchasable(i)) return { actor: fact, action: { type: 'mortgage', property: i } };
      }
      return null;
    }
  }
  return null;
}

function craftPeekDebtorDebt(s: MonopolyState, opts: DriverOpts, players: string[], scenario: CraftOpts['scenario']): 'C' | 'D' | 'none' {
  let clone = structuredClone(s);
  const give = craftBalance(clone, DEBTOR) - opts.debtorTargetBalance;
  if (give <= 0) return 'none';
  let now = 1_000_000;
  try {
    clone = transition(clone, { type: 'offer', to: players[BUILDER]!, giveMoney: give, giveProps: [], getMoney: 0, getProps: [] }, players[DEBTOR]!, now);
    const offer = clone.trades.find(t => t.to === BUILDER);
    if (!offer) return 'none';
    clone = transition(clone, { type: 'accept', offerId: offer.id }, players[BUILDER]!, now + 1);
    clone = transition(clone, { type: 'endTurn' }, players[DEBTOR]!, now + 2);
  } catch { return 'none'; }
  now += 3000;
  const dumped = { v: true };
  for (let i = 0; i < 400; i++) {
    if (clone.phase === 'awaitRoll' && clone.turn === DEBTOR && !clone.seats[DEBTOR]!.inJail) {
      const rolled = peekRoll(clone, DEBTOR, now);
      if (!rolled || rolled.phase !== 'debt') return 'none';
      const d = rolled.pending;
      if (!d || d.type !== 'debt' || d.creditor !== BUILDER) return 'none';
      const outcome = liquidationOutcome(rolled, DEBTOR);
      if (outcome === 'payable') return 'C';
      if (outcome === 'bankrupt') return 'D';
      return 'none';
    }
    const step = craftDecide(clone, opts, players, scenario, dumped);
    if (step === 'STOP' || step === null) return 'none';
    try {
      clone = transition(clone, step.action, step.actor, now);
    } catch { return 'none'; }
    now += 1000;
  }
  return 'none';
}

function craftGoalMet(s: MonopolyState, scenario: CraftOpts['scenario']): { ok: boolean; group?: number[] } {
  if (scenario === 'A') {
    if (s.phase !== 'awaitRoll' && s.phase !== 'awaitEnd') return { ok: false };
    if (s.turn !== BUILDER) return { ok: false };
    const bank = craftBankOf(s, BUILDER);
    for (const g of GROUPS) {
      if (!g.indices.every(i => s.properties[i]!.owner === bank)) continue;
      if (g.indices.some(i => s.properties[i]!.mortgaged || s.properties[i]!.level !== 0)) continue;
      const cost = g.indices.reduce((sum, i) => sum + BOARD[i]!.property!.houseCost * MAX_LEVEL, 0);
      if (s.banks[bank]! >= cost + 50) return { ok: true, group: [...g.indices] };
    }
    return { ok: false };
  }
  if (scenario === 'C' || scenario === 'D') {
    if (s.phase !== 'awaitRoll' || s.turn !== DEBTOR || s.seats[DEBTOR]!.inJail) return { ok: false };
    const rolled = peekRoll(s, DEBTOR, s.deadline - 1);
    if (!rolled || rolled.phase !== 'debt') return { ok: false };
    const d = rolled.pending;
    if (!d || d.type !== 'debt' || d.creditor !== BUILDER) return { ok: false };
    const outcome = liquidationOutcome(rolled, DEBTOR);
    if (scenario === 'C' && outcome !== 'payable') return { ok: false };
    if (scenario === 'D' && outcome !== 'bankrupt') return { ok: false };
    if (scenario === 'D') {
      const fbank = craftBankOf(s, DEBTOR);
      let has = false;
      for (let i = 0; i < 40; i++) {
        const p = s.properties[i]!;
        if (p.owner === fbank && !p.mortgaged && p.level === 0 && isPurchasable(i)) { has = true; break; }
      }
      if (!has) return { ok: false };
    }
    return { ok: true };
  }
  return { ok: s.phase === 'awaitRoll' };
}

function craftDrive(opts: CraftOpts, driver: DriverOpts): CraftResult {
  const state0 = createState(opts.settings, { players: opts.players, seed: opts.seed, startedAt: opts.startedAt });
  let state = state0;
  const journal: JournalEntry[] = [];
  const dumped = { v: false };
  const goalAfter = opts.scenario === 'E' ? 200 : driver.maxSteps;
  let group: number[] | undefined;
  for (let i = 0; i < goalAfter; i++) {
    const g = (opts.scenario === 'E' && journal.length < 60) ? { ok: false, group: undefined } : craftGoalMet(state, opts.scenario);
    if (g.ok) { group = g.group; return { ok: true, state, journal, reason: 'goal', group }; }
    const now = opts.startedAt + (journal.length + 1) * 1000;
    const step = craftDecide(state, driver, opts.players, opts.scenario, dumped);
    if (step === 'STOP' || step === null) return { ok: false, state, journal, reason: 'no-action' };
    try {
      state = transition(state, step.action, step.actor, now);
    } catch (e) {
      return { ok: false, state, journal, reason: 'illegal:' + String(e).slice(0, 120) };
    }
    journal.push({ actor: step.actor, action: step.action });
    if (journal.length >= driver.maxSteps) break;
  }
  const g = craftGoalMet(state, opts.scenario);
  if (g.ok) { group = g.group; return { ok: true, state, journal, reason: 'goal-end', group }; }
  return { ok: false, state, journal, reason: 'cap phase=' + state.phase + ' turn=' + state.turn };
}

/** Pick a seed that reaches the scenario goal, then write the crafted
 * checkpoint (version/seed/serialized/actions) into arcade."MatchSnapshot". */
async function craftMatch(matchId: string, scenario: CraftOpts['scenario'], preferredSeed: number): Promise<{ state: MonopolyState; journalLength: number; seed: number }> {
  const client = new PgClient({ connectionString: pgUrl() });
  await client.connect();
  try {
    const res = await client.query('SELECT state, version FROM arcade."MatchSnapshot" WHERE id = $1', [matchId]);
    if (res.rows.length !== 1) throw new Error('MatchSnapshot row not found for ' + matchId);
    const checkpoint = res.rows[0]!.state as Record<string, unknown>;
    const context = checkpoint.context as { players: string[]; seed: number; startedAt: number; hostId?: string };
    const settings = checkpoint.settings as Record<string, unknown>;
    const driver = driverOpts(scenario);
    let crafted: CraftResult | null = null;
    let usedSeed = preferredSeed;
    for (const seed of [preferredSeed, ...Array.from({ length: 120 }, (_, i) => i + 1).filter(s => s !== preferredSeed)]) {
      const r = craftDrive({ scenario, players: context.players, settings, startedAt: context.startedAt, seed }, driver);
      if (r.ok) { crafted = r; usedSeed = seed; break; }
    }
    if (!crafted) throw new Error('crafting failed for scenario ' + scenario);
    const n = crafted.journal.length;
    const startedAt = context.startedAt;
    const actions = crafted.journal.map((entry, i) => ({
      requestId: randomUUID(), actorId: entry.actor, version: i + 1,
      now: startedAt + (i + 1) * 1000, action: entry.action,
    }));
    const nextCheckpoint = {
      ...checkpoint,
      version: n,
      seed: usedSeed,
      serialized: JSON.stringify(crafted.state),
      context: { ...context, seed: usedSeed },
      actions,
    };
    await client.query('UPDATE arcade."MatchSnapshot" SET version = $2, seed = $3, state = $4::jsonb WHERE id = $1', [matchId, n, usedSeed, JSON.stringify(nextCheckpoint)]);
    return { state: crafted.state, journalLength: n, seed: usedSeed };
  } finally {
    await client.end();
  }
}

/* ==================== Shared scenario setup ==================== */

const SETTINGS = { mode: 'classic', maxPlayers: 2, startMoney: 1500, turnSeconds: 180, auctionSeconds: 120, tradeSeconds: 300, evenBuild: true };

interface Fixture {
  server: Awaited<ReturnType<typeof start>>;
  sessions: Session[];
  host: string;
  room: { id: string };
  matchId: string;
  contexts: BrowserContext[];
  pages: Page[];
}

async function newMatch(): Promise<Fixture> {
  const server = await start();
  const sessions = await Promise.all([api<Session>(null, '/auth/dev', { name: 'Scen A' }), api<Session>(null, '/auth/dev', { name: 'Scen B' })]);
  const host = sessions[0]!.token;
  const room = await api<{ id: string }>(host, '/rooms', { requestId: randomUUID(), gameId: 'monopoly', name: 'Scenarios', visibility: 'private', settings: SETTINGS });
  const invite = await api<{ code: string }>(host, '/rooms/' + room.id + '/invite', {});
  await api(sessions[1]!.token, '/rooms/' + room.id + '/join', { inviteToken: invite.code.split(':')[1]! });
  for (const s of sessions) {
    const v = await api<{ version: number }>(s.token, '/rooms/' + room.id);
    await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: v.version, requestId: randomUUID() });
  }
  const match = await api<MatchView>(host, '/rooms/' + room.id + '/start', { requestId: randomUUID() });
  return { server: await server, sessions, host, room, matchId: match.matchId, contexts: [], pages: [] };
}

async function openPages(browser: Browser, fx: Fixture): Promise<void> {
  for (const s of fx.sessions) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    fx.contexts.push(context);
    await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), s.token);
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    await page.goto(base);
    await expect(page.locator('.mono-board')).toBeVisible();
    fx.pages.push(page);
  }
}

function tokenOf(fx: Fixture, playerId: string) {
  return fx.sessions.find(s => s.player.id === playerId)!.token;
}
function pageOf(fx: Fixture, playerId: string) {
  return fx.pages[fx.sessions.findIndex(s => s.player.id === playerId)]!;
}
async function serverView(fx: Fixture, playerId?: string): Promise<MatchView> {
  return api<MatchView>(playerId ? tokenOf(fx, playerId) : fx.host, '/matches/' + fx.matchId);
}
/** The public per-player view — NOT the raw engine state. */
function viewState(view: MatchView): MonopolyView {
  return view.state as unknown as MonopolyView;
}

async function cleanup(fx: Fixture) {
  await stop(fx.server);
  await Promise.all(fx.contexts.map(c => c.close()));
}

/** Click a board cell by name, then click a manage/action button inside the modal. */
async function modalAction(page: Page, cellName: string, button: RegExp | string) {
  await page.locator('.mono-modal-close').click({ timeout: 2000 }).catch(() => {});
  await page.getByRole('button', { name: cellName, exact: true }).click();
  await expect(page.locator('.mono-modal')).toBeVisible();
  await page.getByRole('button', { name: button }).click();
}

/* ==================== Tests ==================== */

test('monopoly scenarios: build to hotel and sell back down via UI', async ({ browser }) => {
  test.setTimeout(300000);
  const fx = await newMatch();
  try {
    const crafted = await craftMatch(fx.matchId, 'A', 5);
    console.log('  craft A: seed=' + crafted.seed + ' steps=' + crafted.journalLength);
    await openPages(browser, fx);
    const state = crafted.state;
    const builderId = state.players[BUILDER]!;
    const builderBank = state.seatBank[BUILDER]!;
    const builderPage = pageOf(fx, builderId);

    // Find the complete colour group the crafted state gives the builder.
    let group: number[] | null = null;
    for (const g of GROUPS) {
      if (g.indices.every(i => state.properties[i]!.owner === builderBank) && g.indices.every(i => state.properties[i]!.level === 0 && !state.properties[i]!.mortgaged)) { group = [...g.indices]; break; }
    }
    expect(group, 'crafted state must contain a complete unmortgaged group').not.toBeNull();
    const houseCost = BOARD[group![0]!]!.property!.houseCost;

    const balance = async () => viewState(await serverView(fx)).banks[builderBank]!.balance;
    const level = async (i: number) => viewState(await serverView(fx)).properties[i]!.level;

    // Build every group property up to MAX_LEVEL (hotel), verifying each step.
    for (let lvl = 0; lvl < MAX_LEVEL; lvl++) {
      for (const idx of group!) {
        const before = await balance();
        await modalAction(builderPage, BOARD[idx]!.name, /Построить/);
        await expect.poll(async () => level(idx), { timeout: 8000 }).toBe(lvl + 1);
        await expect.poll(async () => balance(), { timeout: 8000 }).toBe(before - houseCost);
      }
    }
    for (const idx of group!) expect(await level(idx)).toBe(MAX_LEVEL);

    // Sell every building back down, verifying level and half-price refund.
    const refund = Math.floor(houseCost / 2);
    for (const idx of group!) {
      for (let lvl = MAX_LEVEL; lvl > 0; lvl--) {
        const before = await balance();
        await modalAction(builderPage, BOARD[idx]!.name, /Продать постройку/);
        await expect.poll(async () => level(idx), { timeout: 8000 }).toBe(lvl - 1);
        await expect.poll(async () => balance(), { timeout: 8000 }).toBe(before + refund);
      }
      expect(await level(idx)).toBe(0);
    }
    const finalState = viewState(await serverView(fx));
    for (const idx of group!) {
      expect(finalState.properties[idx]!.level).toBe(0);
      expect(finalState.properties[idx]!.mortgaged).toBe(false);
      expect(finalState.properties[idx]!.owner).toBe(builderBank);
    }
  } finally {
    await cleanup(fx);
  }
});

test('monopoly scenarios: rent debt is liquidated through the UI', async ({ browser }) => {
  test.setTimeout(300000);
  const fx = await newMatch();
  try {
    const crafted = await craftMatch(fx.matchId, 'C', 3);
    console.log('  craft C: seed=' + crafted.seed + ' steps=' + crafted.journalLength);
    const state = crafted.state;
    const debtorId = state.players[DEBTOR]!;
    const debtorBank = state.seatBank[DEBTOR]!;
    const builderBank = state.seatBank[BUILDER]!;
    await openPages(browser, fx);
    const debtorPage = pageOf(fx, debtorId);

    // Sanity: it is the debtor's awaitRoll and the crafted roll opens a payable debt to the builder.
    const preState = viewState(await serverView(fx, debtorId));
    expect(preState.phase).toBe('awaitRoll');
    expect(preState.turnSeat).toBe(DEBTOR);
    expect(preState.turnPlayerId).toBe(debtorId);

    // Roll through the real UI — deterministic dice land on the builder's hotel.
    await debtorPage.getByRole('button', { name: 'Бросить кубики' }).click();
    await expect.poll(async () => {
      const s = viewState(await serverView(fx, debtorId));
      return s.phase === 'debt' ? s : null;
    }, { timeout: 20000 }).not.toBeNull();
    const debtState = viewState(await serverView(fx, debtorId));
    expect(debtState.pending?.type).toBe('debt');
    const pending = debtState.pending as { amount: number; creditor: number | null };
    expect(pending.creditor).toBe(builderBank);
    const debtAmount = pending.amount;
    const debtorBalBefore = debtState.banks[debtorBank]!.balance;
    const builderBalBefore = debtState.banks[builderBank]!.balance;
    expect(debtorBalBefore).toBeLessThan(debtAmount);
    await expect(debtorPage.locator('.mono-debt-note')).toBeVisible();

    // Liquidate through the UI: mortgage debtor properties until the debt settles.
    const mortgaged: number[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const s = viewState(await serverView(fx));
      if (s.phase !== 'debt') break;
      const next = s.properties.findIndex((p, i) => p.owner === debtorBank && !p.mortgaged && p.level === 0 && isPurchasable(i));
      expect(next, 'debtor must have a mortgageable property left').toBeGreaterThanOrEqual(0);
      await modalAction(debtorPage, BOARD[next]!.name, /Заложить/);
      await expect.poll(async () => viewState(await serverView(fx)).properties[next]!.mortgaged, { timeout: 8000 }).toBe(true);
      mortgaged.push(next);
    }
    const settled = viewState(await serverView(fx));
    expect(settled.phase).not.toBe('debt');
    expect(settled.pending).toBeNull();
    const expectedDebtBalance = debtorBalBefore + mortgaged.reduce((sum, i) => sum + mortgageValue(BOARD[i]!.property!.price), 0) - debtAmount;
    expect(settled.banks[debtorBank]!.balance).toBe(expectedDebtBalance);
    expect(settled.banks[builderBank]!.balance).toBe(builderBalBefore + debtAmount);
    expect(settled.properties[mortgaged[0]!]!.owner).toBe(debtorBank);
  } finally {
    await cleanup(fx);
  }
});

test('monopoly scenarios: unpayable debt ends in bankruptcy and finished match', async ({ browser }) => {
  test.setTimeout(300000);
  const fx = await newMatch();
  try {
    const crafted = await craftMatch(fx.matchId, 'D', 78);
    console.log('  craft D: seed=' + crafted.seed + ' steps=' + crafted.journalLength);
    const state = crafted.state;
    const debtorId = state.players[DEBTOR]!;
    const builderId = state.players[BUILDER]!;
    const debtorBank = state.seatBank[DEBTOR]!;
    const builderBank = state.seatBank[BUILDER]!;
    const debtorPropsBefore = state.properties.map((p, i) => p.owner === debtorBank ? i : -1).filter(i => i >= 0);
    await openPages(browser, fx);
    const debtorPage = pageOf(fx, debtorId);
    const builderPage = pageOf(fx, builderId);

    await debtorPage.getByRole('button', { name: 'Бросить кубики' }).click();
    await expect.poll(async () => {
      const s = viewState(await serverView(fx));
      return s.phase === 'debt' ? s.pending : null;
    }, { timeout: 20000 }).not.toBeNull();
    const pending = viewState(await serverView(fx)).pending as { amount: number; creditor: number | null };
    expect(pending.creditor).toBe(builderBank);

    // Liquidate everything available through the UI — the debt must stay open.
    for (let guard = 0; guard < 8; guard++) {
      const s = viewState(await serverView(fx));
      if (s.phase !== 'debt') break;
      const next = s.properties.findIndex((p, i) => p.owner === debtorBank && !p.mortgaged && p.level === 0 && isPurchasable(i));
      if (next < 0) break;
      await modalAction(debtorPage, BOARD[next]!.name, /Заложить/);
      await expect.poll(async () => viewState(await serverView(fx)).properties[next]!.mortgaged, { timeout: 8000 }).toBe(true);
    }
    expect(viewState(await serverView(fx)).phase).toBe('debt');

    // Surrender through the UI menu — the only UI escape from an unpayable debt.
    await debtorPage.getByRole('button', { name: 'Меню партии' }).click();
    await debtorPage.getByRole('button', { name: 'Сдаться' }).click();
    await debtorPage.getByRole('button', { name: /Точно сдаться/ }).click();
    await expect.poll(async () => (await serverView(fx)).status, { timeout: 15000 }).toBe('finished');

    const view = await serverView(fx, builderId);
    expect(view.status).toBe('finished');
    expect(view.result).not.toBeNull();
    expect(view.result!.winners).toEqual([builderId]);
    expect(view.result!.losers).toContain(debtorId);
    const finalState = viewState(view);
    const debtorView = finalState.players.find(p => p.id === debtorId)!;
    expect(debtorView.out).toBe(true);
    expect(finalState.banks[debtorBank]!.balance).toBe(0);
    // Surrender (creditor = bank) returns the debtor's property to the bank pool.
    for (const i of debtorPropsBefore) expect(finalState.properties[i]!.owner).toBeNull();

    // The finished match stays attached to the room for result reload; room waits for a rematch.
    const room = await api<{ phase: string; matchId: string | null }>(fx.host, '/rooms/' + fx.room.id);
    expect(room.phase).toBe('waiting');
    expect(room.matchId).toBe(fx.matchId);
    await expect(builderPage.locator('.mono-result')).toBeVisible();
    await expect(builderPage.getByRole('heading', { name: 'Победа!' })).toBeVisible();
  } finally {
    await cleanup(fx);
  }
});

test('monopoly scenarios: surrender finishes the match and the room returns to the rematch lobby', async ({ browser }) => {
  test.setTimeout(300000);
  const fx = await newMatch();
  try {
    const crafted = await craftMatch(fx.matchId, 'E', 2);
    console.log('  craft E: seed=' + crafted.seed + ' steps=' + crafted.journalLength);
    const state = crafted.state;
    const debtorId = state.players[DEBTOR]!;
    const builderId = state.players[BUILDER]!;
    await openPages(browser, fx);
    const debtorPage = pageOf(fx, debtorId);
    const builderPage = pageOf(fx, builderId);

    // Mid-game crafted state: surrender by the guest ends the match immediately.
    await debtorPage.getByRole('button', { name: 'Меню партии' }).click();
    await debtorPage.getByRole('button', { name: 'Сдаться' }).click();
    await debtorPage.getByRole('button', { name: /Точно сдаться/ }).click();
    await expect.poll(async () => (await serverView(fx)).status, { timeout: 15000 }).toBe('finished');

    const view = await serverView(fx, builderId);
    expect(view.status).toBe('finished');
    expect(view.result!.winners).toEqual([builderId]);
    const room = await api<{ phase: string; matchId: string | null }>(fx.host, '/rooms/' + fx.room.id);
    expect(room.phase).toBe('waiting');
    expect(room.matchId).toBe(fx.matchId);

    // Rematch lobby: both players ready up through the result UI, host starts a new match.
    for (const page of [builderPage, debtorPage]) {
      await page.locator('.mono-result').getByRole('button', { name: 'Я готов — реванш' }).click();
    }
    await expect.poll(async () => {
      const r = await api<{ members: { ready: boolean }[] }>(fx.host, '/rooms/' + fx.room.id);
      return r.members.every(m => m.ready);
    }, { timeout: 15000 }).toBe(true);
    const startBtn = builderPage.locator('.mono-result').getByRole('button', { name: 'Начать партию' });
    await expect(startBtn).toBeEnabled({ timeout: 15000 });
    await startBtn.click();
    await expect.poll(async () => {
      const r = await api<{ phase: string; matchId: string | null }>(fx.host, '/rooms/' + fx.room.id);
      return r.matchId !== null && r.matchId !== fx.matchId ? r.matchId : null;
    }, { timeout: 15000 }).not.toBeNull();
    const fresh = await api<MatchView>(fx.host, '/matches/' + (await api<{ matchId: string }>(fx.host, '/rooms/' + fx.room.id)).matchId!);
    expect(fresh.status).toBe('active');
    expect(viewState(fresh).phase).toBe('awaitRoll');
  } finally {
    await cleanup(fx);
  }
});
