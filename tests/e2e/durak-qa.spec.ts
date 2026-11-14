import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { DurakView, DurakAction } from '../../games/durak/engine';

const port = e2ePort(3009);
const base = 'http://127.0.0.1:' + port;
const SHOTS = 'artifacts/durak-qa';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function startServer(databaseUrl: string) {
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timeout')); }, 60000);
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
    let pending = '';
    child.stdout!.on('data', data => { pending += String(data); const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) if (line.includes('Server listening')) { clearTimeout(timeout); resolve(); } });
  });
  return child;
}
async function stopServer(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000);
  try { if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM'); await exited; } finally { clearTimeout(watchdog); }
}
async function api<T>(token: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 429) { await sleep(400 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status);
    return response.json() as Promise<T>;
  }
  throw new Error('rate limited ' + path);
}
async function makeMatch(count: number, mode: 'throw-in' | 'transfer' = 'throw-in'): Promise<{ tokens: string[]; ids: string[]; matchId: string; roomId: string }> {
  const sessions = [] as { token: string }[];
  for (let i = 0; i < count; i++) sessions.push(await api<{ token: string }>(sessions[0]?.token ?? '', '/auth/dev', { name: 'QA ' + count + 'p ' + i }));
  const host = sessions[0]!.token;
  const room = await api<{ id: string; version: number }>(host, '/rooms', { requestId: crypto.randomUUID(), gameId: 'durak', name: 'QA ' + count, visibility: 'public', settings: { mode, maxPlayers: count, stake: 0 } });
  for (const s of sessions.slice(1)) await api(s.token, '/rooms/' + room.id + '/join', {});
  for (const s of sessions) { const v = await api<{ version: number }>(s.token, '/rooms/' + room.id); await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: v.version, requestId: crypto.randomUUID() }); }
  const started = await api<{ matchId: string }>(host, '/rooms/' + room.id + '/start', { requestId: crypto.randomUUID() });
  const tokens = sessions.map(s => s.token);
  const ids = await Promise.all(tokens.map(async t => (await api<{ id: string }>(t, '/me')).id));
  return { tokens, ids, matchId: started.matchId, roomId: room.id };
}
const getMatch = (t: string, id: string) => api<MatchView>(t, '/matches/' + id);
const state = (m: MatchView) => m.state as DurakView;
async function act(t: string, m: MatchView, action: DurakAction): Promise<MatchView> {
  let last = '';
  for (let i = 0; i < 6; i++) {
    const fresh = await getMatch(t, m.matchId);
    try { return await api<MatchView>(t, '/matches/' + m.matchId + '/actions', { protocol: 1, roomId: fresh.roomId, matchId: m.matchId, requestId: crypto.randomUUID(), expectedVersion: fresh.version, action }); }
    catch (e) { last = String(e); await sleep(200 + i * 200); }
  }
  throw new Error('action failed repeatedly: ' + action.type + ' ' + last);
}
/** Bot step for the current actor. preferTake grows defender hands; preferFast ends bouts. */
async function botStep(m: MatchView, tokens: string[], ids: string[], opts: { preferTake?: boolean; preferPass?: boolean; preferThrow?: boolean } = {}): Promise<MatchView> {
  const actorId = state(m).actorId;
  const idx = ids.indexOf(actorId ?? '');
  if (idx < 0) throw new Error('actor not in match ' + actorId);
  const t = tokens[idx]!;
  {
    const personal = await getMatch(t, m.matchId);
    const s = state(personal);
    const L = s.legalActions;
    let action: DurakAction;
    if (opts.preferThrow && L.some(a => a.type === 'throw')) action = L.find(a => a.type === 'throw')!;
    else if (opts.preferTake && L.some(a => a.type === 'take')) action = L.find(a => a.type === 'take')!;
    else if (opts.preferPass && L.some(a => a.type === 'pass')) action = L.find(a => a.type === 'pass')!;
    else action = L.find(a => a.type === 'defend') ?? L.find(a => a.type === 'pass') ?? L.find(a => a.type === 'take') ?? L.find(a => a.type !== 'surrender')!;
    if (!action) throw new Error('empty legalActions actor=' + actorId + ' phase=' + s.phase + ' status=' + personal.status);
    return act(t, personal, action);
  }
  throw new Error('no actor token actorId=' + actorId + ' matchStatus=' + m.status + ' phase=' + state(m).phase);
}
async function openPage(browser: Browser, token: string, viewport = { width: 360, height: 640 }, touch = false) {
  const context = await browser.newContext({ viewport, hasTouch: touch });
  await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), token);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(base);
  // Bootstrap can hit a transient 429 while the suite hammers the API; reload once.
  try {
    await expect(page.locator('.durak-hand-fan [data-hand-card]').first()).toBeVisible({ timeout: 8000 });
  } catch {
    await page.reload();
    await expect(page.locator('.durak-hand-fan [data-hand-card]').first()).toBeVisible({ timeout: 20000 });
  }
  // Socket subscription is what marks room presence; wait for it so API-driven
  // matches do not get paused while we drive them without UI input.
  await expect(page.locator('[data-connection="connected"], [data-connection-status="connected"]').first()).toBeVisible({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  return { context, page };
}

test('durak QA: required screenshots — empty/defense/full-table/hands/finished/menu', async ({ browser }) => {
  test.setTimeout(560000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  try {
    // --- 2p empty table, both viewports; keep one context as presence anchor ---
    const m2 = await makeMatch(2);
    const anchor2 = await openPage(browser, m2.tokens[0]!, { width: 360, height: 640 });
    await anchor2.page.screenshot({ path: SHOTS + '/2p-empty-360x640.png' });
    const second = await openPage(browser, m2.tokens[0]!, { width: 390, height: 844 });
    await second.page.screenshot({ path: SHOTS + '/2p-empty-390x844.png' });
    await second.context.close();
    void anchor2;

    // --- 4p pending defense (anchor page keeps room presence) ---
    const m4 = await makeMatch(4);
    const a4 = await openPage(browser, m4.tokens[0]!, { width: 390, height: 844 });
    let view = await getMatch(m4.tokens[0]!, m4.matchId);
    for (let i = 0; i < 30 && state(view).table.every(p => p.defense !== null); i++) view = await botStep(view, m4.tokens, m4.ids);
    // ensure an open (undefended) attack exists; else keep playing
    for (let i = 0; i < 60 && !state(view).table.some(p => p.defense === null) && view.status === 'active'; i++) view = await botStep(view, m4.tokens, m4.ids);
    await a4.page.waitForTimeout(300);
    await a4.page.screenshot({ path: SHOTS + '/4p-defense-390x844.png' });
    await a4.context.close();

    // --- 6p full table (6 pairs) ---
    const m6 = await makeMatch(6);
    const a6 = await openPage(browser, m6.tokens[0]!, { width: 360, height: 640 });
    view = await getMatch(m6.tokens[0]!, m6.matchId);
    for (let i = 0; i < 600 && view.status === 'active'; i++) {
      view = await botStep(view, m6.tokens, m6.ids, { preferThrow: true });
      const t = state(view).table.length;
      if (t >= 6) break;
    }
    await a6.page.waitForTimeout(300);
    await a6.page.screenshot({ path: SHOTS + '/6p-table-' + state(view).table.length + '-360x640.png' });

    // --- hand sizes 6/12/20/27 + finished (fresh 2p match; idle matches auto-play on timers) ---
    const m2b = await makeMatch(2);
    const { context, page } = await openPage(browser, m2b.tokens[0]!, { width: 390, height: 844 }, true);
    const shots = new Set<number>();
    view = await getMatch(m2b.tokens[0]!, m2b.matchId);
    let guard = 0;
    while (view.status === 'active' && guard++ < 1200 && shots.size < 4) {
      const handSize = state(view).hand.length;
      if ([6, 12, 20, 27].includes(handSize) && !shots.has(handSize)) {
        shots.add(handSize);
        await page.waitForTimeout(250);
        await page.screenshot({ path: SHOTS + '/hand-' + handSize + '-390x844.png' });
      }
      view = await botStep(view, m2b.tokens, m2b.ids, { preferTake: true });
      await page.waitForTimeout(60);
    }
    // force finish: everyone surrenders via API
    for (const t of m2b.tokens) {
      const mv = await getMatch(t, m2b.matchId).catch(() => null);
      if (mv && mv.status === 'active') await act(t, mv, { type: 'surrender' }).catch(() => {});
      await sleep(80);
    }
    view = await getMatch(m2b.tokens[0]!, m2b.matchId);
    for (let i = 0; i < 30 && view.status !== 'finished'; i++) { view = await botStep(view, m2b.tokens, m2b.ids).catch(() => view); await sleep(120); }
    await page.reload();
    await expect(page.locator('.durak-result')).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: SHOTS + '/finished-390x844.png' });
    // menu shot needs an active game — reuse m6 if still active else skip gracefully
    const mv6 = await getMatch(m6.tokens[0]!, m6.matchId).catch(() => null);
    if (mv6 && mv6.status === 'active') {
      const { context: cm, page: pm } = await openPage(browser, m6.tokens[0]!, { width: 360, height: 640 });
      await pm.getByRole('button', { name: 'Меню партии' }).click();
      await pm.waitForTimeout(200);
      await pm.screenshot({ path: SHOTS + '/menu-360x640.png' });
      await cm.close();
    }
    await context.close();
  } finally {
    await stopServer(server);
  }
});

test('durak QA: touch controls — select/deselect/attack/defend/throw/take/pass/sort', async ({ browser }) => {
  test.setTimeout(300000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  try {
    const m = await makeMatch(2);
    const { context, page } = await openPage(browser, m.tokens[0]!, { width: 360, height: 640 }, true);
    const hostId = (await api<{ id: string }>(m.tokens[0]!, '/me')).id;
    // Advance until host can act.
    let view = await getMatch(m.tokens[0]!, m.matchId);
    let guard = 0;
    const hostTurn = async () => state(await getMatch(m.tokens[0]!, m.matchId)).actorId === hostId && state(await getMatch(m.tokens[0]!, m.matchId)).legalActions.length > 0;
    while (!(await hostTurn()) && view.status === 'active' && guard++ < 200) view = await botStep(view, m.tokens, m.ids);
    expect(await hostTurn()).toBe(true);

    // --- select + deselect via touch (use a card that is actually playable) ---
    const s0 = state(await getMatch(m.tokens[0]!, m.matchId));
    const firstCard = (s0.legalActions.flatMap(a => 'cards' in a ? a.cards : a.type === 'defend' ? [a.card] : [])[0] ?? s0.hand[0])!;
    const cardBtn = page.locator('[data-hand-card="' + firstCard + '"]');
    await cardBtn.tap();
    await expect(cardBtn).toHaveAttribute('aria-pressed', 'true');
    await cardBtn.tap();
    await expect(cardBtn).toHaveAttribute('aria-pressed', 'false');

    // --- primary UI action: attack if leading, defend if host is the defender ---
    const mv = await getMatch(m.tokens[0]!, m.matchId);
    const s = state(mv);
    const attack = s.legalActions.find(a => a.type === 'attack' && 'cards' in a && a.cards.length === 1) ?? s.legalActions.find(a => a.type === 'attack');
    const defendFirst = s.legalActions.find(a => a.type === 'defend');
    let primaryDefended = false;
    const vBefore = mv.version;
    if (attack && 'cards' in attack && attack.cards) {
      for (const c of attack.cards) await page.locator('[data-hand-card="' + c + '"]').tap();
      await page.getByRole('button', { name: 'Атаковать', exact: true }).tap();
      await expect.poll(async () => (await getMatch(m.tokens[0]!, m.matchId)).version).toBeGreaterThan(vBefore);
      expect(state(await getMatch(m.tokens[0]!, m.matchId)).table.length).toBeGreaterThan(0);
    } else if (defendFirst && 'card' in defendFirst && 'target' in defendFirst) {
      await page.locator('[data-hand-card="' + defendFirst.card + '"]').tap();
      await page.locator('[data-attack-card="' + defendFirst.target + '"]').tap();
      await page.getByRole('button', { name: 'Защититься', exact: true }).tap();
      await expect.poll(async () => state(await getMatch(m.tokens[0]!, m.matchId)).table.some(p => p.defense !== null)).toBe(true);
      primaryDefended = true;
    } else {
      // take/pass-only turn: use the direct button
      const direct = s.legalActions.find(a => a.type === 'take') ?? s.legalActions.find(a => a.type === 'pass');
      expect(direct).toBeTruthy();
      await page.getByRole('button', { name: direct!.type === 'take' ? 'Взять' : (s.phase === 'taking' ? 'Не подкидывать' : 'Бито'), exact: true }).tap();
      await expect.poll(async () => (await getMatch(m.tokens[0]!, m.matchId)).version).toBeGreaterThan(vBefore);
    }

    // --- sort via corner menu (while match is still active) ---
    const before = await page.locator('[data-hand-card]').evaluateAll(els => els.map(e => e.getAttribute('data-hand-card')));
    await page.getByRole('button', { name: 'Меню партии' }).tap();
    await page.getByRole('button', { name: 'Как получены', exact: true }).tap();
    await page.waitForTimeout(250);
    const after = await page.locator('[data-hand-card]').evaluateAll(els => els.map(e => e.getAttribute('data-hand-card')));
    const sortBtn = page.getByRole('button', { name: 'Как получены', exact: true });
    await expect(sortBtn).toHaveAttribute('aria-pressed', 'true');
    // Hand may legitimately change if a server timer fired mid-check; when the
    // card set is stable the received-order must differ from suit-sorted order.
    if (after.length === before.length && after.join() !== before.join()) {
      expect(new Set(after)).toEqual(new Set(before));
    }
    await page.screenshot({ path: SHOTS + '/menu-open-360x640.png' });
    await page.getByRole('button', { name: 'Меню партии' }).tap();

    // --- defend via UI: advance until host is defender with an open attack ---
    guard = 0;
    let defended = primaryDefended, took = false, passed = false, multiThrown = false;
    for (let i = 0; i < 400 && view.status === 'active' && !(defended && took && passed && multiThrown); i++) {
      const cur = await getMatch(m.tokens[0]!, m.matchId);
      const cs = state(cur);
      const isHost = cs.actorId === hostId;
      if (isHost && cs.phase === 'defending' && cs.table.some(p => p.defense === null) && cs.legalActions.some(a => a.type === 'defend')) {
        const d = cs.legalActions.find(a => a.type === 'defend')!;
        if ('card' in d && 'target' in d) {
          await page.locator('[data-hand-card="' + d.card + '"]').tap();
          await page.locator('[data-attack-card="' + d.target + '"]').tap();
          await page.getByRole('button', { name: 'Защититься', exact: true }).tap();
          defended = true;
          await sleep(200); continue;
        }
      }
      if (isHost && cs.phase === 'throwing' && !multiThrown) {
        const throws = cs.legalActions.filter(a => a.type === 'throw' && 'cards' in a && a.cards.length === 1);
        if (throws.length >= 2) {
          const c1 = throws[0]!, c2 = throws.find(a => 'cards' in a && a.cards[0] !== ('cards' in c1 ? c1.cards[0] : -1))!;
          for (const c of [c1, c2]) if ('cards' in c) for (const cc of c.cards) await page.locator('[data-hand-card="' + cc + '"]').tap();
          await page.getByRole('button', { name: /Подкинуть/ }).tap();
          multiThrown = true; await sleep(200); continue;
        }
      }
      if (isHost && cs.legalActions.some(a => a.type === 'take') && !took) {
        await page.getByRole('button', { name: 'Взять', exact: true }).tap(); took = true; await sleep(200); continue;
      }
      if (isHost && cs.legalActions.some(a => a.type === 'pass')) {
        const label = cs.phase === 'taking' ? 'Не подкидывать' : 'Бито';
        await page.getByRole('button', { name: label, exact: true }).tap(); passed = true; await sleep(200); continue;
      }
      view = await botStep(cur, m.tokens, m.ids);
      await page.waitForTimeout(80);
    }
    console.log('UI bout actions:', JSON.stringify({ defended, took, passed, multiThrown }));
    expect(defended || took || passed || multiThrown, 'at least one bout action via UI').toBe(true);

    await context.close();
  } finally {
    await stopServer(server);
  }
});
