import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('Discord avatars render as images and fall back to initials on failure', async ({ browser }) => {
  test.setTimeout(90000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const port = e2ePort(3005);
  const base = 'http://127.0.0.1:' + port;
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const server = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const naturalWidth = (page: Page, selector: string) => page.locator(selector).evaluate(img => (img as HTMLImageElement).naturalWidth);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { server.kill(); reject(new Error('Backend startup timeout')); }, 15000);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
      server.stdout!.on('data', data => { if (String(data).includes('Server listening')) { clearTimeout(timeout); resolve(); } });
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
    await page.route('https://cdn.discordapp.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    const session = await page.request.post(base + '/api/auth/dev', { data: { name: 'Аватар Тест', avatar: avatarUrl } }).then(r => r.json() as Promise<{ token: string }>);
    await page.goto(base);
    await page.evaluate(token => sessionStorage.setItem('rize.arcade.session', token), session.token);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    await expect.poll(() => naturalWidth(page, '.identity .avatar img')).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Профиль', exact: true }).click();
    await expect.poll(() => naturalWidth(page, '.profile-avatar img')).toBeGreaterThan(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => naturalWidth(page, '.profile-avatar img')).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
    await page.getByRole('button', { name: /Дурак/ }).click(); await page.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await page.getByRole('textbox', { name: 'Название комнаты' }).fill('Аватары');
    await page.getByRole('button', { name: 'Создать лобби' }).click();
    await expect.poll(() => naturalWidth(page, '.member .avatar img')).toBeGreaterThan(0);
    await page.screenshot({ path: 'tests/.artifacts/avatar-lobby.png' });
    await context.close();

    const broken = await browser.newContext();
    const bad = await broken.newPage();
    bad.setDefaultTimeout(10000);
    await bad.route('https://cdn.discordapp.com/**', route => route.fulfill({ status: 404, body: 'missing' }));
    const badSession = await bad.request.post(base + '/api/auth/dev', { data: { name: 'Сломанный Аватар', avatar: 'https://cdn.discordapp.com/avatars/1/' + 'c'.repeat(32) + '.png' } }).then(r => r.json() as Promise<{ token: string }>);
    await bad.goto(base);
    await bad.evaluate(token => sessionStorage.setItem('rize.arcade.session', token), badSession.token);
    await bad.reload();
    await expect(bad.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    await expect(bad.locator('.identity .avatar img')).toHaveCount(0);
    await expect(bad.locator('.identity .avatar')).toContainText('С');
    await broken.close();
  } finally {
    const exited = once(server, 'exit');
    if (process.platform === 'win32') server.send('shutdown'); else server.kill('SIGTERM');
    await exited;
  }
});
