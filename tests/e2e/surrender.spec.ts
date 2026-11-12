import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { MatchView } from '../../packages/shared/src';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('surrender via in-game menu ends a two-player match with standings for everyone', async ({ browser }) => {
  test.setTimeout(90000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/arcade_test?schema=arcade';
  const base = 'http://127.0.0.1:3004';
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const server = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: '3004', ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { server.kill(); reject(new Error('Backend startup timeout')); }, 15000);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
      server.stdout!.on('data', data => { if (String(data).includes('Server listening')) { clearTimeout(timeout); resolve(); } });
    });
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    const [a, b] = pages as [Page, Page];
    try {
      for (const [i, page] of pages.entries()) {
        page.setDefaultTimeout(10000); await page.goto(base); await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Сдача E2E ' + i);
        await page.getByRole('button', { name: 'Войти локально' }).click(); await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
      }
      await a.getByRole('button', { name: /Дурак/ }).click(); await a.getByRole('button', { name: 'Создать комнату', exact: true }).click();
      await a.getByLabel('Мест за столом').selectOption('2');
      await a.getByRole('textbox', { name: 'Название комнаты' }).fill('Прощальный стол');
      await a.getByLabel('Приватная комната').check(); await a.getByRole('button', { name: 'Создать лобби' }).click();
      await a.getByRole('button', { name: 'Создать приглашение' }).click(); const code = await a.locator('.invite-code').inputValue();
      await b.getByRole('button', { name: 'Комнаты', exact: true }).click(); await b.getByRole('textbox', { name: 'Войти по коду' }).fill(code); await b.getByRole('button', { name: 'Присоединиться' }).click();
      for (const page of pages) await page.getByRole('button', { name: 'Я готов', exact: true }).click();
      await a.getByRole('button', { name: 'Начать партию' }).click();
      await Promise.all(pages.map(page => expect(page.locator('.own-hand .playing-card')).toHaveCount(6)));
      const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
        const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + sessionStorage.getItem('rize.arcade.session'), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw new Error('API ' + response.status); return response.json();
      }, { path, body });
      const firstMatchId = (await request<{ match: MatchView }>(a, '/bootstrap')).match.matchId;
      await a.screenshot({ path: 'tests/.artifacts/durak-menu-check.png' });
      await b.getByRole('button', { name: 'Меню', exact: true }).click();
      const menu = b.locator('.game-menu'); await expect(menu).toBeVisible();
      await expect(menu.locator('.game-menu-player')).toHaveCount(2);
      await b.screenshot({ path: 'tests/.artifacts/durak-game-menu.png' });
      await menu.getByRole('button', { name: 'Сдаться', exact: true }).click();
      await menu.getByRole('button', { name: /Точно сдаться/ }).click();
      for (const page of pages) {
        await expect(page.locator('.durak-result')).toBeVisible();
        await expect(page.locator('.result-standings .result-standing')).toHaveCount(2);
        await expect(page.getByRole('button', { name: 'Я готов — реванш' })).toBeVisible();
      }
      await expect(b.locator('.result-standing', { hasText: 'Сдался' })).toHaveCount(1);
      await expect(a.locator('.result-standing', { hasText: 'Победитель' })).toHaveCount(1);
      await expect(b.locator('.durak-result h2')).toHaveText('Вы сдались');
      await expect(a.locator('.durak-result h2')).toHaveText('Победа!');
      const resultActions = a.locator('.result-actions');
      await resultActions.getByRole('button', { name: 'Я готов — реванш' }).click();
      await expect(resultActions.getByRole('button', { name: 'Отменить готовность' })).toBeVisible();
      await expect(resultActions.getByRole('button', { name: 'Начать партию' })).toBeDisabled();
      await b.locator('.result-actions').getByRole('button', { name: 'Я готов — реванш' }).click();
      const startRematch = resultActions.getByRole('button', { name: 'Начать партию' });
      await expect(startRematch).toBeEnabled();
      await startRematch.click();
      await expect(a.locator('.durak-result')).toHaveCount(0);
      await Promise.all(pages.map(page => expect(page.locator('.own-hand .playing-card')).toHaveCount(6)));
      const boots = await Promise.all(pages.map(p => request<{ match: MatchView | null }>(p, '/bootstrap')));
      const secondMatchId = boots.find(x => x.match)?.match?.matchId;
      expect(secondMatchId).toBeTruthy(); expect(secondMatchId).not.toBe(firstMatchId);
      for (const page of pages) {
        const history = await request<{ id: string }[]>(page, '/history');
        expect(history.filter(h => h.id === firstMatchId)).toHaveLength(1);
      }
      await a.screenshot({ path: 'tests/.artifacts/durak-rematch.png' });
    } finally { await Promise.all(contexts.map(c => c.close())); }
  } finally {
    const exited = once(server, 'exit');
    if (process.platform === 'win32') server.send('shutdown'); else server.kill('SIGTERM');
    await exited;
  }
});
