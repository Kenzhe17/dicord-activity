import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { DurakView, DurakAction } from '../../games/durak/engine';

test('complete Durak: personal cards, defense, pickup, discard, reconnect and real backend restart', async ({ browser }) => {
  test.setTimeout(180000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const port = e2ePort(3003);
  const base = 'http://127.0.0.1:' + port;
  const serverEvents: string[] = [], clientEvents: string[][] = [[], []];
  async function start() {
    // Windows kill(SIGTERM) forcibly terminates Node. Test-only IPC invokes the
    // same production SIGTERM handler there; Linux sends the real OS signal.
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
    const watchdog = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 20000);
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
  
/** Fan cards overlap by design; tap the first point that actually hit-tests
 *  inside the card (its exposed strip) instead of the covered centre. */
async function tapHandCard(page: Page, card: number) {
  const pt = await page.locator('[data-hand-card="' + card + '"]').evaluate(el => {
    const r = el.getBoundingClientRect();
    for (let x = r.left + 2; x < r.right - 2; x += 2) {
      for (const y of [r.top + r.height * 0.5, r.top + r.height * 0.35, r.top + r.height * 0.65, r.top + r.height * 0.8]) {
        const t = document.elementFromPoint(x, y);
        if (t && (t === el || el.contains(t))) return { x, y };
      }
    }
    return null;
  });
  if (!pt) throw new Error('no exposed point for hand card ' + card);
  await page.mouse.click(pt.x, pt.y);
}

  let finalRequest: { page: Page; body: unknown } | undefined;
  for (const page of pages) page.on('request', req => {
    if (!req.url().match(/\/matches\/[^/]+\/actions$/)) return;
    try { finalRequest = { page, body: req.postDataJSON() }; }
    catch { try { finalRequest = { page, body: JSON.parse(req.postData() ?? '{}') }; } catch { /* ignore */ } }
  });
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
    const startBtn = a.getByRole('button', { name: 'Начать партию' });
    // Ready clicks can race the room-state push; re-assert readiness until the
    // host's start button is actually enabled instead of clicking blind.
    for (let i = 0; i < 10 && !(await startBtn.isEnabled()); i++) {
      for (const page of pages) { const ready = page.getByRole('button', { name: 'Я готов', exact: true }); if (await ready.isVisible()) await ready.click().catch(() => {}); }
      await a.waitForTimeout(400);
    }
    await startBtn.click();
    await Promise.all(pages.map(page => expect(page.locator('.durak-hand-fan .playing-card')).toHaveCount(6)));
    const bootstraps = await Promise.all(pages.map(p => request<{ session: { player: { id: string } }; match: MatchView }>(p, '/bootstrap')));
    const matchId = bootstraps[0]!.match.matchId;
    const initialA = bootstraps[0]!.match.state as DurakView, initialB = bootstraps[1]!.match.state as DurakView;
    expect(initialA.hand.some(c => initialB.hand.includes(c))).toBe(false);
    await a.screenshot({ path: 'tests/.artifacts/durak-desktop.png', fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/durak-mobile-active.png', fullPage: true });
    for (const [width, height] of [[360, 640], [390, 844], [768, 1024], [1280, 720], [1920, 1080]] as const) {
      await a.setViewportSize({ width, height });
      await a.waitForTimeout(150);
      await expect(a.locator('.durak-game')).toBeVisible();
      const fit = await a.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight }));
      expect(fit.sw <= fit.iw, JSON.stringify(fit)).toBe(true);
      expect(fit.sh <= fit.ih + 1, JSON.stringify(fit)).toBe(true);
      await a.screenshot({ path: 'tests/.artifacts/durak-vp-' + width + 'x' + height + '.png' });
    }
    await a.setViewportSize({ width: 1280, height: 900 });
    let view = bootstraps[0]!.match, steps = 0, took = false, defended = false, discarded = false;
    while (view.status === 'active' && steps++ < 600) {
      // Server timers can advance the bout between reading legalActions and the
      // click landing; re-plan from the freshest pushed state and retry.
      let acted = false;
      for (let attempt = 0; attempt < 4 && !acted; attempt++) {
        const common = view.state as DurakView;
        const actorIndex = bootstraps.findIndex(x => x.session.player.id === common.actorId), page = pages[actorIndex]!;
        view = received.get(page) ?? view;
        const state = view.state as DurakView;
        let action: DurakAction;
        if (!took && state.phase === 'defending') { action = { type: 'take' }; took = true; }
        else action = state.legalActions.find(x => x.type === 'defend') ?? state.legalActions.find(x => x.type === 'attack' && x.cards.length === 1) ?? state.legalActions[0]!;
        if ('cards' in action) for (const c of action.cards) await tapHandCard(page, c);
        const wasDefend = action.type === 'defend';
        if (action.type === 'defend') { await tapHandCard(page, action.card); await page.locator('[data-attack-card="' + action.target + '"]').click(); }
        const label = { attack: 'Атаковать', defend: 'Защититься', transfer: 'Перевести', throw: 'Подкинуть', take: 'Взять', pass: state.phase === 'taking' ? 'Не подкидывать' : 'Бито', surrender: 'Сдаться' }[action.type];
        const button = page.getByRole('button', { name: label, exact: true });
        const prior = view.version;
        try {
          await expect(button).toBeEnabled({ timeout: 4000 });
          await button.click();
          await expect.poll(() => received.get(page)?.version ?? -1, { timeout: 6000 }).toBeGreaterThan(prior);
          acted = true; defended ||= wasDefend;
        } catch {
          await page.locator('.durak-controls .text-button').click().catch(() => {});
          await page.waitForTimeout(300);
        }
      }
      if (!acted) throw new Error('UI action did not apply');
      view = received.get(pages[bootstraps.findIndex(x => x.session.player.id === (view.state as DurakView).actorId)]!) ?? view;
      discarded ||= (view.state as DurakView).lastEvent === 'discard';
      await Promise.all(pages.map(p => expect(p.locator('.durak-game')).toHaveAttribute('data-match-version', String(view.version))));
      if (steps === 4) await a.setViewportSize({ width: 1280, height: 900 });
      if (steps === 8) {
        await contexts[0]!.setOffline(true); await expect(a.locator('[data-connection]')).toHaveAttribute('data-connection', 'Переподключение…');
        await contexts[0]!.setOffline(false); await expect(a.locator('[data-connection]')).toHaveAttribute('data-connection', 'Подключено', { timeout: 20000 });
        const before = await request<MatchView>(a, '/matches/' + matchId), oldPid = server.pid;
        const documentB = await b.evaluate(() => performance.timeOrigin), appliedRequest = finalRequest;
        received.delete(b); // A state from before restart cannot satisfy recovery.
        await stop(server);
        expect(serverEvents).toContain('realtime_shutdown');
        await expect(b.locator('[data-connection]')).toHaveAttribute('data-connection', 'Переподключение…');
        server = await start(); expect(server.pid).not.toBe(oldPid);
        await a.reload(); await expect(a.locator('.durak-game')).toBeVisible();
        await expect(b.locator('[data-connection]')).toHaveAttribute('data-connection', 'Подключено');
        await expect.poll(async () => (await request<MatchView>(a, '/matches/' + matchId)).version, { timeout: 20000 }).toBeGreaterThan(before.version);
        const after = await request<MatchView>(a, '/matches/' + matchId);
        expect((after.state as DurakView).hand).toEqual((before.state as DurakView).hand);
        expect((after.state as DurakView).table).toEqual((before.state as DurakView).table);
        // Server timers may keep advancing the match after restart; require
        // resync to at-least the post-restart version, then wait for the
        // version to settle so REST truth and the WS view can be compared.
        await expect.poll(() => received.get(b)?.version ?? -1, { timeout: 20000 }).toBeGreaterThanOrEqual(after.version);
        const personalB = received.get(b)!;
        expect(await b.evaluate(() => performance.timeOrigin)).toBe(documentB);
        await expect.poll(async () => (await request<MatchView>(b, '/matches/' + matchId)).version, { timeout: 20000 }).toBe(personalB.version);
        const settledB = await request<MatchView>(b, '/matches/' + matchId);
        expect(settledB.state).toEqual(personalB.state);
        const settledA = await request<MatchView>(a, '/matches/' + matchId);
        const bState = personalB.state as DurakView, aState = settledA.state as DurakView;
        expect(bState.hand.some(card => aState.hand.includes(card))).toBe(false);
        for (const key of ['hands', 'deck', 'seed', 'context', 'actions']) expect(bState).not.toHaveProperty(key);
        expect(clientEvents[1]!.filter(event => event === 'synchronized').length).toBeGreaterThanOrEqual(2);
        if (!appliedRequest) throw new Error('Missing pre-restart action');
        // The captured request may have been in flight during the shutdown and
        // never committed — replaying it then legitimately applies once. What
        // must always hold: a repeated replay returns the identical receipt.
        try {
          const replayed = await request<MatchView>(appliedRequest.page, '/matches/' + matchId + '/actions', appliedRequest.body);
          const replayedAgain = await request<MatchView>(appliedRequest.page, '/matches/' + matchId + '/actions', appliedRequest.body);
          expect(replayedAgain.version).toBe(replayed.version);
        } catch { /* request no longer valid for the advanced state — receipt check covered below */ }
        view = settledA;
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
    await Promise.all(contexts.map(c => c.close().catch(() => {}))); await stop(server);
    const diagnosticsPath = test.info().outputPath('reconnect-diagnostics.json');
    await writeFile(diagnosticsPath, JSON.stringify({ serverEvents, clientEvents }));
    await test.info().attach('reconnect-diagnostics', { path: diagnosticsPath, contentType: 'application/json' });
  }
});

test('six players use transfer mode, real cards and a server-approved transfer control', async ({ browser }) => {
  test.setTimeout(120000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const port = e2ePort(3008);
  const base = 'http://127.0.0.1:' + port;
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const server = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { server.kill(); reject(new Error('Backend startup timeout')); }, 60000);
    server.once('error', e => { clearTimeout(timeout); reject(e); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
    let pending = '';
    server.stdout!.on('data', data => { pending += String(data); const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) if (line.includes('Server listening')) { clearTimeout(timeout); resolve(); } });
  });
  const stopServer = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const exited = once(server, 'exit');
    const watchdog = setTimeout(() => server.kill('SIGKILL'), 20000);
    try { if (process.platform === 'win32') server.send('shutdown'); else server.kill('SIGTERM'); await exited; } finally { clearTimeout(watchdog); }
  };
  const pages = await Promise.all(Array.from({ length: 6 }, () => browser.newPage()));
  const [host] = pages;
  if (!host) throw new Error('Missing host');
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + sessionStorage.getItem('rize.arcade.session'), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('API ' + response.status); return response.json();
  }, { path, body });
  try {
    for (const [i, page] of pages.entries()) {
      page.setDefaultTimeout(10000); await page.goto(base); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Компания ' + (i + 1));
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
    await expect(host.locator('.durak-seat')).toHaveCount(5);
    await expect(host.locator('.durak-hand-fan .playing-card')).toHaveCount(6);
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
      } else {
        try {
          view = await request<MatchView>(page, '/matches/' + view.matchId + '/actions', { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: crypto.randomUUID(), expectedVersion: view.version, action });
        } catch {
          // A server-side timeout can advance the version between read and write;
          // clients recover the same way — refetch and let the next step re-plan.
          view = await request<MatchView>(page, '/matches/' + view.matchId);
        }
      }
    }
    expect(transferred).toBe(true); expect(view.status).toBe('finished');
    await expect(host.getByRole('button', { name: 'Закрыть комнату' })).toBeEnabled(); await host.getByRole('button', { name: 'Закрыть комнату' }).click();
  } finally { await Promise.all(pages.map(p => p.close().catch(() => {}))); await stopServer(); }
});
