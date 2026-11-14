import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { MonopolyView } from '../../games/monopoly/engine';

test('monopoly: board, turns, purchases, reconnect and real backend restart', async ({ browser }) => {
  test.setTimeout(180000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const port = e2ePort(3003);
  const base = 'http://127.0.0.1:' + port;
  async function start() {
    const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      try { if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM'); }
      catch { child.kill('SIGKILL'); }
      await exited;
    } finally { clearTimeout(watchdog); }
  }
  let server = await start();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const [a, b] = pages as [Page, Page];
  for (const page of pages) page.setDefaultTimeout(15000);
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    const token = sessionStorage.getItem('rize.arcade.session');
    const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('API request ' + response.status);
    return response.json();
  }, { path, body });
  const matchView = async (page: Page, matchId: string) => request<MatchView>(page, '/matches/' + matchId);
  try {
    for (const [i, page] of pages.entries()) {
      await page.goto(base); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Монополия E2E ' + i);
      await page.getByRole('button', { name: 'Войти локально' }).click(); await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    }
    await a.getByRole('button', { name: /Монополия/ }).click(); await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await a.getByLabel('Игроков Monopoly').selectOption('2');
    await a.getByRole('textbox', { name: 'Название комнаты' }).fill('Недвижимость');
    await a.getByLabel('Приватная комната').check(); await a.getByRole('button', { name: 'Создать лобби' }).click();
    await a.getByRole('button', { name: 'Создать приглашение' }).click(); const code = await a.locator('.invite-code').inputValue();
    await b.getByRole('button', { name: 'Комнаты', exact: true }).click(); await b.getByRole('textbox', { name: 'Войти по коду' }).fill(code); await b.getByRole('button', { name: 'Присоединиться' }).click();
    for (const page of pages) await page.getByRole('button', { name: 'Я готов', exact: true }).click();
    await a.getByRole('button', { name: 'Начать партию' }).click();
    await Promise.all(pages.map(page => expect(page.locator('.mono-board')).toBeVisible()));
    await expect(a.locator('.mono-cell')).toHaveCount(40);
    await expect(a.locator('.mono-player')).toHaveCount(2);
    const bootstraps = await Promise.all(pages.map(p => request<{ session: { player: { id: string } }; match: MatchView }>(p, '/bootstrap')));
    const matchId = bootstraps[0]!.match.matchId;
    const pageOf = (playerId: string) => bootstraps.findIndex(x => x.session.player.id === playerId);
    let view = bootstraps[0]!.match;
    const initial = view.state as MonopolyView;
    for (const key of ['decks', 'seed', 'context', 'actions', 'rng']) expect(initial).not.toHaveProperty(key);
    expect(initial.deckCounts.chance + initial.deckCounts.community).toBe(32);
    await a.screenshot({ path: 'tests/.artifacts/monopoly-desktop.png', fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/monopoly-mobile.png', fullPage: true });
    await a.setViewportSize({ width: 1280, height: 900 });

    // Drive real turns through the UI for a bounded number of steps.
    let steps = 0, bought = false, restarted = false;
    while (view.status === 'active' && steps++ < 14) {
      const state = view.state as MonopolyView;
      const actorPage = pages[pageOf(state.turnPlayerId)]!;
      const prior = view.version;
      if (state.phase === 'awaitRoll' && !state.players[pageOf(state.turnPlayerId)]!.inJail) {
        await actorPage.getByRole('button', { name: 'Бросить кубики' }).click();
      } else if (state.phase === 'awaitRoll') {
        // Jail: prefer paying bail to keep the game moving.
        const pay = actorPage.getByRole('button', { name: /Заплатить 50/ });
        if (await pay.isVisible()) await pay.click(); else await actorPage.getByRole('button', { name: /Бросить дубли|Пропуск/ }).first().click();
      } else if (state.phase === 'buy') {
        const buyBtn = actorPage.getByRole('button', { name: /Купить за/ });
        if (!bought && (await buyBtn.isVisible())) { await buyBtn.click(); bought = true; }
        else await actorPage.getByRole('button', { name: /Отказаться/ }).click();
      } else if (state.phase === 'awaitEnd') {
        await actorPage.getByRole('button', { name: 'Завершить ход' }).click();
      } else if (state.phase === 'auction') {
        const pass = actorPage.getByRole('button', { name: 'Пас', exact: true });
        if (await pass.isVisible()) await pass.click(); else break;
      } else break;
      await expect.poll(async () => (await matchView(actorPage, matchId)).version).toBeGreaterThan(prior);
      view = await matchView(actorPage, matchId);
      if (steps === 6 && !restarted) {
        restarted = true;
        const before = view;
        await stop(server);
        server = await start();
        await Promise.all(pages.map(p => p.reload()));
        await Promise.all(pages.map(p => expect(p.locator('.mono-board')).toBeVisible()));
        const after = await matchView(a, matchId);
        expect(after.version).toBe(before.version);
        const beforeState = before.state as MonopolyView, afterState = after.state as MonopolyView;
        expect(afterState.players.map(p => [p.position, p.bank])).toEqual(beforeState.players.map(p => [p.position, p.bank]));
        expect(afterState.properties).toEqual(beforeState.properties);
        view = after;
      }
    }
    expect(steps).toBeGreaterThan(4);
    expect(restarted, 'backend restart checkpoint was not exercised').toBe(true);
    expect(view.status).toBe('active');
    const finalState = view.state as MonopolyView;
    expect(finalState.dice).not.toBeNull();
    // At least one purchase or auction resolution must have happened.
    expect(finalState.properties.some(p => p.owner !== null) || finalState.log.some(l => l.text.includes('аукцион'))).toBe(true);
  } finally {
    await stop(server);
    await Promise.all(contexts.map(c => c.close()));
  }
});
