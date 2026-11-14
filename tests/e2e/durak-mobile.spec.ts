import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { DurakView } from '../../games/durak/engine';
import { rank, suit } from '../../games/durak/engine/cards';

const port = e2ePort(3004);
const base = 'http://127.0.0.1:' + port;

function sortExpected(hand: number[], mode: string, trump: number): number[] {
  const cards = [...hand];
  if (mode === 'received') return cards;
  const key = (c: number) => [suit(c) === trump ? 1 : 0, suit(c), rank(c)];
  if (mode === 'rank') cards.sort((a, b) => rank(a) - rank(b) || key(a)[0]! - key(b)[0]! || suit(a) - suit(b));
  else cards.sort((a, b) => { const ka = key(a), kb = key(b); return ka[0]! - kb[0]! || ka[1]! - kb[1]! || ka[2]! - kb[2]!; });
  return cards;
}

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

test('durak mobile: hand sorting, fan fit, selection kept, viewport fit, large hand', async ({ browser }) => {
  test.setTimeout(300000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const [a, b] = pages as [Page, Page];
  for (const page of pages) page.setDefaultTimeout(10000);
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    const token = sessionStorage.getItem('rize.arcade.session');
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 429) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
      if (!response.ok) throw new Error('API request ' + response.status);
      return response.json();
    }
    throw new Error('API rate limited');
  }, { path, body });
  const handOrder = (page: Page) => page.locator('.durak-hand-fan [data-hand-card]').evaluateAll(els => els.map(el => Number((el as HTMLElement).dataset['handCard'])));
  try {
    for (const [i, page] of pages.entries()) {
      await page.goto(base); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Мобильный ' + i);
      await page.getByRole('button', { name: 'Войти локально' }).click(); await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    }
    await a.getByRole('button', { name: /Дурак/ }).click(); await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await a.getByLabel('Мест за столом').selectOption('2');
    await a.getByLabel('Приватная комната').check(); await a.getByRole('button', { name: 'Создать лобби' }).click();
    await a.getByRole('button', { name: 'Создать приглашение' }).click(); const code = await a.locator('.invite-code').inputValue();
    await b.getByRole('button', { name: 'Комнаты', exact: true }).click(); await b.getByRole('textbox', { name: 'Войти по коду' }).fill(code); await b.getByRole('button', { name: 'Присоединиться' }).click();
    for (const page of pages) await page.getByRole('button', { name: 'Я готов', exact: true }).click();
    await a.getByRole('button', { name: 'Начать партию' }).click();
    await Promise.all(pages.map(page => expect(page.locator('.durak-hand-fan .playing-card')).toHaveCount(6)));

    // --- Sorting (inside the corner menu) ---
    await a.getByRole('button', { name: 'Меню партии' }).click();
    const boot = await request<{ session: { player: { id: string } }; room: { id: string }; match: MatchView }>(a, '/bootstrap');
    let state = boot.match.state as DurakView;
    const trump = state.trump;
    const suitSorted = sortExpected(state.hand, 'suit', trump);
    expect(await handOrder(a)).toEqual(suitSorted); // default mode = по мастям
    // trump cards, when present, occupy the tail of the suit-sorted hand
    const firstTrump = suitSorted.findIndex(c => suit(c) === trump);
    const lastPlain = suitSorted.map(c => suit(c) !== trump).lastIndexOf(true);
    if (firstTrump !== -1) expect(firstTrump).toBeGreaterThan(lastPlain);

    await a.getByRole('button', { name: 'По достоинству', exact: true }).click();
    state = (await request<{ match: MatchView }>(a, '/bootstrap')).match.state as DurakView;
    expect(await handOrder(a)).toEqual(sortExpected(state.hand, 'rank', trump));
    expect(await a.evaluate(() => localStorage.getItem('rize.arcade.durak.handSort'))).toBe('rank');

    await a.getByRole('button', { name: 'Как получены', exact: true }).click();
    state = (await request<{ match: MatchView }>(a, '/bootstrap')).match.state as DurakView;
    expect(await handOrder(a)).toEqual(state.hand);

    // back to suit sort for the rest of the test
    await a.getByRole('button', { name: 'По мастям', exact: true }).click();

    // --- Selection survives resorting (wait for own turn) ---
    const boots = await Promise.all(pages.map(p => request<{ session: { player: { id: string } } }>(p, '/bootstrap')));
    const ownA = boots[0]!.session.player.id;
    let selectedCard: number | null = null;
    for (let i = 0; i < 60 && selectedCard === null; i++) {
      const view = await request<MatchView>(a, '/matches/' + boot.match.matchId);
      const s = view.state as DurakView;
      if (s.actorId === ownA && s.legalActions.length) {
        const playable = s.legalActions.flatMap(x => 'cards' in x ? x.cards : x.type === 'defend' ? [x.card] : []);
        const card = playable.find(c => s.hand.includes(c));
        if (card !== undefined) {
          await a.locator('[data-hand-card="' + card + '"]').click();
          const pressed = await a.locator('[data-hand-card="' + card + '"]').getAttribute('aria-pressed');
          if (pressed === 'true') selectedCard = card;
        }
      }
      if (selectedCard === null) await a.waitForTimeout(400);
    }
    if (selectedCard !== null) {
      await a.getByRole('button', { name: 'Меню партии' }).click();
      await a.getByRole('button', { name: 'Как получены', exact: true }).click();
      await a.getByRole('button', { name: 'По мастям', exact: true }).click();
      await expect(a.locator('[data-hand-card="' + selectedCard + '"]')).toHaveAttribute('aria-pressed', 'true');
      await a.getByRole('button', { name: 'Снять выбор' }).click();
    }

    // --- Persistence across reload ---
    await a.reload();
    await expect(a.locator('.durak-hand-fan .playing-card').first()).toBeVisible();
    expect(await a.evaluate(() => localStorage.getItem('rize.arcade.durak.handSort'))).toBe('suit');

    // --- Mobile viewport matrix ---
    for (const [width, height] of [[320, 568], [360, 640], [375, 667], [390, 844], [430, 932]] as const) {
      await a.setViewportSize({ width, height });
      await a.waitForTimeout(200);
      await expect(a.locator('.durak-game')).toBeVisible();
      const fit = await a.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      expect(fit.sw <= fit.iw, JSON.stringify(fit)).toBe(true);
      await expect(a.locator('.durak-hand-measure')).toBeVisible();
      await expect(a.locator('.durak-controls')).toBeVisible();
      await a.screenshot({ path: `tests/.artifacts/durak-mobile-${width}x${height}.png` });
    }
    await a.setViewportSize({ width: 844, height: 390 }); // landscape phone
    await a.waitForTimeout(200);
    const fitLand = await a.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(fitLand.sw <= fitLand.iw, JSON.stringify(fitLand)).toBe(true);
    await expect(a.locator('.durak-controls')).toBeVisible();
    await a.screenshot({ path: 'tests/.artifacts/durak-mobile-landscape.png' });
    await a.setViewportSize({ width: 390, height: 844 });

    // --- Fan fit at 320px: no scroll, every card inside the viewport ---
    await a.setViewportSize({ width: 320, height: 568 });
    await a.waitForTimeout(200);
    const fanFit = await a.evaluate(() => {
      const measure = document.querySelector('.durak-hand-measure');
      const cards = [...document.querySelectorAll<HTMLElement>('.durak-hand-fan [data-hand-card]')];
      return {
        scrollable: !!measure && measure.scrollWidth > measure.clientWidth + 4,
        outside: cards.filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).length,
        count: cards.length,
      };
    });
    expect(fanFit.scrollable, JSON.stringify(fanFit)).toBe(false);
    expect(fanFit.outside, JSON.stringify(fanFit)).toBe(0);
    await a.screenshot({ path: 'tests/.artifacts/durak-mobile-320-hand.png' });
    await a.setViewportSize({ width: 390, height: 844 });

    // --- Grow hands: defender keeps taking, attacker sheds minimal cards ---
    const matchId = boot.match.matchId;
    const ids = boots.map(x => x.session.player.id);
    let maxHand = 0, steps = 0, view = await request<MatchView>(a, '/matches/' + matchId);
    while (view.status === 'active' && steps++ < 320 && maxHand < 27) {
      const s = view.state as DurakView;
      const actorIndex = ids.indexOf(s.actorId!);
      const actorPage = actorIndex === 0 ? a : actorIndex === 1 ? b : null;
      if (!actorPage) break;
      // Drive the match through the same API the UI uses; the UI itself is covered above.
      // Retry on 409: the engine may auto-advance on turn deadlines between fetch and post.
      for (let attempt = 0; attempt < 6; attempt++) {
        const fresh = await request<MatchView>(actorPage, '/matches/' + matchId);
        const fs = fresh.state as DurakView;
        if (fs.actorId !== ids[actorIndex]) { view = fresh; break; } // turn moved on (timeout); re-evaluate next step
        maxHand = Math.max(maxHand, ...fs.players.map(p => p.count));
        const action = fs.legalActions.find(x => x.type === 'take') ?? fs.legalActions.find(x => x.type === 'attack' && x.cards.length === 1) ?? fs.legalActions[0]!;
        try {
          view = await request<MatchView>(actorPage, '/matches/' + matchId + '/actions', {
            protocol: 1, roomId: boot.room.id, matchId, requestId: crypto.randomUUID(), expectedVersion: fresh.version, action,
          });
          break;
        } catch (error) {
          if (!String(error).includes('409') || attempt === 5) throw error;
          await actorPage.waitForTimeout(300);
        }
      }
      await actorPage.waitForTimeout(120);
    }
    // screenshot the player with the biggest hand on a phone viewport
    const finalBoots = await Promise.all(pages.map(p => request<{ match: MatchView }>(p, '/bootstrap')));
    const counts = finalBoots.map(x => (x.match.state as DurakView).hand.length);
    const bigPage = counts[0]! >= counts[1]! ? a : b;
    const bigCount = Math.max(...counts);
    await bigPage.setViewportSize({ width: 390, height: 844 });
    await bigPage.waitForTimeout(300);
    await expect(bigPage.locator('.durak-hand-fan .playing-card')).toHaveCount(bigCount);
    await bigPage.screenshot({ path: 'tests/.artifacts/durak-mobile-big-hand.png', fullPage: true });
    await bigPage.setViewportSize({ width: 320, height: 568 });
    await bigPage.waitForTimeout(200);
    const fitBig = await bigPage.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(fitBig.sw <= fitBig.iw, JSON.stringify(fitBig)).toBe(true);
    await expect(bigPage.locator('.durak-controls')).toBeVisible();
    await bigPage.screenshot({ path: 'tests/.artifacts/durak-mobile-big-hand-320.png', fullPage: true });
    test.info().annotations.push({ type: 'max-hand', description: String(bigCount) });
    console.log('Max hand size reached:', bigCount, 'after', steps, 'steps');
  } finally {
    await Promise.all(contexts.map(c => c.close()));
    await stopServer(server);
  }
});
