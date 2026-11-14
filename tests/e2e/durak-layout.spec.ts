import { test, expect } from '@playwright/test';

test.use({ trace: 'off' });
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';

const port = e2ePort(3005);
const base = 'http://127.0.0.1:' + port;
const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [430, 932]] as const;
const PLAYER_COUNTS = [2, 3, 4, 5, 6] as const;

async function startServer(databaseUrl: string) {
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timeout')); }, 60000);
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

interface Session { token: string }
async function api<T>(token: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 429) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
    if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status + ' ' + (await response.text()).slice(0, 200));
    return response.json() as Promise<T>;
  }
  throw new Error('rate limited ' + path);
}

async function makeMatch(count: number): Promise<{ token: string; tokens: string[]; matchId: string }> {
  const sessions: Session[] = [];
  for (let i = 0; i < count; i++) sessions.push(await api<Session>('', '/auth/dev', { name: 'Стол ' + i }).catch(async () => {
    // /auth/dev may not need a token; retry without auth header
    const response = await fetch(base + '/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Стол ' + i }) });
    if (!response.ok) throw new Error('auth/dev ' + response.status);
    return response.json() as Promise<Session>;
  }));
  const host = sessions[0]!.token;
  const room = await api<{ id: string; version: number }>(host, '/rooms', { requestId: crypto.randomUUID(), gameId: 'durak', name: 'Layout ' + count, visibility: 'public', settings: { mode: 'throw-in', maxPlayers: count, stake: 0 } });
  for (const s of sessions.slice(1)) await api(s.token, '/rooms/' + room.id + '/join', {});
  for (const s of sessions) {
    const view = await api<{ version: number }>(s.token, '/rooms/' + room.id);
    await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: view.version, requestId: crypto.randomUUID() });
  }
  const started = await api<{ matchId: string }>(host, '/rooms/' + room.id + '/start', { requestId: crypto.randomUUID() });
  return { token: host, tokens: sessions.map(s => s.token), matchId: started.matchId };
}

interface Rect { x: number; y: number; w: number; h: number; right: number; bottom: number }
test('durak layout: full-bleed felt, no overlaps, fan fits — 2..6 players × 4 viewports', async ({ browser }) => {
  test.setTimeout(600000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  const problems: string[] = [];
  try {
    for (const count of PLAYER_COUNTS) {
      const { token, tokens, matchId } = await makeMatch(count);
      const context = await browser.newContext({ viewport: { width: VIEWPORTS[0][0], height: VIEWPORTS[0][1] } });
      await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), token);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(base);
      await expect(page.locator('.durak-hand-fan [data-hand-card]').first()).toBeVisible();
      for (const [width, height] of VIEWPORTS) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(300);
        const report = await page.evaluate(() => {
          const overlap = (a: Rect, b: Rect): number => { const w = Math.min(a.right, b.right) - Math.max(a.x, b.x), h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
          const rect = (el: Element | null): Rect | null => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
          const all = (sel: string) => [...document.querySelectorAll(sel)].map(rect).filter((r): r is Rect => !!r);
          const game = rect(document.querySelector('.durak-game'));
          const seats = all('.durak-seats .durak-seat');
          const pairs = all('.card-pair');
          const handCards = all('.durak-hand-fan [data-hand-card]');
          const deck = rect(document.querySelector('.deck-zone'));
          const battlefield = rect(document.querySelector('.battlefield'));
          const handbar = rect(document.querySelector('.durak-handbar'));
          const controls = rect(document.querySelector('.durak-controls'));
          const header = rect(document.querySelector('.game-header'));
          const menuBtn = rect(document.querySelector('.durak-menu-btn'));
          const doc = { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight };
          const inside = (r: Rect) => r.x >= -1 && r.y >= -1 && r.right <= doc.iw + 1 && r.bottom <= doc.ih + 1;
          const issues: string[] = [];
          if (doc.sw > doc.iw + 1 || doc.sh > doc.ih + 1) issues.push('page-scroll ' + JSON.stringify(doc));
          if (!game || game.w < doc.iw * 0.98 || game.h < doc.ih * 0.98) issues.push('game-not-fullscreen ' + JSON.stringify(game));
          if (header && header.h > 2) issues.push('header-visible');
          seats.forEach((r, i) => { if (!inside(r)) issues.push('seat-out ' + i); });
          handCards.forEach((r, i) => { if (r.x < -1 || r.right > doc.iw + 1) issues.push('hand-card-out ' + i); });
          if (deck && pairs.length) pairs.forEach((p, i) => { if (overlap(deck, p) > 4) issues.push('deck-overlaps-pair ' + i); });
          if (deck) { const sb = rect(document.querySelector('.durak-seats')); if (sb && overlap(deck, sb) > 4) issues.push('deck-overlaps-seats'); }
          if (battlefield && handbar && overlap(battlefield, handbar) > 4) issues.push('battlefield-overlaps-hand');
          if (battlefield && rect(document.querySelector('.durak-seats')) && overlap(battlefield, rect(document.querySelector('.durak-seats'))!) > 4) issues.push('battlefield-overlaps-seats');
          if (controls && !inside(controls)) issues.push('controls-out');
          if (menuBtn && !inside(menuBtn)) issues.push('menu-out');
          return { issues, seats: seats.length, pairs: pairs.length, hand: handCards.length, doc };
        });
        const tag = count + 'p-' + width + 'x' + height;
        const shot = await page.screenshot();
        await page.evaluate(async b64 => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = 100; c.height = Math.max(1, Math.round(100 * img.height / img.width));
          const ctx = c.getContext('2d')!;
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let felt = 0, total = 0;
          const rowFelt: number[] = [];
          for (let y = 0; y < c.height; y++) {
            let row = 0, n = 0;
            for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4, r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
              total++;
              const isFelt = g > r + 6 && g > b + 4 && g > 30;
              if (isFelt) { felt++; row++; }
              n++;
            }
            rowFelt.push(row / n);
          }
          const bandRows = Math.max(2, Math.floor(c.height * 0.012));
          const topRows = rowFelt.slice(0, bandRows).reduce((a, b) => a + b, 0) / bandRows;
          (window as unknown as { __feltStats: { coverage: number; topBand: number } }).__feltStats = { coverage: felt / total, topBand: topRows };
        }, shot.toString('base64'));
        const stats = await page.evaluate(() => (window as unknown as { __feltStats?: { coverage: number; topBand: number } }).__feltStats as { coverage: number; topBand: number });
        await page.screenshot({ path: 'artifacts/durak-layout/layout-' + tag + '.png' });
        if (stats.coverage < 0.75) problems.push(tag + ': felt-coverage ' + stats.coverage.toFixed(2));
        if (stats.topBand < 0.7) problems.push(tag + ': top-band-not-felt ' + stats.topBand.toFixed(2));
        for (const issue of report.issues) problems.push(tag + ': ' + issue);
        console.log(tag, 'seats=' + report.seats, 'pairs=' + report.pairs, 'hand=' + report.hand, 'felt=' + stats.coverage.toFixed(2), 'top=' + stats.topBand.toFixed(2), report.issues.length ? 'ISSUES ' + report.issues.join('; ') : 'ok');
      }
      // Mid-bout geometry: drive a real attack through the API, then verify
      // deck/cards never overlap and the table still fills the screen.
      await page.setViewportSize({ width: 360, height: 640 });
      let attacked = false;
      for (let attempt = 0; attempt < 40 && !attacked; attempt++) {
        for (const t of tokens) {
          const m = await api<{ roomId: string; version: number; state: { legalActions: { type: string }[] } }>(t, '/matches/' + matchId);
          const action = m.state.legalActions.find(a => a.type === 'attack');
          if (action) {
            await api(t, '/matches/' + matchId + '/actions', { protocol: 1, roomId: m.roomId, matchId, requestId: crypto.randomUUID(), expectedVersion: m.version, action });
            attacked = true; break;
          }
        }
        if (!attacked) await page.waitForTimeout(400);
      }
      await expect(page.locator('.card-pair .table-card').first()).toBeVisible();
      await page.waitForTimeout(300);
      const mid = await page.evaluate(() => {
        const overlap = (a: Rect, b: Rect): number => { const w = Math.min(a.right, b.right) - Math.max(a.x, b.x), h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
        const rect = (el: Element | null): Rect | null => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
        const deck = rect(document.querySelector('.deck-zone'));
        const pairs = [...document.querySelectorAll('.card-pair')].map(rect).filter((r): r is Rect => !!r);
        const seats = rect(document.querySelector('.durak-seats'));
        const handbar = rect(document.querySelector('.durak-handbar'));
        const issues: string[] = [];
        if (deck) pairs.forEach((p: Rect, i: number) => { if (overlap(deck, p) > 4) issues.push('deck-overlaps-pair ' + i); });
        if (deck && seats && overlap(deck, seats) > 4) issues.push('deck-overlaps-seats');
        const battlefield = rect(document.querySelector('.battlefield'));
        if (battlefield && handbar && overlap(battlefield, handbar) > 4) issues.push('battlefield-overlaps-hand');
        if (battlefield && seats && overlap(battlefield, seats) > 4) issues.push('battlefield-overlaps-seats');
        return { issues, pairs: pairs.length };
      });
      const hitTest = () => page.evaluate(() => {
        const issues: string[] = [];
        document.querySelectorAll<HTMLButtonElement>('.table-card').forEach((btn, i) => {
          const r = btn.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (top && !btn.contains(top) && top !== btn) issues.push('table-card-covered ' + i + ' by ' + (top.getAttribute('data-hand-card') ? 'hand-card' + top.getAttribute('data-hand-card') : top.className || top.tagName));
        });
        document.querySelectorAll<HTMLElement>('[data-hand-card]').forEach((btn, i) => {
          const r = btn.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height * 0.7, r.height - 2));
          if (top && !btn.contains(top) && top !== btn) issues.push('hand-card-covered ' + i + '=' + btn.getAttribute('data-hand-card'));
        });
        return issues;
      });
      const hitPortrait = await hitTest();
      for (const issue of hitPortrait) problems.push(count + 'p-attack-360: ' + issue);
      await page.screenshot({ path: 'artifacts/durak-layout/layout-' + count + 'p-attack.png' });
      for (const issue of mid.issues) problems.push(count + 'p-attack: ' + issue);
      console.log(count + 'p-attack pairs=' + mid.pairs, 'hit360=' + hitPortrait.length, mid.issues.length ? 'ISSUES ' + mid.issues.join('; ') : 'ok');
      // Desktop/landscape hit-test: every enabled table card must be the top
      // element at its own center (no hand-card overlap).
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(300);
      const hit = await hitTest();
      for (const issue of hit) problems.push(count + 'p-desktop: ' + issue);
      if (count === 3) await page.screenshot({ path: 'artifacts/durak-layout/layout-attack-desktop.png' });
      await context.close();
    }
    expect(problems, problems.join('\n')).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
