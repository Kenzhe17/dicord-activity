import { test, expect } from '@playwright/test';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';

const port = e2ePort(3005);
const base = 'http://127.0.0.1:' + port;
const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [430, 932]] as const;

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
interface CodeView { phase: string; currentTeam: 'red' | 'blue'; me: { team: string; role: string }; board: { index: number; revealed: boolean }[] }
interface MatchView { matchId: string; roomId: string; version: number; status: string; state: CodeView }

async function makeMatch() {
  const sessions: Session[] = [];
  for (let i = 0; i < 4; i++) {
    const response = await fetch(base + '/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Code ' + i }) });
    if (!response.ok) throw new Error('auth/dev ' + response.status);
    sessions.push(await response.json() as Session);
  }
  const host = sessions[0]!.token;
  const room = await api<{ id: string }>(host, '/rooms', { requestId: crypto.randomUUID(), gameId: 'codenames', name: 'Layout', visibility: 'public', settings: { ruleSet: 'unlimited', timed: false, traitor: false, hintSeconds: 60, guessSeconds: 180, dictionary: 'ru' } });
  for (const s of sessions.slice(1)) await api(s.token, '/rooms/' + room.id + '/join', {});
  for (const s of sessions) {
    const view = await api<{ version: number }>(s.token, '/rooms/' + room.id);
    await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: view.version, requestId: crypto.randomUUID() });
  }
  await api(host, '/rooms/' + room.id + '/start', { requestId: crypto.randomUUID() });
  // Draft: p0 red spy, p1 red op, p2 blue spy, p3 blue op.
  const teams: [string, string][] = [['red', 'spymaster'], ['red', 'operative'], ['blue', 'spymaster'], ['blue', 'operative']];
  for (const [i, s] of sessions.entries()) {
    const view = await activeMatch(s.token);
    const [team, role] = teams[i]!;
    await api(s.token, '/matches/' + view.matchId + '/actions', { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: crypto.randomUUID(), expectedVersion: view.version, action: { type: 'choose', team, role } });
  }
  const spyView = await activeMatch(host);
  await api(host, '/matches/' + spyView.matchId + '/actions', { protocol: 1, roomId: spyView.roomId, matchId: spyView.matchId, requestId: crypto.randomUUID(), expectedVersion: spyView.version, action: { type: 'start' } });
  return { sessions, roomId: room.id };
}
async function activeMatch(token: string): Promise<MatchView> {
  const me = await api<{ match: MatchView | null }>(token, '/bootstrap');
  if (!me.match) throw new Error('no active match');
  return me.match;
}
async function boardState(token: string): Promise<MatchView> { return activeMatch(token); }

test('codenames layout: board fits mobile viewports, pick flow works', async ({ browser }) => {
  test.setTimeout(300000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  const problems: string[] = [];
  try {
    const { sessions } = await makeMatch();
    const hostToken = sessions[0]!.token;
    const match = await boardState(hostToken);
    expect(match.state.phase).toBe('hint');

    const context = await browser.newContext({ viewport: { width: VIEWPORTS[0][0], height: VIEWPORTS[0][1] } });
    await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), hostToken);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(base);
    await expect(page.locator('.codeboard .codecard')).toHaveCount(25);

    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const report = await page.evaluate(() => {
        const doc = { sw: document.documentElement.scrollWidth, iw: innerWidth };
        const cards = [...document.querySelectorAll('.codeboard .codecard')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
        const board = document.querySelector('.codeboard')?.getBoundingClientRect();
        const issues: string[] = [];
        if (doc.sw > doc.iw + 1) issues.push('h-scroll ' + doc.sw + '>' + doc.iw);
        if (!board || board.width > doc.iw + 1 || board.x < -1) issues.push('board-out');
        cards.forEach((r, i) => {
          if (r.x < -1 || r.right > doc.iw + 1 || r.w < 30 || r.h < 30) issues.push('card-' + i + ' ' + JSON.stringify(r));
        });
        // every card word must be fully inside its card (no clipped overflow)
        const clipped = [...document.querySelectorAll('.codeboard .codecard')].filter(el => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2).length;
        if (clipped) issues.push('clipped-words ' + clipped);
        return { issues, cards: cards.length, minW: Math.min(...cards.map(c => c.w)), minH: Math.min(...cards.map(c => c.h)) };
      });
      const tag = width + 'x' + height;
      await page.screenshot({ path: 'tests/.artifacts/codenames-' + tag + '.png' });
      for (const issue of report.issues) problems.push(tag + ': ' + issue);
      console.log(tag, 'cards=' + report.cards, 'min=' + report.minW.toFixed(0) + 'x' + report.minH.toFixed(0), report.issues.length ? 'ISSUES ' + report.issues.join('; ') : 'ok');
    }

    // Drive a real hint as the current team's spymaster, then play a pick as
    // that team's operative through the actual UI at phone size.
    const before = await boardState(hostToken);
    const team = before.state.currentTeam;
    const spyIdx = team === 'red' ? 0 : 2;
    const opIdx = team === 'red' ? 1 : 3;
    const spyToken = sessions[spyIdx]!.token;
    const opToken = sessions[opIdx]!.token;
    const view = await boardState(spyToken);
    await api(spyToken, '/matches/' + view.matchId + '/actions', { protocol: 1, roomId: view.roomId, matchId: view.matchId, requestId: crypto.randomUUID(), expectedVersion: view.version, action: { type: 'hint', word: 'абракадабра', count: 1 } });

    const opContext = await browser.newContext({ viewport: { width: 360, height: 640 } });
    await opContext.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), opToken);
    const opPage = await opContext.newPage();
    opPage.setDefaultTimeout(15000);
    await opPage.goto(base);
    const pickable = opPage.locator('.codecard.pickable');
    await expect(pickable.first()).toBeVisible();
    const pickCount = await pickable.count();
    expect(pickCount).toBe(before.state.board.filter(c => !c.revealed).length);
    // Tap a card: it must reveal without layout breakage.
    await pickable.first().click();
    await opPage.waitForTimeout(400);
    const afterPick = await boardState(opToken);
    const revealed = afterPick.state.board.filter(c => c.revealed).length;
    expect(revealed).toBe(before.state.board.filter(c => !c.revealed).length - pickCount + 1);
    const stillOk = await opPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    if (!stillOk) problems.push('post-pick h-scroll');
    await opPage.screenshot({ path: 'tests/.artifacts/codenames-guess-360x640.png' });
    await opContext.close();
    await context.close();
    expect(problems, problems.join('\n')).toEqual([]);
  } finally {
    await stopServer(server);
  }
});
