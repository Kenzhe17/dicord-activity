import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MatchView } from '../../packages/shared/src';
import type { DurakView, DurakAction } from '../../games/durak/engine';

test('complete Durak: personal cards, defense, pickup, discard, reconnect and real backend restart', async ({ browser }) => {
  test.setTimeout(180000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/arcade_test?schema=arcade';
  const base = 'http://127.0.0.1:3003';
  const serverEvents: string[] = [], clientEvents: string[][] = [[], []];
  async function start() {
    // Windows kill(SIGTERM) forcibly terminates Node. Test-only IPC invokes the
    // same production SIGTERM handler there; Linux sends the real OS signal.
    const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: '3003', ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let pendingLog = '';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timeout')); }, 15000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
      child.stdout!.on('data', data => {
        pendingLog += String(data);
        const lines = pendingLog.split('\n'); pendingLog = lines.pop() ?? '';
        for (const line of lines) {
          const event = line.match(/"event":"(realtime_[a-z_]+)"/)?.[1];
          if (event) serverEvents.push(event); // No raw HTTP logs, credentials or state.
          if (line.includes('Server listening')) { clearTimeout(timeout); resolve(); }
        }
      });
    });
    return child;
  }
  async function stop(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    let forced = false;
    const watchdog = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
    try {
      if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM');
      await exited;
      if (forced) throw new Error('Backend did not shut down gracefully');
    } finally { clearTimeout(watchdog); }
  }
  let server = await start();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const [a, b] = pages as [Page, Page];
  for (const page of pages) page.setDefaultTimeout(10000);
  const diagnosticEvents = new Set(['connected', 'disconnected', 'connect_error', 'reconnect_attempt', 'reconnect_failed', 'subscribe_timeout', 'subscribe_rejected', 'synchronized']);
  for (const [i, page] of pages.entries()) page.on('console', message => {
    if (!message.text().startsWith('[arcade:realtime] ')) return;
    try {
      const data = JSON.parse(message.text().slice('[arcade:realtime] '.length)) as { event: string };
      if (diagnosticEvents.has(data.event)) clientEvents[i]!.push(data.event);
    } catch { /* Raw console text is never retained in diagnostics. */ }
  });
  const received = new Map<Page, MatchView>();
  for (const page of pages) page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const value = String(payload);
    if (!value.startsWith('42[')) return;
    const packet = JSON.parse(value.slice(2)) as [string, MatchView];
    if (packet[0] === 'match:state') received.set(page, packet[1]);
  }));
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    const token = sessionStorage.getItem('rize.arcade.session');
    const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('API request ' + response.status);
    return response.json();
  }, { path, body });
  let finalRequest: { page: Page; body: unknown } | undefined;
  for (const page of pages) page.on('request', req => { if (req.url().match(/\/matches\/[^/]+\/actions$/)) finalRequest = { page, body: req.postDataJSON() }; });
  try {
    for (const [i, page] of pages.entries()) {
      await page.goto(base); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Дурак E2E ' + i);
      await page.getByRole('button', { name: 'Войти локально' }).click(); await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    }
    await a.getByRole('button', { name: /Дурак/ }).click(); await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await a.getByLabel('Мест за столом').selectOption('2');
    await a.getByRole('textbox', { name: 'Название комнаты' }).fill('Карточный вечер');
    await a.getByLabel('Приватная комната').check(); await a.getByRole('button', { name: 'Создать лобби' }).click();
    await a.getByRole('button', { name: 'Создать приглашение' }).click(); const code = await a.locator('.invite-code').inputValue();
    await b.getByRole('button', { name: 'Комнаты', exact: true }).click(); await b.getByRole('textbox', { name: 'Войти по коду' }).fill(code); await b.getByRole('button', { name: 'Присоединиться' }).click();
    for (const page of pages) await page.getByRole('button', { name: 'Я готов', exact: true }).click();
    await a.getByRole('button', { name: 'Начать партию' }).click();
    await Promise.all(pages.map(page => expect(page.locator('.own-hand .playing-card')).toHaveCount(6)));
    const bootstraps = await Promise.all(pages.map(p => request<{ session: { player: { id: string } }; match: MatchView }>(p, '/bootstrap')));
    const matchId = bootstraps[0]!.match.matchId;
    const initialA = bootstraps[0]!.match.state as DurakView, initialB = bootstraps[1]!.match.state as DurakView;
    expect(initialA.hand.some(c => initialB.hand.includes(c))).toBe(false);
    await a.screenshot({ path: 'tests/.artifacts/durak-desktop.png', fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/durak-mobile-active.png', fullPage: true });
    let view = bootstraps[0]!.match, steps = 0, took = false, defended = false, discarded = false;
    while (view.status === 'active' && steps++ < 600) {
      const common = view.state as DurakView;
      const actorIndex = bootstraps.findIndex(x => x.session.player.id === common.actorId), page = pages[actorIndex]!;
      view = received.get(page)!;
      const state = view.state as DurakView;
      let action: DurakAction;
      if (!took && state.phase === 'defending') { action = { type: 'take' }; took = true; }
      else action = state.legalActions.find(x => x.type === 'defend') ?? state.legalActions.find(x => x.type === 'attack' && x.cards.length === 1) ?? state.legalActions[0]!;
      await expect(page.locator('.durak-game')).toHaveAttribute('data-match-version', String(view.version));
      if ('cards' in action) for (const c of action.cards) await page.locator('[data-hand-card="' + c + '"]').click();
      if (action.type === 'defend') { await page.locator('[data-hand-card="' + action.card + '"]').click(); await page.locator('[data-target-card="' + action.target + '"]').click(); defended = true; }
      const label = { attack: 'Атаковать', defend: 'Защититься', transfer: 'Перевести', throw: 'Подкинуть', take: 'Взять', pass: state.phase === 'taking' ? 'Не подкидывать' : 'Бито / не подкидываю', surrender: 'Сдаться' }[action.type];
      await page.getByRole('button', { name: label, exact: true }).click();
      const prior = view.version;
      await expect.poll(() => received.get(page)?.version ?? -1).toBeGreaterThan(prior);
      view = received.get(page)!;
      discarded ||= (view.state as DurakView).lastEvent === 'discard';
      await Promise.all(pages.map(p => expect(p.locator('.durak-game')).toHaveAttribute('data-match-version', String(view.version))));
      if (steps === 4) await a.setViewportSize({ width: 1280, height: 900 });
      if (steps === 8) {
        await contexts[0]!.setOffline(true); await expect(a.getByText('Переподключение…', { exact: true })).toBeVisible();
        await contexts[0]!.setOffline(false); await expect(a.getByText('Подключено', { exact: true })).toBeVisible();
        const before = await request<MatchView>(a, '/matches/' + matchId), beforeB = await request<MatchView>(b, '/matches/' + matchId), oldPid = server.pid;
        const documentB = await b.evaluate(() => performance.timeOrigin), appliedRequest = finalRequest;
        received.delete(b); // A state from before restart cannot satisfy recovery.
        await stop(server);
        expect(serverEvents).toContain('realtime_shutdown');
        await expect(b.getByText('Переподключение…', { exact: true })).toBeVisible();
        server = await start(); expect(server.pid).not.toBe(oldPid);
        await a.reload(); await expect(a.locator('.durak-game')).toBeVisible();
        await expect(b.getByText('Подключено', { exact: true })).toBeVisible();
        await expect.poll(async () => (await request<MatchView>(a, '/matches/' + matchId)).version).toBeGreaterThan(before.version);
        const after = await request<MatchView>(a, '/matches/' + matchId);
        expect((after.state as DurakView).hand).toEqual((before.state as DurakView).hand);
        expect((after.state as DurakView).table).toEqual((before.state as DurakView).table);
        await expect.poll(() => received.get(b)?.version ?? -1).toBe(after.version);
        const personalB = received.get(b)!;
        expect(await b.evaluate(() => performance.timeOrigin)).toBe(documentB);
        expect((personalB.state as DurakView).hand).toEqual((beforeB.state as DurakView).hand);
        expect((personalB.state as DurakView).table).toEqual((after.state as DurakView).table);
        expect((personalB.state as DurakView).hand.some(card => (after.state as DurakView).hand.includes(card))).toBe(false);
        for (const key of ['hands', 'deck', 'seed', 'context', 'actions']) expect(personalB.state).not.toHaveProperty(key);
        expect(clientEvents[1]!.filter(event => event === 'synchronized').length).toBeGreaterThanOrEqual(2);
        if (!appliedRequest) throw new Error('Missing pre-restart action');
        const replayed = await request<MatchView>(appliedRequest.page, '/matches/' + matchId + '/actions', appliedRequest.body);
        expect(replayed.version).toBe(after.version);
        view = after;
      }
    }
    expect(view.status).toBe('finished'); expect(took && defended && discarded).toBe(true);
    await expect(a.locator('.durak-result')).toBeVisible(); await expect(b.locator('.durak-result')).toBeVisible();
    if (!finalRequest) throw new Error('Final action missing');
    const repeated = await request<MatchView>(finalRequest.page, '/matches/' + matchId + '/actions', finalRequest.body); expect(repeated.version).toBe(view.version);
    for (const page of pages) {
      const history = await request<{ id: string; ratingDelta: number }[]>(page, '/history');
      expect(history.filter(h => h.id === matchId)).toHaveLength(1); expect(history[0]?.ratingDelta).toBe(0);
    }
    await a.screenshot({ path: 'tests/.artifacts/durak-result.png', fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 }); expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/durak-mobile.png', fullPage: true });
    await a.getByRole('button', { name: 'Закрыть комнату' }).click();
  } finally {
    await Promise.all(contexts.map(c => c.close())); await stop(server);
    const diagnosticsPath = test.info().outputPath('reconnect-diagnostics.json');
    await writeFile(diagnosticsPath, JSON.stringify({ serverEvents, clientEvents }));
    await test.info().attach('reconnect-diagnostics', { path: diagnosticsPath, contentType: 'application/json' });
  }
});

test('six players use transfer mode, real cards and a server-approved transfer control', async ({ browser }) => {
  test.setTimeout(120000);
  const pages = await Promise.all(Array.from({ length: 6 }, () => browser.newPage()));
  const [host] = pages;
  if (!host) throw new Error('Missing host');
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + sessionStorage.getItem('rize.arcade.session'), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('API ' + response.status); return response.json();
  }, { path, body });
  try {
    for (const [i, page] of pages.entries()) {
      page.setDefaultTimeout(10000); await page.goto('/'); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Компания ' + (i + 1));
      await page.getByRole('button', { name: 'Войти локально' }).click(); await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    }
    await host.getByRole('button', { name: /Дурак/ }).click(); await host.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await host.getByLabel('Режим', { exact: true }).selectOption('transfer'); await host.getByLabel('Приватная комната').check();
    await host.getByRole('button', { name: 'Создать лобби' }).click(); await host.getByRole('button', { name: 'Создать приглашение' }).click();
    const code = await host.locator('.invite-code').inputValue();
    for (const page of pages.slice(1)) {
      await page.getByRole('button', { name: 'Комнаты', exact: true }).click(); await page.getByRole('textbox', { name: 'Войти по коду' }).fill(code); await page.getByRole('button', { name: 'Присоединиться' }).click();
      await expect(page.getByRole('heading', { name: 'Вечерняя партия', exact: true })).toBeVisible();
    }
    for (const page of pages) { await page.getByRole('button', { name: 'Я готов', exact: true }).click(); await expect(page.getByRole('button', { name: 'Отменить готовность' })).toBeVisible(); }
    await host.getByRole('button', { name: 'Начать партию' }).click();
    await expect(host.locator('.opponent')).toHaveCount(5);
    await expect(host.locator('.own-hand .playing-card')).toHaveCount(6);
    const boots = await Promise.all(pages.map(p => request<{ session: { player: { id: string } }; match: MatchView }>(p, '/bootstrap')));
    let view = boots[0]!.match, transferred = false, step = 0;
    expect((view.state as DurakView).deckCount).toBe(0);
    await host.setViewportSize({ width: 390, height: 844 }); expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await host.screenshot({ path: 'tests/.artifacts/durak-six-mobile.png', fullPage: true }); await host.setViewportSize({ width: 1280, height: 900 });
    while (view.status === 'active' && step++ < 600) {
      const publicState = view.state as DurakView, index = boots.findIndex(b => b.session.player.id === publicState.actorId), page = pages[index]!;
      view = await request<MatchView>(page, '/matches/' + view.matchId); const s = view.state as DurakView;
      const transfers = s.legalActions.filter(a => a.type === 'transfer').sort((a, b) => b.cards.length - a.cards.length);
      let action = transfers[0] ?? s.legalActions.find(a => a.type === 'defend') ?? s.legalActions[0]!;
      if (s.phase === 'opening') {
        const defender = pages[boots.findIndex(b => b.session.player.id === s.defenderId)]!;
        const defense = (await request<MatchView>(defender, '/matches/' + view.matchId)).state as DurakView;
        action = s.legalActions.find(a => a.type === 'attack' && a.cards.length === 1 && defense.hand.some(c => c % 9 === a.cards[0]! % 9)) ?? action;
      }
      if (action.type === 'transfer' && !transferred) {
        await expect(page.locator('.durak-game')).toHaveAttribute('data-match-version', String(view.version));
        for (const c of action.cards) await page.locator('[data-hand-card="' + c + '"]').click();
        await page.getByRole('button', { name: 'Перевести', exact: true }).click();
        const old = view.version;
        await expect.poll(async () => (await request<MatchView>(page, '/matches/' + view.matchId)).version).toBeGreaterThan(old);
        view = await request<MatchView>(page, '/matches/' + view.matchId);
        expect((view.state as DurakView).table.length).toBe(s.table.length + action.cards.length);
        expect((view.state as DurakView).defenderId).not.toBe(s.defenderId); transferred = true;
        await expect(host.locator('.card-pair')).toHaveCount((view.state as DurakView).table.length);
        await host.screenshot({ path: 'tests/.artifacts/durak-transfer.png', fullPage: true });
      } else view = await request<MatchView>(page, '/matches/' + view.matchId + '/actions', { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: crypto.randomUUID(), expectedVersion: view.version, action });
    }
    expect(transferred).toBe(true); expect(view.status).toBe('finished');
    await expect(host.getByRole('button', { name: 'Закрыть комнату' })).toBeEnabled(); await host.getByRole('button', { name: 'Закрыть комнату' }).click();
  } finally { await Promise.all(pages.map(p => p.close())); }
});
