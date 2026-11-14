import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView } from '../../packages/shared/src';
import type { MafiaView, MafiaRole } from '../../games/mafia/engine';

const port = e2ePort(3006);
const base = 'http://127.0.0.1:' + port;
const VIEWPORTS = [
  { w: 320, h: 568, tag: '320' },
  { w: 375, h: 667, tag: '375' },
  { w: 390, h: 844, tag: '390' },
  { w: 430, h: 932, tag: '430' },
  { w: 1280, h: 900, tag: '1280' },
] as const;
const PLAYER_COUNT = 6;

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
  const watchdog = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 25000);
  try {
    if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM');
    await exited;
    if (forced) throw new Error('Backend did not shut down gracefully');
  } finally { clearTimeout(watchdog); }
}

async function api<T>(token: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 429) { await new Promise(r => setTimeout(r, Math.min(8000, 500 * (attempt + 1)))); continue; }
    if (!response.ok) throw new Error('API ' + path + ' -> ' + response.status + ' ' + (await response.text()).slice(0, 200));
    return response.json() as Promise<T>;
  }
  throw new Error('rate limited ' + path);
}

interface AuditResult { issues: string[]; seats: number; pickable: number; tabs: number }

/** Layout/geometry audit run inside the page: overflow, out-of-bounds, control sizes. */
async function audit(page: Page, tag: string, shotName: string, problems: string[]) {
  const report = await page.evaluate((): AuditResult & { doc: unknown } => {
    const issues: string[] = [];
    const doc = { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight };
    if (doc.sw > doc.iw + 1) issues.push('page-h-overflow sw=' + doc.sw + ' iw=' + doc.iw);
    const rect = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const game = rect(document.querySelector('.mafia-game'));
    if (!game) issues.push('no-.mafia-game');
    else {
      if (game.x > 1 || game.right < doc.iw - 1) issues.push('game-not-fullwidth ' + JSON.stringify(game));
      if (game.bottom < doc.ih - 2) issues.push('game-not-fullheight bottom=' + game.bottom + ' ih=' + doc.ih);
      if (game.y < -1) issues.push('game-out-of-viewport');
    }
    const tools = document.querySelector('.room-tools');
    if (tools && getComputedStyle(tools).display !== 'none') issues.push('room-tools-visible-during-play');
    const topbar = rect(document.querySelector('.mafia-topbar'));
    if (!topbar || topbar.y < -1 || topbar.bottom > doc.ih + 1) issues.push('topbar-out');
    const clock = document.querySelector('.mafia-clock');
    if (clock) { const r = rect(clock); if (r && (r.x < -1 || r.right > doc.iw + 1)) issues.push('clock-out'); }
    const seats = [...document.querySelectorAll('.mafia-seat')];
    let out = 0;
    seats.forEach((el, i) => { const r = rect(el); if (r && (r.x < -1 || r.right > doc.iw + 1)) { out++; issues.push('seat-out-' + i); } });
    void out;
    // inner horizontal scrollers
    for (const sel of ['.mafia-scroll', '.mafia-chat', '.mafia-feed', '.mafia-topbar']) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el && el.scrollWidth > el.clientWidth + 1) issues.push('inner-h-scroll ' + sel + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
    const tabs = [...document.querySelectorAll('.mafia-chat-tabs button')];
    tabs.forEach((el, i) => { const r = rect(el); if (r && (r.x < -1 || r.right > doc.iw + 1)) issues.push('chat-tab-out-' + i); });
    const send = rect(document.querySelector('.mafia-send'));
    if (send && send.h < 36) issues.push('send-too-small h=' + send.h);
    const input = document.querySelector('.mafia-chat-form input') as HTMLInputElement | null;
    if (input) { const r = rect(input); if (r && (r.x < -1 || r.right > doc.iw + 1)) issues.push('chat-input-out'); }
    const bar = rect(document.querySelector('.mafia-actionbar'));
    if (bar) {
      if (bar.y < -1 || bar.bottom > doc.ih + 1) issues.push('actionbar-out');
      const btn = rect(bar ? document.querySelector('.mafia-actionbar .button') : null);
      if (btn && btn.w < doc.iw * 0.5) issues.push('actionbar-btn-not-fullwidth w=' + btn.w);
    }
    const result = rect(document.querySelector('.mafia-result'));
    if (result && (result.x < -1 || result.right > doc.iw + 1 || result.bottom > doc.ih + 1)) issues.push('result-out');
    const menu = rect(document.querySelector('.game-menu'));
    if (menu && (menu.x < -1 || menu.right > doc.iw + 1)) issues.push('menu-out');
    return { issues, seats: seats.length, pickable: document.querySelectorAll('.mafia-seat.pickable').length, tabs: tabs.length, doc };
  });
  for (const issue of report.issues) problems.push(tag + ': ' + issue);
  await page.screenshot({ path: 'tests/.artifacts/mafia/mafia-' + shotName + '-' + tag + '.png' });
  console.log(tag, shotName, 'seats=' + report.seats, 'pickable=' + report.pickable, 'tabs=' + report.tabs, report.issues.length ? 'ISSUES ' + report.issues.join('; ') : 'ok');
}

test('mafia: mobile + desktop layout across all phases, full match to finished', async ({ browser }) => {
  test.setTimeout(900000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  const problems: string[] = [];
  const contexts: BrowserContext[] = [];
  try {
    // --- API-driven setup: 6 players, blitz pace ---
    const tokens: string[] = [];
    for (let i = 0; i < PLAYER_COUNT; i++) {
      const session = await api<{ token: string }>(tokens[0] ?? '', '/auth/dev', { name: 'Мафия E2E ' + i }).catch(async () => {
        const response = await fetch(base + '/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Мафия E2E ' + i }) });
        if (!response.ok) throw new Error('auth/dev ' + response.status);
        return response.json() as Promise<{ token: string }>;
      });
      tokens.push(session.token);
    }
    const host = tokens[0]!;
    const room = await api<{ id: string; version: number }>(host, '/rooms', { requestId: crypto.randomUUID(), gameId: 'mafia', name: 'Mafia E2E', visibility: 'public', settings: { pace: 'blitz' } });
    for (const t of tokens.slice(1)) await api(t, '/rooms/' + room.id + '/join', {});
    for (const t of tokens) {
      const view = await api<{ version: number }>(t, '/rooms/' + room.id);
      await api(t, '/rooms/' + room.id + '/ready', { ready: true, expectedVersion: view.version, requestId: crypto.randomUUID() });
    }
    const started = await api<MatchView>(host, '/rooms/' + room.id + '/start', { requestId: crypto.randomUUID() });
    const matchId = started.matchId;

    const getMatch = (t: string) => api<MatchView>(t, '/matches/' + matchId);
    const views = await Promise.all(tokens.map(getMatch));
    const seatOf = views.map(v => (v.state as MafiaView).you.seat);
    const roleOf = views.map(v => (v.state as MafiaView).you.role.kind as MafiaRole);
    const playerIdOf = views.map(v => (v.state as MafiaView).players[(v.state as MafiaView).you.seat]!.id);
    console.log('roles', roleOf.map((r, i) => i + ':' + r).join(' '), 'seats', seatOf.join(','));

    // Assign page tokens by role: doctor -> 320, sheriff -> 375, mafia -> 390,
    // town -> 430, leftover -> 1280; one town stays API-only.
    const used = new Set<number>();
    const roleOrder: MafiaRole[] = ['doctor', 'sheriff', 'mafia', 'town'];
    const pageTokenIdx = VIEWPORTS.map((_, i) => {
      const want = roleOrder[i] ?? 'town';
      for (let j = 0; j < views.length; j++) {
        if (used.has(j)) continue;
        if (roleOf[j] === want) { used.add(j); return j; }
      }
      for (let j = 0; j < views.length; j++) if (!used.has(j)) { used.add(j); return j; }
      return -1;
    });
    console.log('page tokens', pageTokenIdx.map((i, k) => VIEWPORTS[k]!.tag + '=' + i + '(' + roleOf[i] + ')').join(' '));

    // --- Open real browser pages ---
    contexts.push(...await Promise.all(VIEWPORTS.map(v => browser.newContext({ viewport: { width: v.w, height: v.h } }))));
    const pages: Page[] = [];
    await Promise.all(contexts.map(async (ctx, i) => {
      await ctx.addInitScript(t => sessionStorage.setItem('rize.arcade.session', t), tokens[pageTokenIdx[i]!]!);
      const page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      await page.goto(base);
      pages[i] = page;
    }));
    await Promise.all(pages.map(p => expect(p.locator('.mafia-game')).toBeVisible()));
    const pageOfToken = new Map<number, Page>();
    pageTokenIdx.forEach((ti, i) => pageOfToken.set(ti, pages[i]!));
    const mafiaIdx = roleOf.indexOf('mafia');
    const sheriffIdx = roleOf.indexOf('sheriff');
    const doctorIdx = roleOf.indexOf('doctor');

    const phaseOf = async () => ((await getMatch(host)).state as MafiaView).phase;
    const PAST: Record<string, string[]> = {
      reveal: ['night', 'dawn', 'discussion', 'voting', 'runoff', 'finished'],
      night: ['dawn', 'discussion', 'voting', 'runoff', 'finished'],
      dawn: ['discussion', 'voting', 'runoff', 'finished'],
      discussion: ['voting', 'runoff', 'finished'],
      voting: ['finished'],
    };
    const waitPhase = async (phase: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      const past = PAST[phase] ?? [];
      let last = '';
      while (Date.now() < deadline) {
        let p: string;
        try { p = await phaseOf(); } catch (error) { console.log('phase poll error:', String(error).slice(0, 120)); await new Promise(r => setTimeout(r, 1000)); continue; }
        if (p !== last) { console.log('phase ->', p); last = p; }
        if (p === phase || (phase === 'voting' && p === 'runoff')) return true;
        if (past.includes(p)) return false; // window missed — foreign ticks may skip short phases
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    };
    const auditAll = async (shot: string, onlyPage?: Page) => {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]!;
        if (onlyPage && p !== onlyPage) continue;
        await audit(p, VIEWPORTS[i]!.tag, shot, problems);
      }
    };

    // --- REVEAL ---
    if (await waitPhase('reveal', 30000)) {
      for (const p of pages) await expect(p.locator('.mafia-game')).toHaveAttribute('data-phase', 'reveal');
      await auditAll('reveal');
      // role card open during reveal, seats rendered, clock ticking
      for (const p of pages) {
        await expect(p.locator('.mafia-rolecard')).toHaveAttribute('open', '');
        await expect(p.locator('.mafia-clock')).toBeVisible();
      }
    } else console.log('reveal phase missed before pages loaded');

    // --- NIGHT ---
    const nightSeen = await waitPhase('night', 150000);
    expect(nightSeen, 'night phase reached').toBe(true);
    await auditAll('night');
    // Role pages: verify actionbar + pickable seats, then confirm via real UI clicks.
    const nightActions: { idx: number; kind: 'nightKill' | 'sheriffCheck' | 'doctorHeal'; key: 'kill' | 'check' | 'heal' }[] = [];
    if (mafiaIdx >= 0) nightActions.push({ idx: mafiaIdx, kind: 'nightKill', key: 'kill' });
    if (sheriffIdx >= 0) nightActions.push({ idx: sheriffIdx, kind: 'sheriffCheck', key: 'check' });
    if (doctorIdx >= 0) nightActions.push({ idx: doctorIdx, kind: 'doctorHeal', key: 'heal' });
    const nightUI = nightActions.map(async a => {
      const page = pageOfToken.get(a.idx);
      const t = tokens[a.idx]!;
      if (!page) { // API-only player: submit via API
        const m = await getMatch(t);
        const alive = (m.state as MafiaView).players.filter(p => p.alive && p.seat !== (m.state as MafiaView).you.seat);
        const target = alive.find(p => p.role !== 'mafia')?.seat ?? alive[0]?.seat;
        if (target !== undefined) await api(t, '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: crypto.randomUUID(), expectedVersion: m.version, action: { type: a.kind, target } });
        return;
      }
      await expect(page.locator('.mafia-actionbar')).toBeVisible();
      // Concurrent test servers share the DB and bump match.version, so a UI
      // submit can hit a stale expectedVersion (409). Retry the real UI flow.
      for (let attempt = 0; attempt < 5; attempt++) {
        const mv = (await getMatch(t)).state as MafiaView;
        if (mv.phase !== 'night' || mv.you.nightAction[a.key] !== null) return;
        if ((await page.locator('.mafia-seat.picked').count()) === 0) {
          await page.locator('.mafia-seat.pickable').first().click();
        }
        await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
        const landed = await expect.poll(async () => {
          const m = await getMatch(t);
          return (m.state as MafiaView).you.nightAction[a.key] !== null;
        }, { timeout: 8000 }).toBe(true).then(() => true).catch(() => false);
        if (landed) return;
      }
      throw new Error('night action ' + a.kind + ' never landed via UI for token ' + a.idx);
    });
    await Promise.all(nightUI);
    // town pages must show no pickable seats at night
    for (const [ti, page] of pageOfToken) {
      if (ti === mafiaIdx || ti === sheriffIdx || ti === doctorIdx) continue;
      await expect(page.locator('.mafia-seat.pickable')).toHaveCount(0);
    }
    // mafia page sees the secret chat tab during night
    const mafiaPage = pageOfToken.get(mafiaIdx);
    if (mafiaPage) await expect(mafiaPage.locator('.mafia-chat-tabs button')).toHaveCount(2);
    await auditAll('night-done', mafiaPage);

    // --- DAWN (5s blitz) — best effort ---
    const dawnSeen = await waitPhase('dawn', 10000);
    if (dawnSeen) { await auditAll('dawn'); console.log('dawn captured'); } else console.log('dawn too fast — API-verified only');

    // --- DISCUSSION (60s) ---
    expect(await waitPhase('discussion', 180000), 'discussion reached').toBe(true);
    await auditAll('discussion');
    const discussPage = pageOfToken.get(mafiaIdx) ?? pages[2]!;
    await expect(discussPage.locator('.mafia-phase-note')).toContainText('День 1');
    // real UI chat round-trip
    const chatText = 'E2E привет ' + Date.now() % 1000;
    await discussPage.locator('.mafia-chat-form input').fill(chatText);
    await discussPage.locator('.mafia-send').click();
    await expect(discussPage.locator('.mafia-msg', { hasText: chatText })).toBeVisible();
    // chat tabs reachable on every viewport
    for (const p of pages) await expect(p.locator('.mafia-chat-tabs button').first()).toBeVisible();
    await auditAll('discussion-chat');

    // --- VOTING ---
    expect(await waitPhase('voting', 150000), 'voting reached').toBe(true);
    await auditAll('voting');
    const votePage = pageOfToken.get(mafiaIdx) ?? pages[2]!;
    await expect(votePage.locator('.mafia-votebar')).toBeVisible();
    await expect(votePage.locator('.mafia-votebar')).toContainText('исключить');
    // real UI vote: click a pickable seat on the deep-dive page (retry on 409s)
    let uiVoted = false;
    for (let attempt = 0; attempt < 5 && !uiVoted; attempt++) {
      const mv = (await getMatch(tokens[mafiaIdx]!)).state as MafiaView;
      if (mv.phase !== 'voting' && mv.phase !== 'runoff') break;
      if (mv.you.vote === null) {
        const pickableCount = await votePage.locator('.mafia-seat.pickable').count();
        if (pickableCount === 0) break;
        await votePage.locator('.mafia-seat.pickable').first().click();
      }
      uiVoted = await expect.poll(async () => {
        const m = await getMatch(tokens[mafiaIdx]!);
        return (m.state as MafiaView).you.vote !== null;
      }, { timeout: 8000 }).toBe(true).then(() => true).catch(() => false);
    }
    expect(uiVoted, 'UI vote landed').toBe(true);
    // API votes from the rest to populate the live tally
    for (const [i, t] of tokens.entries()) {
      if (i === mafiaIdx) continue; // already voted via UI
      const m = await getMatch(t);
      const mv = m.state as MafiaView;
      if (!mv.you.alive || mv.you.vote !== null) continue;
      // target must be an alive seat other than the voter's own
      const mySeat = mv.you.seat;
      const tgt = mv.players.filter(p => p.alive && p.seat !== mySeat).map(p => p.seat);
      const action = i % 2 === 0 && tgt.length ? { type: 'vote' as const, target: tgt[0]! } : { type: 'vote' as const, target: 'skip' as const };
      await api(t, '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: crypto.randomUUID(), expectedVersion: m.version, action });
    }
    await expect(votePage.locator('.mafia-poll')).toBeVisible({ timeout: 20000 });
    await auditAll('voting-tally');

    // --- FINISH: forfeit down to mafia + 1 so the mafia wins outright ---
    // token index -> seat, refreshed from the host view (seats never change)
    const tokenByPlayerId = new Map(playerIdOf.map((id, i) => [id, i]));
    // Forfeit every alive non-keeper until only mafia + one other remain.
    for (let round = 0; round < PLAYER_COUNT + 2; round++) {
      const m = await getMatch(host);
      const mv = m.state as MafiaView;
      if (mv.phase === 'finished' || mv.winner) break;
      const aliveSeatsNow = mv.players.filter(p => p.alive).map(p => p.seat);
      if (aliveSeatsNow.length <= 2) { await new Promise(r => setTimeout(r, 400)); continue; }
      const mafiaSeatNow = mv.players.find(p => p.id === playerIdOf[mafiaIdx])?.seat;
      // keep mafia + the desktop token if it's still alive, else any one other
      const keepSeats = new Set<number>([mafiaSeatNow!]);
      const desktopSeat = mv.players.find(p => p.id === playerIdOf[pageTokenIdx[4]!])?.seat;
      if (desktopSeat !== undefined && mv.players.find(p => p.seat === desktopSeat)?.alive) keepSeats.add(desktopSeat);
      else { const other = aliveSeatsNow.find(s => s !== mafiaSeatNow); if (other !== undefined) keepSeats.add(other); }
      let forfeitedOne = false;
      for (const seat of aliveSeatsNow) {
        if (keepSeats.has(seat)) continue;
        const pid = mv.players.find(p => p.seat === seat)?.id;
        const ti = pid ? tokenByPlayerId.get(pid) : undefined;
        if (ti === undefined) continue;
        const t = tokens[ti]!;
        const fresh = await getMatch(t);
        const fv = fresh.state as MafiaView;
        if (fv.phase === 'finished') break;
        if (!fv.you.alive) continue;
        await api(t, '/matches/' + matchId + '/actions', { protocol: 1, roomId: room.id, matchId, requestId: crypto.randomUUID(), expectedVersion: fresh.version, action: { type: 'forfeit' } }).catch(() => {});
        forfeitedOne = true;
      }
      if (!forfeitedOne) break;
    }
    await expect.poll(async () => ((await getMatch(host)).state as MafiaView).phase, { timeout: 45000 }).toBe('finished');
    const finalView = (await getMatch(host)).state as MafiaView;
    console.log('finished winner=' + finalView.winner);

    // --- FINISHED SCREEN on every viewport ---
    for (const p of pages) await expect(p.locator('.mafia-result')).toBeVisible({ timeout: 15000 });
    await auditAll('finished');
    for (const p of pages) {
      await expect(p.locator('.mafia-result h2')).toBeVisible();
      await expect(p.locator('.mafia-roster-row').first()).toBeVisible();
    }
    const resultPage = pageOfToken.get(mafiaIdx) ?? pages[2]!;
    await expect(resultPage.locator('.mafia-result')).toContainText(/побед|Партия завершена|прервана/);
    // rematch/result actions visible for room members
    await expect(resultPage.locator('.result-actions')).toBeVisible();
    await auditAll('finished-final');

    expect(problems, problems.join('\n')).toEqual([]);
  } finally {
    await Promise.all(contexts.map(c => c.close().catch(() => {})));
    await stopServer(server);
  }
});
