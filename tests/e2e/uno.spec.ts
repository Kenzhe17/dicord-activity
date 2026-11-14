import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { UnoView } from '../../games/uno/engine';

const port = e2ePort(3005);
const base = 'http://127.0.0.1:' + port;

async function startServer(databaseUrl: string) {
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timeout')); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
    let pending = '';
    child.stdout!.on('data', data => {
      pending += String(data);
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) if (line.includes('Server listening')) { clearTimeout(timeout); resolve(); }
    });
  });
  return child;
}
async function stopServer(child: ReturnType<typeof spawn>) {
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

/** Mirror of the integration driver: pick this viewer's next legal action. */
function nextUnoAction(view: MatchView): Record<string, unknown> | null {
  const s = view.state as UnoView;
  const legal = s.legal;
  if (legal.canCallUno) return { type: 'callUno' };
  if (legal.canNextRound) return { type: 'nextRound' };
  if (s.phase === 'color' && legal.canChooseColor) return { type: 'chooseColor', color: 'red' };
  if (s.phase === 'challenge' && s.challenge?.iAmChallenger) return { type: 'challenge' };
  if (legal.myTurn && s.phase === 'turn') {
    const card = legal.plays[0];
    if (card !== undefined) return { type: 'play', card, ...(card >= 100 ? { color: 'red' } : {}), ...(s.hand.length === 2 ? { callUno: true } : {}) };
    if (legal.canDraw) return { type: 'draw' };
    if (legal.canPass) return { type: 'pass' };
  }
  if (legal.catchable.length) return { type: 'catchUno', target: legal.catchable[0]! };
  return null;
}

test('UNO: lobby, dealt hands, UI-driven match, mobile fit and reconnect', async ({ browser }) => {
  test.setTimeout(480000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const [a, b] = pages as [Page, Page];
  for (const page of pages) page.setDefaultTimeout(15000);
  // Latest server-pushed match view per page — drives the UI loop without
  // hammering the REST API (which rate-limits).
  const latest = new Map<Page, MatchView>();
  for (const page of pages) page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const value = String(payload);
    if (!value.startsWith('42[')) return;
    try {
      const packet = JSON.parse(value.slice(2)) as [string, MatchView];
      if (packet[0] === 'match:state') latest.set(page, packet[1]);
    } catch { /* non-JSON frame */ }
  }));
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + sessionStorage.getItem('rize.arcade.session'), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('API ' + response.status); return response.json();
  }, { path, body });
  try {
    for (const [i, page] of pages.entries()) {
      await page.goto(base); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('UNO E2E ' + i);
      await page.getByRole('button', { name: 'Войти локально' }).click(); await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    }
    await a.getByRole('button', { name: /UNO/ }).click(); await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await a.getByLabel('Режим UNO').selectOption('quick');
    await a.getByLabel('Игроков UNO').selectOption('2');
    await a.getByLabel('Приватная комната').check();
    await a.getByRole('button', { name: 'Создать лобби' }).click();
    await a.getByRole('button', { name: 'Создать приглашение' }).click();
    const code = await a.locator('.invite-code').inputValue();
    await b.getByRole('button', { name: 'Комнаты', exact: true }).click();
    await b.getByRole('textbox', { name: 'Войти по коду' }).fill(code);
    await b.getByRole('button', { name: 'Присоединиться' }).click();
    for (const page of pages) await page.getByRole('button', { name: 'Я готов', exact: true }).click();
    await a.getByRole('button', { name: 'Начать партию' }).click();
    for (const page of pages) await expect(page.locator('.uno-game')).toBeVisible();
    await Promise.all(pages.map(page => expect(page.locator('[data-hand-card]')).toHaveCount(7)));

    const bootstraps = await Promise.all(pages.map(p => request<{ session: { player: { id: string } }; match: MatchView }>(p, '/bootstrap')));
    const matchId = bootstraps[0]!.match.matchId;
    const sa = bootstraps[0]!.match.state as UnoView, sb = bootstraps[1]!.match.state as UnoView;
    expect(sa.hand.some(c => sb.hand.includes(c))).toBe(false);
    expect(sa).not.toHaveProperty('deck'); expect(sa).not.toHaveProperty('hands');
    await expect.poll(() => latest.get(a)?.matchId === matchId && latest.get(b)?.matchId === matchId, { timeout: 15000 }).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/uno-desktop.png', fullPage: true });

    // Mobile viewport: no horizontal overflow, cards still dealt.
    await a.setViewportSize({ width: 390, height: 844 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(a.locator('.uno-game')).toBeVisible();
    await a.screenshot({ path: 'tests/.artifacts/uno-mobile.png', fullPage: true });
    await a.setViewportSize({ width: 1280, height: 900 });

    // Drive the match through the real UI: each step finds whose pushed view
    // allows an action, then performs the equivalent click on that page.
    let view = bootstraps[0]!.match, steps = 0, reloaded = false, stalled = 0;
    const versionOf = async (page: Page) => latest.get(page)?.version ?? -1;
    while (view.status === 'active' && steps++ < 1500) {
      // Keep the loop condition on the freshest pushed state — the match can
      // end on a broadcast between actions.
      const freshest = pages.map(p => latest.get(p)).filter((v): v is MatchView => !!v && v.matchId === matchId).sort((x, y) => y.version - x.version)[0];
      if (freshest) view = freshest;
      if (view.status !== 'active') break;
      let acted = false;
      for (const page of pages) {
        const candidate = latest.get(page);
        if (!candidate || candidate.status !== 'active' || candidate.version !== view.version) continue;
        const action = nextUnoAction(candidate);
        if (!action) continue;
        const before = candidate.version;
        if (action['type'] === 'play') {
          const card = action['card'] as number;
          await page.locator('[data-hand-card="' + card + '"]').click();
          if (card >= 100) {
            await expect(page.locator('.uno-colorpick')).toBeVisible();
            await page.locator('.uno-colorbtn').first().dispatchEvent('click');
          }
        } else if (action['type'] === 'draw') await page.getByRole('button', { name: 'Взять', exact: true }).click();
        else if (action['type'] === 'pass') await page.getByRole('button', { name: 'Пропустить' }).click();
        else if (action['type'] === 'callUno') await page.getByRole('button', { name: 'UNO!', exact: true }).click();
        else if (action['type'] === 'chooseColor') {
          await expect(page.locator('.uno-colorpick')).toBeVisible();
          await page.locator('.uno-colorbtn').first().dispatchEvent('click');
        } else if (action['type'] === 'challenge') await page.getByRole('button', { name: 'Оспорить +4' }).click();
        else if (action['type'] === 'catchUno') await page.locator('.uno-catch').first().click();
        else if (action['type'] === 'nextRound') await page.getByRole('button', { name: 'Следующий раунд' }).click();
        else continue;
        console.log('step', steps, 'page', pages.indexOf(page), JSON.stringify(action));
        try {
          await expect.poll(() => versionOf(page), { timeout: 10000 }).toBeGreaterThan(before);
        } catch (error) {
          throw new Error('Action did not apply: ' + JSON.stringify(action) + ' :: ' + String(error).slice(0, 200), { cause: error });
        }
        view = latest.get(page)!;
        acted = true;
        break;
      }
      if (!acted) {
        // Broadcasts may still be in flight — give the sockets a moment before
        // declaring a stall (e.g. everyone waiting on a system deadline).
        if (++stalled > 40) throw new Error('No legal UNO UI action at step ' + steps);
        await new Promise(r => setTimeout(r, 250));
        steps--;
        continue;
      }
      stalled = 0;
      if (!reloaded && steps === 12) {
        // Mid-match reload: the same personal hand and match version return.
        const prior = latest.get(a);
        if (!prior) throw new Error('Missing pre-reload view');
        await a.reload();
        await expect(a.locator('.uno-game')).toBeVisible();
        await expect.poll(() => versionOf(a), { timeout: 15000 }).toBe(prior.version);
        const after = latest.get(a);
        expect((after!.state as UnoView).hand).toEqual((prior.state as UnoView).hand);
        reloaded = true;
      }
    }
    expect(view.status).toBe('finished');
    await Promise.all(pages.map(page => expect(page.locator('.uno-result')).toBeVisible()));
    await a.screenshot({ path: 'tests/.artifacts/uno-result.png', fullPage: true });
    const history = await request<{ id: string }[]>(a, '/history');
    expect(history.filter(h => h.id === matchId)).toHaveLength(1);
    await a.setViewportSize({ width: 390, height: 844 });
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: 'tests/.artifacts/uno-result-mobile.png', fullPage: true });
  } finally {
    await Promise.all(contexts.map(c => c.close())); await stopServer(server);
  }
});
