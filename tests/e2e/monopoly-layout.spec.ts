import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
interface Session { token: string; player: { id: string } }

const port = e2ePort(3003);
const base = 'http://127.0.0.1:' + port;

function databaseUrl() {
  const credentials = JSON.parse(readFileSync(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  return 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
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
async function api<T>(token: string | null, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status);
  return response.json() as Promise<T>;
}

/** Programmatic layout audit: horizontal overflow + mono elements outside viewport. */
async function audit(page: Page, tag: string) {
  const problems = await page.evaluate(() => {
    const bad: string[] = [];
    const vw = innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) bad.push('page h-overflow scrollWidth=' + document.documentElement.scrollWidth + ' vw=' + vw);
    for (const el of document.querySelectorAll<HTMLElement>('.mono-board, .mono-cell, .mono-players, .mono-side, .mono-actions, .mono-log, .mono-panel, .mono-modal, .mono-trade-modal, .mono-result, .mono-menu')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < -2 || r.right > vw + 2)) bad.push(el.className + ' x[' + Math.round(r.left) + '..' + Math.round(r.right) + '] vw=' + vw);
    }
    return bad;
  });
  expect(problems, tag + ' layout violations').toEqual([]);
}

test('monopoly layout audit: desktop, mobile, small mobile — board, modals, no overflow', async ({ browser }) => {
  test.setTimeout(120000);
  const server = await start();
  const contexts: BrowserContext[] = [];
  try {
    const sessions = await Promise.all([api<Session>(null, '/auth/dev', { name: 'Layout A' }), api<Session>(null, '/auth/dev', { name: 'Layout B' })]);
    const host = sessions[0]!.token;
    const room = await api<{ id: string }>(host, '/rooms', { requestId: crypto.randomUUID(), gameId: 'monopoly', name: 'Layout', visibility: 'private', settings: { mode: 'classic', maxPlayers: 2, startMoney: 1500, turnSeconds: 30, auctionSeconds: 15, tradeSeconds: 60, evenBuild: true } });
    const invite = await api<{ code: string }>(host, '/rooms/' + room.id + '/invite', {});
    const code = invite.code.split(':')[1]!;
    await api(sessions[1]!.token, '/rooms/' + room.id + '/join', { inviteToken: code });
    for (const s of sessions) {
      const v = await api<{ version: number }>(s.token, '/rooms/' + room.id);
      await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: v.version, requestId: crypto.randomUUID() });
    }
    await api(host, '/rooms/' + room.id + '/start', { requestId: crypto.randomUUID() });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(context);
    await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), host);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(base);
    await expect(page.locator('.mono-board')).toBeVisible();

    for (const vp of [{ w: 1920, h: 1080, tag: 'desktop1920' }, { w: 1280, h: 800, tag: 'desktop1280' }, { w: 768, h: 1024, tag: 'tablet768' }, { w: 390, h: 844, tag: 'mobile390' }, { w: 360, h: 640, tag: 'mobile360' }]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.waitForTimeout(300);
      await audit(page, vp.tag + ' board');
      await page.screenshot({ path: 'tests/.artifacts/mono-layout-' + vp.tag + '-board.png', fullPage: true });
      // Property detail modal
      await page.locator('.mono-cell').first().click();
      await expect(page.locator('.mono-modal')).toBeVisible();
      await audit(page, vp.tag + ' property-modal');
      await page.screenshot({ path: 'tests/.artifacts/mono-layout-' + vp.tag + '-modal.png', fullPage: true });
      await page.locator('.mono-modal-close').click();
      // Trade composer modal (turn player's flags.canTrade)
      const tradeBtn = page.getByRole('button', { name: 'Предложить обмен' });
      if (await tradeBtn.isVisible().catch(() => false)) {
        await tradeBtn.click();
        await expect(page.locator('.mono-trade-modal')).toBeVisible();
        await audit(page, vp.tag + ' trade-modal');
        await page.screenshot({ path: 'tests/.artifacts/mono-layout-' + vp.tag + '-trade.png', fullPage: true });
        await page.locator('.mono-trade-modal .mono-modal-close').click();
      }
    }
  } finally {
    await stop(server);
    await Promise.all(contexts.map(c => c.close()));
  }
});
