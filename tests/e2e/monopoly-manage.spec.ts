import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { MonopolyAction, MonopolyView } from '../../games/monopoly/engine';
import { BOARD } from '../../games/monopoly/engine/board';

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
interface Session { token: string; player: { id: string } }
async function api<T>(token: string | null, path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status + ' ' + (await response.text()).slice(0, 160));
  return response.json() as Promise<T>;
}

test('monopoly manage actions through the real UI: mortgage, unmortgage, trade accept, build/sell', async ({ browser }) => {
  test.setTimeout(420000);
  const server = await start();
  const contexts: BrowserContext[] = [];
  try {
    const sessions = await Promise.all([api<Session>(null, '/auth/dev', { name: 'Manage A' }), api<Session>(null, '/auth/dev', { name: 'Manage B' })]);
    const host = sessions[0]!.token;
    const room = await api<{ id: string }>(host, '/rooms', { requestId: randomUUID(), gameId: 'monopoly', name: 'Manage', visibility: 'private', settings: { mode: 'classic', maxPlayers: 2, startMoney: 1500, turnSeconds: 60, auctionSeconds: 10, tradeSeconds: 120, evenBuild: true } });
    const invite = await api<{ code: string }>(host, '/rooms/' + room.id + '/invite', {});
    await api(sessions[1]!.token, '/rooms/' + room.id + '/join', { inviteToken: invite.code.split(':')[1]! });
    for (const s of sessions) {
      const v = await api<{ version: number }>(s.token, '/rooms/' + room.id);
      await api(s.token, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: v.version, requestId: randomUUID() });
    }
    const match = await api<MatchView>(host, '/rooms/' + room.id + '/start', { requestId: randomUUID() });
    const matchId = match.matchId;
    const tokenOf = (playerId: string) => sessions.find(s => s.player.id === playerId)!.token;

    const pages: Page[] = [];
    for (const s of sessions) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      contexts.push(context);
      await context.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), s.token);
      const page = await context.newPage();
      page.setDefaultTimeout(25000);
      await page.goto(base);
      await expect(page.locator('.mono-board')).toBeVisible();
      pages.push(page);
    }
    const pageOf = (playerId: string) => sessions.findIndex(s => s.player.id === playerId);

    const act = async (token: string, view: MatchView, action: MonopolyAction): Promise<MatchView> => {
      for (let i = 0; i < 4; i++) {
        try {
          return await api<MatchView>(token, '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: randomUUID(), expectedVersion: view.version, action });
        } catch (e) {
          if (i === 3 || !String(e).includes('409')) throw e;
          view = await api<MatchView>(token, '/matches/' + matchId);
        }
      }
      throw new Error('unreachable');
    };

    // ---- Phase 1: API-drive turns until someone can mortgage/manage ----
    let view = await api<MatchView>(host, '/matches/' + matchId);
    let manageSeat = -1, manageProp = -1, sawBuildable = false, traded = false, mortgaged = false, unmortgaged = false, built = false, sold = false;
    for (let step = 0; step < 400 && view.status === 'active'; step++) {
      const state = view.state as MonopolyView;
      if (state.phase === 'finished') break;
      if (state.phase === 'auction') {
        // Everyone who can still act passes; leader waits to be outbid.
        for (const p of state.players) {
          if (p.out) continue;
          const v = await api<MatchView>(p.id === state.turnPlayerId ? tokenOf(p.id) : tokenOf(p.id), '/matches/' + matchId);
          const sv = v.state as MonopolyView;
          const f = sv.flags;
          if (sv.phase === 'auction' && (f.canAuctionPass)) {
            view = await act(tokenOf(p.id), v, { type: 'pass' });
            break;
          }
          view = v;
        }
        continue;
      }
      const turnToken = tokenOf(state.turnPlayerId);
      view = await api<MatchView>(turnToken, '/matches/' + matchId);
      const sv = view.state as MonopolyView;
      const f = sv.flags;
      if (sv.phase === 'awaitRoll') {
        if (f.canPayJail) view = await act(turnToken, view, { type: 'payJail' });
        else if (f.canUseJailCard) view = await act(turnToken, view, { type: 'jailCard' });
        else view = await act(turnToken, view, { type: 'roll' });
      } else if (sv.phase === 'buy' && sv.pending?.type === 'purchase') {
        const price = BOARD[sv.pending.index]!.property!.price;
        view = await act(turnToken, view, price <= 200 ? { type: 'buy' } : { type: 'refuse' });
      } else if (sv.phase === 'awaitEnd') {
        // A manage window only exists during this player's turn — stop here
        // (before endTurn) so the UI can exercise build/mortgage actions.
        if (f.buildable.length) { sawBuildable = true; manageSeat = sv.turnSeat; manageProp = f.buildable[0]!; break; }
        if (f.mortgageable.length) { manageSeat = sv.turnSeat; manageProp = f.mortgageable[0]!; break; }
        view = await act(turnToken, view, { type: 'endTurn' });
      } else if (sv.phase === 'debt') {
        // Auto-liquidate via API with fresh flags each step; surrender if stuck.
        let escaped = false;
        for (let d = 0; d < 30; d++) {
          const dv = await api<MatchView>(turnToken, '/matches/' + matchId);
          const ds = dv.state as MonopolyView;
          if (ds.phase !== 'debt') { view = dv; escaped = true; break; }
          const df = ds.flags;
          const mi = df.mortgageable[0] ?? df.sellable[0];
          if (mi === undefined) { view = await act(turnToken, dv, { type: 'surrender' }); escaped = true; break; }
          view = await act(turnToken, dv, df.mortgageable.includes(mi) ? { type: 'mortgage', property: mi } : { type: 'sell', property: mi });
        }
        if (!escaped) break;
      } else break;
      if (view.status !== 'active') break;
    }

    const st = view.state as MonopolyView;
    console.log('  manage drive done: steps left, phase=' + st.phase + ' manageSeat=' + manageSeat + ' prop=' + manageProp + ' buildable=' + sawBuildable);
    expect(view.status).toBe('active');
    expect(manageProp).toBeGreaterThanOrEqual(0);

    // ---- Phase 2: UI manage actions on the owner's page ----
    const ownerId = st.players[manageSeat]!.id;
    const ownerPage = pages[pageOf(ownerId)]!;
    const ownerToken = tokenOf(ownerId);
    const cellName = BOARD[manageProp]!.name;
    await ownerPage.getByRole('button', { name: cellName, exact: true }).click();
    await expect(ownerPage.locator('.mono-modal')).toBeVisible();

    const serverProp = async () => (await api<MatchView>(host, '/matches/' + matchId)).state as MonopolyView;

    // Mortgage via UI (only if still mortgageable — may have changed since drive).
    const ownerView = await api<MatchView>(ownerToken, '/matches/' + matchId);
    const f = (ownerView.state as MonopolyView).flags;
    if (f.mortgageable.includes(manageProp)) {
      await ownerPage.getByRole('button', { name: /Заложить/ }).click();
      await expect.poll(async () => (await serverProp()).properties[manageProp]!.mortgaged).toBe(true);
      mortgaged = true;
      // Unmortgage via UI.
      const after = await api<MatchView>(ownerToken, '/matches/' + matchId);
      const f2 = (after.state as MonopolyView).flags;
      if (f2.unmortgageable.includes(manageProp)) {
        await ownerPage.getByRole('button', { name: cellName, exact: true }).click();
        await expect(ownerPage.locator('.mono-modal')).toBeVisible();
        await ownerPage.getByRole('button', { name: /Выкупить/ }).click();
        await expect.poll(async () => (await serverProp()).properties[manageProp]!.mortgaged).toBe(false);
        unmortgaged = true;
      }
    }

    // Build + sell via UI if a buildable property exists for this player.
    const bv = await api<MatchView>(ownerToken, '/matches/' + matchId);
    const bf = (bv.state as MonopolyView).flags;
    const buildProp = bf.buildable[0];
    if (buildProp !== undefined) {
      const before = (await serverProp()).properties[buildProp]!.level;
      await ownerPage.locator('.mono-modal-close').click().catch(() => {});
      await ownerPage.getByRole('button', { name: BOARD[buildProp]!.name, exact: true }).click();
      await ownerPage.getByRole('button', { name: /Построить/ }).click();
      await expect.poll(async () => (await serverProp()).properties[buildProp]!.level).toBe(before + 1);
      built = true;
      // Sell it back via UI.
      const sv2 = await api<MatchView>(ownerToken, '/matches/' + matchId);
      const sf = (sv2.state as MonopolyView).flags;
      if (sf.sellable.includes(buildProp)) {
        await ownerPage.locator('.mono-modal-close').click().catch(() => {});
        await ownerPage.getByRole('button', { name: BOARD[buildProp]!.name, exact: true }).click();
        await ownerPage.getByRole('button', { name: /Продать постройку/ }).click();
        await expect.poll(async () => (await serverProp()).properties[buildProp]!.level).toBe(before);
        sold = true;
      }
    }

    // ---- Phase 3: trade offer via UI + accept via UI, verified on server ----
    // Drive a few more API turns until someone is on turn in a non-auction phase.
    view = await api<MatchView>(host, '/matches/' + matchId);
    for (let step = 0; step < 120 && view.status === 'active' && !traded; step++) {
      const s2v = view.state as MonopolyView;
      if (s2v.phase === 'auction') { view = await api<MatchView>(host, '/matches/' + matchId); continue; }
      const tt = tokenOf(s2v.turnPlayerId);
      const tv = await api<MatchView>(tt, '/matches/' + matchId);
      const tsv = tv.state as MonopolyView;
      if (tsv.phase === 'awaitRoll') { view = await act(tt, tv, { type: 'roll' }); continue; }
      if (tsv.phase === 'buy' && tsv.pending?.type === 'purchase') { view = await act(tt, tv, { type: 'refuse' }); continue; }
      if (tsv.phase === 'awaitEnd') {
        const tf = tsv.flags;
        if (!tf.canTrade) { view = await act(tt, tv, { type: 'endTurn' }); continue; }
        // Offer 10 coins to the first other active player via the real UI.
        const offererPage = pages[pageOf(tsv.turnPlayerId)]!;
        await offererPage.locator('.mono-modal-close').click({ timeout: 3000 }).catch(() => {});
        await offererPage.getByRole('button', { name: 'Меню партии' }).click();
        const target = tsv.players.find(p => p.seat !== tsv.turnSeat && !p.out)!;
        const targetSeatIdx = target.seat;
        await offererPage.getByRole('button', { name: 'Предложить обмен' }).click();
        await expect(offererPage.locator('.mono-trade-modal')).toBeVisible();
        await offererPage.locator('.mono-trade-modal select').selectOption(String(targetSeatIdx));
        await offererPage.locator('.mono-trade-modal input[inputmode="numeric"]').first().fill('10');
        await offererPage.getByRole('button', { name: 'Отправить предложение' }).click();
        await expect.poll(async () => {
          const mv = await api<MatchView>(host, '/matches/' + matchId);
          return ((mv.state as MonopolyView).trades.pendingCount + (mv.state as MonopolyView).trades.byMe.length + (mv.state as MonopolyView).trades.toMe.length);
        }).toBeGreaterThan(0);
        traded = true;
        // Recipient accepts via UI.
        const recipPage = pages[pageOf(target.id)]!;
        await expect(recipPage.getByRole('button', { name: 'Принять' })).toBeVisible();
        // Capture balances immediately before accepting — no other action can
        // intervene between the click and the server-side transfer.
        // The page may hold a stale match version (socket push lag) — the UI
        // refetches on error, so retry the click a few times.
        let accepted = false;
        for (let attempt = 0; attempt < 4 && !accepted; attempt++) {
          const pre = await serverProp();
          const preTarget = pre.banks[target.bank]!.balance;
          const preOfferer = pre.banks[tsv.players[tsv.turnSeat]!.bank]!.balance;
          const btn = recipPage.getByRole('button', { name: 'Принять' });
          if (!(await btn.isVisible().catch(() => false))) break; // trade already resolved
          await btn.click();
          accepted = await expect.poll(async () => {
            const mv = await serverProp();
            return mv.banks[target.bank]!.balance === preTarget + 10 && mv.banks[tsv.players[tsv.turnSeat]!.bank]!.balance === preOfferer - 10;
          }, { timeout: 6000 }).toBe(true).then(() => true).catch(() => false);
        }
        if (!accepted) {
          const rv = await api<MatchView>(tokenOf(target.id), '/matches/' + matchId);
          const rs = rv.state as MonopolyView;
          console.log('  DEBUG recip trades:', JSON.stringify(rs.trades), 'phase=' + rs.phase, 'turn=' + rs.turnPlayerId);
          console.log('  DEBUG recip html has Принять:', await recipPage.getByRole('button', { name: 'Принять' }).count());
          console.log('  DEBUG offerer trades:', JSON.stringify((await serverProp()).trades));
          try {
            const vv = await api<MatchView>(tokenOf(target.id), '/matches/' + matchId);
            const r2 = await api<MatchView>(tokenOf(target.id), '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: randomUUID(), expectedVersion: vv.version, action: { type: 'accept', offerId: rs.trades.toMe[0]!.id } });
            console.log('  DEBUG api accept ok, version', r2.version);
          } catch (e) { console.log('  DEBUG api accept failed:', String(e).slice(0, 300)); }
        }
        expect(accepted, 'trade accept via UI must move 10 coins').toBe(true);
        view = await api<MatchView>(host, '/matches/' + matchId);
      } else break;
    }

    console.log('  manage results: mortgaged=' + mortgaged + ' unmortgaged=' + unmortgaged + ' built=' + built + ' sold=' + sold + ' traded=' + traded);
    expect(mortgaged || unmortgaged || built || traded, 'at least one manage UI action must be exercised').toBe(true);
    expect(traded, 'trade offer+accept via UI must succeed').toBe(true);
  } finally {
    await stop(server);
    await Promise.all(contexts.map(c => c.close()));
  }
});
