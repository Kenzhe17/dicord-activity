import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { MonopolyView } from '../../games/monopoly/engine';

const port = e2ePort(3003);
const base = 'http://127.0.0.1:' + port;

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
function databaseUrl() {
  const credentials = JSON.parse(readFileSync(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  return 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
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
interface Session { token: string; player: { id: string } }
async function api<T>(token: string | null, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status + ' ' + (await response.text()).slice(0, 200));
  return response.json() as Promise<T>;
}

for (const count of [3, 4, 6]) {
  test('monopoly multi-client: ' + count + ' players, UI turns, concurrency, reconnect, timers', async ({ browser }) => {
    test.setTimeout(300000);
    const server = await start();
    const contexts: BrowserContext[] = [];
    try {
      // ---- Node-side setup: sessions, room, join, ready, start ----
      const sessions: Session[] = [];
      for (let i = 0; i < count; i++) sessions.push(await api<Session>(null, '/auth/dev', { name: 'Стол ' + count + 'p-' + i }));
      const host = sessions[0]!.token;
      const room = await api<{ id: string; version: number }>(host, '/rooms', { requestId: crypto.randomUUID(), gameId: 'monopoly', name: 'Multi ' + count, visibility: 'private', settings: { mode: 'classic', maxPlayers: count, startMoney: 1500, turnSeconds: 30, auctionSeconds: 15, tradeSeconds: 60, evenBuild: true } });
      const invite = await api<{ code: string }>(host, '/rooms/' + room.id + '/invite', {});
      const code = invite.code.split(':')[1]!;
      for (const s of sessions.slice(1)) await api(s.token, '/rooms/' + room.id + '/join', { inviteToken: code });
      for (const s of sessions) {
        const view = await api<{ version: number }>(s.token, '/rooms/' + room.id);
        await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: view.version, requestId: crypto.randomUUID() });
      }
      const match = await api<MatchView>(host, '/rooms/' + room.id + '/start', { requestId: crypto.randomUUID() });
      const matchId = match.matchId;

      // ---- One independent browser context per player ----
      const pages: Page[] = [];
      for (const s of sessions) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        contexts.push(context);
        await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), s.token);
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        await page.goto(base);
        await expect(page.locator('.mono-board')).toBeVisible();
        await expect(page.locator('.mono-player')).toHaveCount(count);
        pages.push(page);
      }
      // All clients converge on the same match version.
      const converge = async (version: number) => {
        for (const page of pages) await expect(page.locator('.mono-game')).toHaveAttribute('data-match-version', String(version), { timeout: 20000 });
      };
      let view = await api<MatchView>(host, '/matches/' + matchId);
      await converge(view.version);

      // ---- Timer expiry: idle past the 10s turn deadline, system timeout must advance ----
      if (count === 3) {
        const idleVersion = view.version;
        await new Promise(r => setTimeout(r, 36000));
        const after = await api<MatchView>(host, '/matches/' + matchId);
        expect(after.version).toBeGreaterThan(idleVersion);
        view = after;
        await converge(view.version);
      }

      const st0phaseOk = (v: MatchView) => (v.state as MonopolyView).phase !== 'auction';
      // ---- Drive real UI turns ----
      const pageOf = (playerId: string) => sessions.findIndex(s => s.player.id === playerId);
      let steps = 0, bought = false, traded = false, reloaded = false;
      const maxSteps = count === 3 ? 18 : 14;
      while (view.status === 'active' && steps++ < maxSteps) {
        const state = view.state as MonopolyView;
        const actorPage = pages[pageOf(state.turnPlayerId)]!;
        const prior = view.version;
        if (state.phase === 'awaitRoll' && !state.players[pageOf(state.turnPlayerId)]!.inJail) {
          await actorPage.getByRole('button', { name: 'Бросить кубики' }).click();
        } else if (state.phase === 'awaitRoll') {
          const pay = actorPage.getByRole('button', { name: /Заплатить 50/ });
          if (await pay.isVisible()) await pay.click();
          else {
            const card = actorPage.getByRole('button', { name: /Пропуск \(/ });
            if (await card.isVisible()) await card.click(); else await actorPage.getByRole('button', { name: /Бросить дубли/ }).click();
          }
        } else if (state.phase === 'buy') {
          const buyBtn = actorPage.getByRole('button', { name: /Купить за/ });
          if (!bought && (await buyBtn.isVisible())) { await buyBtn.click(); bought = true; }
          else await actorPage.getByRole('button', { name: /Отказаться/ }).click();
        } else if (state.phase === 'awaitEnd') {
          await actorPage.getByRole('button', { name: 'Завершить ход' }).click();
        } else if (state.phase === 'auction') {
          // Any bank that hasn't passed and isn't leading can act — pick such a player's page.
          const eligible = state.players.find(p => !p.out && state.banks[p.bank]!.active && !state.auction!.passed.includes(p.bank) && state.auction!.leader !== p.bank);
          if (!eligible) break; // auction resolving on its own
          const bidderPage = pages[pageOf(eligible.id)]!;
          const pass = bidderPage.getByRole('button', { name: 'Пас', exact: true });
          if (await pass.isVisible()) await pass.click(); else break;
        } else if (state.phase === 'debt') {
          break; // rare in the opening turns; timeout path covers it
        } else break;
        await expect.poll(async () => (await api<MatchView>(host, '/matches/' + matchId)).version, { timeout: 25000 }).toBeGreaterThan(prior);
        view = await api<MatchView>(host, '/matches/' + matchId);

        // Mid-game reconnect: reload one non-actor client, state must be identical.
        if (!reloaded && steps === Math.floor(maxSteps / 2)) {
          reloaded = true;
          const idx = pageOf(state.turnPlayerId) === 0 ? 1 : 0;
          const before = view;
          await pages[idx]!.reload();
          await expect(pages[idx]!.locator('.mono-board')).toBeVisible();
          await converge(view.version);
          const after = await api<MatchView>(sessions[idx]!.token, '/matches/' + matchId);
          const bs = before.state as MonopolyView, as = after.state as MonopolyView;
          expect(as.players.map(p => [p.position, p.bank])).toEqual(bs.players.map(p => [p.position, p.bank]));
          expect(as.properties).toEqual(bs.properties);
          expect(as.banks.map(b => b.balance)).toEqual(bs.banks.map(b => b.balance));
        }

        // Simultaneous actions: only the turn player may offer trades, and both
        // requests share one expectedVersion — optimistic concurrency must let
        // exactly one win and reject the other with a stale-version conflict.
        if (!traded && view.status === 'active' && steps >= 3 && st0phaseOk(view)) {
          traded = true;
          const st = view.state as MonopolyView;
          const fromIdx = pageOf(st.turnPlayerId);
          const to = st.players.find(p => !p.out && p.id !== st.turnPlayerId && p.id !== st.players[fromIdx]!.id)!;
          const to2 = st.players.find(p => !p.out && p.id !== st.turnPlayerId && p.id !== to.id)!;
          const v = view.version;
          const results = await Promise.allSettled([
            api(sessions[fromIdx]!.token, '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: crypto.randomUUID(), expectedVersion: v, action: { type: 'offer', to: to.id, giveMoney: 10, giveProps: [], getMoney: 0, getProps: [] } }),
            api(sessions[fromIdx]!.token, '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: crypto.randomUUID(), expectedVersion: v, action: { type: 'offer', to: to2.id, giveMoney: 20, giveProps: [], getMoney: 0, getProps: [] } }),
          ]);
          const ok = results.filter(r => r.status === 'fulfilled').length;
          const rejected = results.filter(r => r.status === 'rejected');
          expect(ok, 'exactly one concurrent offer may win').toBe(1);
          if (rejected.length) {
            const msg = String((rejected[0] as PromiseRejectedResult).reason?.message ?? rejected[0]);
            expect(msg).toMatch(/верс|version|CONFLICT/i);
          }
          const latest = await api<MatchView>(host, '/matches/' + matchId);
          expect(latest.version).toBe(v + 1);
          const st2 = latest.state as MonopolyView;
          expect(st2.trades.toMe.length + st2.trades.byMe.length + st2.trades.pendingCount).toBe(1);
          view = latest;
          await converge(view.version);
        }
      }
      expect(steps).toBeGreaterThan(3);
      expect(view.status).toBe('active');
      // Final convergence: every client shows the same version.
      const finalVersion = view.version;
      await converge(finalVersion);
      const finalState = view.state as MonopolyView;
      expect(finalState.players.filter(p => !p.out).length).toBeGreaterThan(0);
    } finally {
      await stop(server);
      await Promise.all(contexts.map(c => c.close()));
    }
  });
}
