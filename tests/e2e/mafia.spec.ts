import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { e2ePort, e2eDatabase } from './harness';
import type { MatchView, RoomView } from '../../packages/shared/src';
import type { MafiaView, MafiaAction } from '../../games/mafia/engine';

const port = e2ePort(3007);
const base = 'http://127.0.0.1:' + port;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ROLE_LABEL: Record<string, string> = { mafia: 'Мафия', town: 'Мирный житель', sheriff: 'Комиссар', doctor: 'Доктор' };
function mafiaCount(n: number) { return n <= 7 ? 1 : n <= 10 ? 2 : 3; }

async function startServer(databaseUrl: string) {
  const entry = `process.on('message', value => { if (value === 'shutdown') process.emit('SIGTERM'); }); process.once('SIGTERM', () => { if (process.connected) process.disconnect(); }); await import('./apps/server/dist/index.js');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', entry], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: databaseUrl, ARCADE_SERVE_WEB: 'true', ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_ORIGIN: base, PORT: String(port), ARCADE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderrTail = '';
  child.stderr!.on('data', d => { stderrTail = (stderrTail + String(d)).slice(-2000); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timeout; stderr: ' + stderrTail.slice(-500))); }, 30000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Backend exited ' + code)); });
    let pending = '';
    child.stdout!.on('data', data => {
      pending += String(data);
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('Server listening')) { clearTimeout(timeout); resolve(); }
        if (line.includes('server_start_failed') || line.includes('EADDRINUSE')) { clearTimeout(timeout); child.kill(); reject(new Error('Backend failed to start: ' + line.slice(0, 300))); }
      }
    });
  });
  // Keep a full server log for postmortems (crash/stall diagnosis).
  try { mkdirSync('tests/.artifacts', { recursive: true }); } catch { /* exists */ }
  const logPath = 'tests/.artifacts/mafia-server.log';
  child.stdout!.on('data', d => { try { appendFileSync(logPath, d); } catch { /* ignore */ } });
  child.stderr!.on('data', d => { try { appendFileSync(logPath, '[stderr] ' + d); } catch { /* ignore */ } });
  child.on('exit', code => { try { appendFileSync(logPath, '\nSERVER EXIT code=' + code + ' signal=' + child.signalCode + '\n'); } catch { /* ignore */ } });
  return child;
}
async function stopServer(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  let forced = false;
  const watchdog = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 30000);
  try {
    if (process.platform === 'win32') child.send('shutdown'); else child.kill('SIGTERM');
    await exited;
    if (forced) console.log('warning: backend needed SIGKILL on shutdown');
  } finally { clearTimeout(watchdog); }
}

interface Boot { session: { player: { id: string } }; room: RoomView | null; match: MatchView | null }

async function scenario(browser: Browser, count: number) {
  const pages = await Promise.all(Array.from({ length: count }, () => browser.newPage()));
  for (const page of pages) page.setDefaultTimeout(25000);
  const latest = new Map<Page, MatchView>();
  const seenAt = new Map<Page, number>();
  let lastPushAt = 0;
  for (const page of pages) page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const value = String(payload);
    if (!value.startsWith('42[')) return;
    try {
      const packet = JSON.parse(value.slice(2)) as [string, MatchView];
      if (packet[0] === 'match:state') { latest.set(page, packet[1]); seenAt.set(page, Date.now()); lastPushAt = Date.now(); }
    } catch { /* non-JSON frame */ }
  }));
  // REST helper: retries 429/5xx inside the page (same pattern as other specs).
  const request = async <T>(page: Page, path: string, body?: unknown): Promise<T> => page.evaluate(async ({ path, body }) => {
    for (let i = 0; i < 8; i++) {
      const response = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + sessionStorage.getItem('rize.arcade.session'), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.ok) return await response.json();
      if (response.status !== 429 && response.status < 500) throw new Error('API ' + response.status + ' ' + path);
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
    throw new Error('API rate-limited ' + path);
  }, { path, body });
  const act = async (page: Page, matchId: string, action: MafiaAction): Promise<MatchView> => {
    let err: unknown;
    for (let i = 0; i < 5; i++) {
      const fresh = await request<MatchView>(page, '/matches/' + matchId);
      try {
        return await request<MatchView>(page, '/matches/' + matchId + '/actions', { protocol: 1, roomId: fresh.roomId, matchId, requestId: randomUUID(), expectedVersion: fresh.version, action });
      } catch (e) { err = e; await sleep(250 + i * 250); }
    }
    throw err;
  };
  const freshest = async (matchId: string): Promise<MatchView> => {
    const views = pages.map(p => latest.get(p)).filter((v): v is MatchView => !!v && v.matchId === matchId);
    if (views.length && Date.now() - lastPushAt < 10000) return views.reduce((a, b) => (a.version > b.version ? a : b));
    // Socket pushes may have stopped (dead socket, throttled page): verify
    // against REST before trusting possibly-stale pushed views.
    try {
      const v = await request<MatchView>(pages[0]!, '/matches/' + matchId);
      latest.set(pages[0]!, v); seenAt.set(pages[0]!, Date.now()); lastPushAt = Date.now();
      views.push(v);
    } catch { /* server unreachable — fall through to whatever we have */ }
    if (views.length) return views.reduce((a, b) => (a.version > b.version ? a : b));
    return request<MatchView>(pages[0]!, '/matches/' + matchId);
  };
  const pageView = async (i: number, matchId: string): Promise<MatchView> => {
    const page = pages[i]!;
    const v = latest.get(page);
    if (v && v.matchId === matchId && Date.now() - (seenAt.get(page) ?? 0) < 2500) return v;
    const fresh = await request<MatchView>(page, '/matches/' + matchId);
    latest.set(page, fresh); seenAt.set(page, Date.now());
    return fresh;
  };
  const mafiaViews = (views: MatchView[]) => views.map(v => v.state as MafiaView);

  // ---- Role secrecy + role census over personal views ----
  const assertViews = (views: MatchView[]) => {
    const states = mafiaViews(views);
    const n = states[0]!.players.length;
    const finished = states[0]!.phase === 'finished';
    const census: Record<string, number> = {};
    const mafiaSeatSets: string[] = [];
    for (const s of states) {
      expect(s).not.toHaveProperty('roles');
      expect(s).not.toHaveProperty('deck');
      const me = s.you;
      expect(ROLE_LABEL[me.role.kind], 'own role label').toBeTruthy();
      census[me.role.kind] = (census[me.role.kind] ?? 0) + 1;
      if (me.role.kind !== 'sheriff') expect(me.sheriffResult).toBeNull();
      if (me.role.kind !== 'mafia') expect(me.role.allies).toBeUndefined();
      for (const p of s.players) {
        if (finished) { expect(p.role, 'role revealed after finish').not.toBeNull(); continue; }
        if (me.role.kind === 'mafia') {
          // Mafia sees exactly the mafia seats (self + allies, dead or alive).
          if (p.role !== null) expect(p.role).toBe('mafia');
        } else {
          expect(p.role, 'role leak to non-mafia').toBeNull();
        }
      }
      if (!finished && me.role.kind === 'mafia') mafiaSeatSets.push(s.players.filter(p => p.role === 'mafia').map(p => String(p.seat)).sort().join(','));
    }
    expect(census.mafia).toBe(mafiaCount(n));
    expect(census.sheriff).toBe(1);
    expect(census.doctor).toBe(1);
    expect(census.town).toBe(n - mafiaCount(n) - 2);
    if (!finished) {
      // Every mafioso must see the identical mafia roster.
      for (const set of mafiaSeatSets) expect(set).toBe(mafiaSeatSets[0]);
      expect(mafiaSeatSets.length).toBe(mafiaCount(n));
    } else {
      // After finish every viewer sees the same role per seat.
      const ref = states[0]!.players.map(p => p.seat + ':' + p.role).join('|');
      for (const s of states) expect(s.players.map(p => p.seat + ':' + p.role).join('|')).toBe(ref);
    }
  };

  // ---- DOM assertions: every phase renders for every player ----
  const domChecked = new Set<string>();
  const checkDom = async (matchId: string) => {
    await Promise.all(pages.map(async (page, i) => {
      const v = latest.get(page);
      if (!v || v.matchId !== matchId) return;
      const s = v.state as MafiaView;
      // The rendered phase must always equal this client's latest pushed phase.
      await expect.poll(async () => {
        const want = (latest.get(page)?.state as MafiaView | undefined)?.phase;
        if (!want) return false;
        return await page.locator('.mafia-game').getAttribute('data-phase') === want;
      }, { timeout: 10000, intervals: [150] }).toBe(true);
      const key = i + ':' + s.phase;
      if (domChecked.has(key)) return;
      domChecked.add(key);
      const me = s.you;
      await expect(page.locator('.mafia-seat')).toHaveCount(s.players.length);
      await expect(page.locator('.mafia-rolecard')).toContainText(ROLE_LABEL[me.role.kind]!);
      await expect(page.locator('.mafia-feed-item').first()).toBeVisible();
      if (s.phase === 'reveal') await expect(page.locator('details.mafia-rolecard[open]')).toHaveCount(1);
      if (s.phase === 'night') {
        await expect(page.locator('.mafia-night-banner')).toBeVisible();
        const canAct = me.abilities.canNightKill || me.abilities.canSheriffCheck || me.abilities.canDoctorHeal;
        if (canAct) await expect(page.getByRole('button', { name: 'Подтвердить' })).toBeVisible();
        else await expect(page.locator('.mafia-action-hint')).toContainText('Ночь');
      }
      if (s.phase === 'dawn' || s.phase === 'discussion') await expect(page.locator('.mafia-phase-note')).toBeVisible();
      if (s.phase === 'discussion') await expect(page.locator('.mafia-phase-note')).toContainText('День');
      if (s.phase === 'voting' || s.phase === 'runoff') {
        await expect(page.locator('.mafia-votebar')).toBeVisible();
        if (me.abilities.canVote) await expect(page.getByRole('button', { name: 'Пропустить' })).toBeVisible();
      }
      // Chat tabs match the viewer's channel rights.
      const expectedTabs = (!me.alive || me.forfeited) ? ['Выбывшие'] : ['Общий', ...(me.abilities.canChatMafia ? ['Мафия'] : [])];
      const tabs = page.locator('.mafia-chat-tabs [role="tab"]');
      await expect(tabs).toHaveCount(expectedTabs.length);
      for (const [j, label] of expectedTabs.entries()) await expect(tabs.nth(j)).toContainText(label);
    }));
  };

  const lastHeal = new Map<number, number>();
  const nightTarget = (s: MafiaView, i: number): number | null => {
    const me = s.you, alive = s.players.filter(p => p.alive);
    if (me.abilities.canNightKill) { const t = alive.find(p => p.seat !== me.seat && p.role !== 'mafia'); return t ? t.seat : null; }
    if (me.abilities.canSheriffCheck) { const t = alive.find(p => p.seat !== me.seat); return t ? t.seat : null; }
    if (me.abilities.canDoctorHeal) { const last = lastHeal.get(i) ?? -2; const t = alive.find(p => p.seat !== last) ?? alive[0]; return t ? t.seat ?? null : null; }
    return null;
  };
  const voteTarget = (s: MafiaView): number | 'skip' => {
    const me = s.you.seat;
    if (s.phase === 'runoff' && s.runoff) {
      const c = s.runoff.filter(x => x !== me).sort((a, b) => a - b);
      return c.length ? c[0]! : 'skip';
    }
    const t = s.players.filter(p => p.alive && p.seat !== me).sort((a, b) => a.seat - b.seat)[0];
    return t ? t.seat : 'skip';
  };

  // Night: real UI (seat pick + Подтвердить) on early nights, REST fallback always.
  const ensureNight = async (matchId: string, useUi: boolean) => {
    await Promise.all(pages.map(async (page, i) => {
      const v = await pageView(i, matchId);
      const s = v.state as MafiaView;
      if (s.phase !== 'night') return;
      const a = s.you.abilities;
      const need = a.canNightKill ? 'nightKill' : a.canSheriffCheck ? 'sheriffCheck' : a.canDoctorHeal ? 'doctorHeal' : null;
      if (!need) return;
      const na = s.you.nightAction;
      const done = need === 'nightKill' ? na.kill !== null : need === 'sheriffCheck' ? na.check !== null : na.heal !== null;
      if (done) return;
      if (useUi) {
        try {
          await page.locator('.mafia-seat.pickable').first().click({ timeout: 5000 });
          await page.getByRole('button', { name: 'Подтвердить' }).click({ timeout: 5000 });
        } catch { /* fall through to API */ }
        const ok = await expect.poll(async () => {
          try {
            const pv = await request<MatchView>(page, '/matches/' + matchId);
            const na2 = (pv.state as MafiaView).you.nightAction;
            return na2.kill !== null || na2.check !== null || na2.heal !== null;
          } catch { return false; }
        }, { timeout: 6000, intervals: [400] }).toBe(true).then(() => true).catch(() => false);
        if (ok) return;
      }
      const target = nightTarget(s, i);
      if (target === null) return;
      try {
        await act(page, matchId, { type: need, target } as MafiaAction);
        if (need === 'doctorHeal') lastHeal.set(i, target);
      } catch (e) { console.log('  night action failed p' + i, String(e).slice(0, 160)); }
    }));
  };

  // Voting/runoff: real UI seat click (votes immediately), REST fallback.
  const ensureVotes = async (matchId: string) => {
    await Promise.all(pages.map(async (page, i) => {
      const v = await pageView(i, matchId);
      const s = v.state as MafiaView;
      if (s.phase !== 'voting' && s.phase !== 'runoff') return;
      if (!s.you.abilities.canVote || s.you.vote !== null) return;
      try { await page.locator('.mafia-seat.pickable').first().click({ timeout: 5000 }); } catch { /* API fallback */ }
      const ok = await expect.poll(async () => {
        try { return ((await request<MatchView>(page, '/matches/' + matchId)).state as MafiaView).you.vote !== null; }
        catch { return false; }
      }, { timeout: 6000, intervals: [400] }).toBe(true).then(() => true).catch(() => false);
      if (ok) return;
      const target = voteTarget(s);
      try { await act(page, matchId, { type: 'vote', target } as MafiaAction); }
      catch (e) { console.log('  vote failed p' + i, String(e).slice(0, 160)); }
    }));
  };

  const doChat = async (matchId: string, tag: string) => {
    const marker = 'PING' + tag + '-' + Math.floor(Math.random() * 1e6);
    await Promise.all(pages.map(async page => {
      const v = await pageView(pages.indexOf(page), matchId);
      if (!(v.state as MafiaView).you.abilities.canChatTown) return;
      try {
        await page.locator('.mafia-chat-form input').fill(marker);
        await page.getByRole('button', { name: 'Отправить' }).click();
      } catch (e) { console.log('  chat ui fail', String(e).slice(0, 120)); }
    }));
    await expect.poll(async () => {
      for (const page of pages) {
        const v = latest.get(page);
        if (v && v.matchId === matchId && (v.state as MafiaView).you.alive) {
          try { if (await page.locator('.mafia-msg').filter({ hasText: marker }).count() > 0) return true; } catch { /* retry */ }
        }
      }
      return false;
    }, { timeout: 20000, intervals: [500] }).toBe(true);
    console.log('  town chat verified, marker', marker);
  };

  const doReconnect = async (matchId: string) => {
    const i = count - 1, page = pages[i]!;
    const prior = await request<MatchView>(page, '/matches/' + matchId);
    const priorS = prior.state as MafiaView;
    latest.delete(page);
    await page.reload();
    await expect(page.locator('.mafia-game')).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => {
      const v = latest.get(page);
      return !!v && v.matchId === matchId && v.version >= prior.version;
    }, { timeout: 30000, intervals: [400] }).toBe(true);
    const afterS = (latest.get(page)!.state) as MafiaView;
    expect(afterS.you.seat).toBe(priorS.you.seat);
    expect(afterS.you.role.kind).toBe(priorS.you.role.kind);
    expect(afterS.you.alive).toBe(priorS.you.alive);
    expect(afterS.players.map(p => p.role)).toEqual(priorS.players.map(p => p.role));
    await expect(page.locator('.mafia-rolecard')).toContainText(ROLE_LABEL[afterS.you.role.kind]!);
    console.log('  reconnect verified for seat', afterS.you.seat, 'role', afterS.you.role.kind);
  };

  const forfeitAll = async (matchId: string): Promise<MatchView> => {
    for (let round = 0; round < count + 4; round++) {
      const view = await freshest(matchId);
      if (view.status === 'finished') return view;
      await Promise.all(pages.map(async (page, i) => {
        const v = await pageView(i, matchId);
        if ((v.state as MafiaView).you.forfeited) return;
        try { await act(page, matchId, { type: 'forfeit' }); } catch { /* match may have ended */ }
      }));
      await sleep(400);
    }
    const view = await freshest(matchId);
    if (view.status === 'finished') return view;
    throw new Error('forfeitAll did not finish match ' + matchId);
  };

  const drive = async (matchId: string, opts: { chat: boolean; reconnect: boolean; stopAfterPhase?: string }): Promise<MatchView> => {
    const t0 = Date.now();
    let chatDone = false, reconnected = false, lastDomPhase = '';
    domChecked.clear();
    while (Date.now() - t0 < 25 * 60 * 1000) {
      const view = await freshest(matchId);
      if (view.status === 'finished') return view;
      const s = view.state as MafiaView;
      // DOM verification is only needed at phase boundaries — running the
      // per-page polls every iteration was adding minutes per cycle.
      if (s.phase !== lastDomPhase) { lastDomPhase = s.phase; await checkDom(matchId); console.log('  phase ->', s.phase, 'day', s.day, 'night', s.night, 'v' + view.version); }
      if (s.phase === 'night') await ensureNight(matchId, s.night <= 2);
      if (s.phase === 'voting' || s.phase === 'runoff') await ensureVotes(matchId);
      if (s.phase === 'discussion' && opts.chat && !chatDone) { chatDone = true; await doChat(matchId, String(count)); }
      if (s.phase === 'discussion' && opts.reconnect && !reconnected) { reconnected = true; await doReconnect(matchId); }
      if (opts.stopAfterPhase && (s.phase === opts.stopAfterPhase || s.phase === 'runoff')) return view;
      const waitMs = Math.max(5000, Math.min(170000, (s.deadline - Date.now()) + 35000));
      let heartbeat = 0;
      try {
        await expect.poll(async () => {
          heartbeat++;
          // REST heartbeat every ~6s so a dead socket cannot fake a stall.
          if (heartbeat % 12 === 0) {
            try { const v = await request<MatchView>(pages[0]!, '/matches/' + matchId); latest.set(pages[0]!, v); seenAt.set(pages[0]!, Date.now()); lastPushAt = Date.now(); } catch { /* retry next beat */ }
          }
          try { return (await freshest(matchId)).version; } catch { return -1; }
        }, { timeout: waitMs, intervals: [500] }).toBeGreaterThan(view.version);
      } catch (e) {
        throw new Error(`Mafia stalled: phase=${s.phase} day=${s.day} night=${s.night} v=${view.version} :: ${String(e).slice(0, 200)}`, { cause: e });
      }
    }
    throw new Error('Match ' + matchId + ' did not finish in time');
  };

  const assertFinishedDom = async () => {
    await Promise.all(pages.map(async page => {
      await expect(page.locator('.mafia-result')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.mafia-roster-row')).toHaveCount(count, { timeout: 30000 });
      await expect(page.locator('.mafia-result .mafia-role')).toHaveCount(count, { timeout: 30000 });
      await expect(page.getByRole('button', { name: 'Я готов — реванш' })).toBeVisible({ timeout: 30000 });
    }));
  };

  try {
    // ---------- lobby ----------
    for (const [i, page] of pages.entries()) {
      await page.goto(base);
      await page.getByRole('textbox', { name: 'Имя игрока' }).fill('Mafia ' + count + ' #' + (i + 1));
      await page.getByRole('button', { name: 'Войти локально' }).click();
      await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    }
    const host = pages[0]!;
    await host.getByRole('button', { name: /Мафия/ }).click();
    await host.getByRole('button', { name: 'Создать комнату', exact: true }).click();
    await host.getByLabel('Темп партии').selectOption('blitz');
    await host.getByLabel('Название комнаты').fill('Мафия E2E ' + count);
    await host.getByLabel('Приватная комната').check();
    await host.getByRole('button', { name: 'Создать лобби' }).click();
    await host.getByRole('button', { name: 'Создать приглашение' }).click();
    const code = await host.locator('.invite-code').inputValue();
    await Promise.all(pages.slice(1).map(async page => {
      await page.getByRole('button', { name: 'Комнаты', exact: true }).click();
      await page.getByRole('textbox', { name: 'Войти по коду' }).fill(code);
      await page.getByRole('button', { name: 'Присоединиться' }).click();
      await expect(page.getByRole('button', { name: 'Я готов', exact: true })).toBeVisible();
    }));
    // Resolve playerId -> page and the room id via bootstrap.
    const playerIndex = new Map<string, number>();
    let roomId = '';
    await expect.poll(async () => {
      const boots = await Promise.all(pages.map(p => request<Boot>(p, '/bootstrap')));
      boots.forEach((b, i) => playerIndex.set(b.session.player.id, i));
      roomId = boots[0]!.room?.id ?? '';
      const room = boots[0]!.room;
      return !!room && room.members.length === count && boots.every(b => b.room?.id === room.id);
    }, { timeout: 30000, intervals: [800] }).toBe(true);
    // Ready everyone. UI clicks first (real path), then REST-verified retries —
    // concurrent ready posts race on room.version, so we confirm server-side.
    await Promise.all(pages.map(page => page.getByRole('button', { name: 'Я готов', exact: true }).click().catch(() => {})));
    const ensureReady = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const room = await request<RoomView>(host, '/rooms/' + roomId);
        if (room.members.length === count && room.members.every(m => m.ready)) return room;
        await Promise.all(room.members.filter(m => !m.ready).map(async m => {
          const page = pages[playerIndex.get(m.player.id) ?? 0]!;
          for (let j = 0; j < 3; j++) {
            try {
              const r = await request<RoomView>(page, '/rooms/' + roomId);
              await request(page, '/rooms/' + roomId + '/ready', { ready: true, expectedVersion: r.version, requestId: randomUUID() });
              return;
            } catch { await sleep(300); }
          }
        }));
        await sleep(600);
      }
      const room = await request<RoomView>(host, '/rooms/' + roomId);
      throw new Error('Players not ready: ' + JSON.stringify(room.members.map(m => ({ id: m.player.id, ready: m.ready }))));
    };
    await ensureReady();
    await expect(host.getByRole('button', { name: 'Начать партию' })).toBeEnabled({ timeout: 20000 });
    await host.getByRole('button', { name: 'Начать партию' }).click();
    await Promise.all(pages.map(page => expect(page.locator('.mafia-game')).toBeVisible({ timeout: 30000 })));
    await Promise.all(pages.map(page => expect(page.locator('.mafia-seat')).toHaveCount(count, { timeout: 30000 })));
    await host.screenshot({ path: `tests/.artifacts/mafia-${count}-roles.png`, fullPage: true });

    // ---------- match 1 ----------
    let boots: Boot[] = [];
    await expect.poll(async () => {
      boots = await Promise.all(pages.map(p => request<Boot>(p, '/bootstrap')));
      const ids = new Set(boots.map(b => b.match?.matchId));
      return boots.every(b => b.match && b.match.status === 'active') && ids.size === 1;
    }, { timeout: 40000, intervals: [1000] }).toBe(true);
    const matchId = boots[0]!.match!.matchId;
    console.log('  match1 started:', matchId);
    assertViews(boots.map(b => b.match!));
    const finalView = await drive(matchId, { chat: true, reconnect: true });
    expect(finalView.status).toBe('finished');
    console.log('  match1 finished, winner =', (finalView.state as MafiaView).winner, 'days', (finalView.state as MafiaView).day, 'nights', (finalView.state as MafiaView).night);
    const endViews = await Promise.all(pages.map(p => request<MatchView>(p, '/matches/' + matchId)));
    assertViews(endViews);
    const result = finalView.result;
    expect(result).toBeTruthy();
    if (!result!.draw) expect(new Set([...result!.winners, ...result!.losers]).size).toBe(count);
    await assertFinishedDom();
    console.log('  match1 finished DOM verified');
    await host.screenshot({ path: `tests/.artifacts/mafia-${count}-result.png`, fullPage: true });

    // ---------- rematch ----------
    await Promise.all(pages.map(page => page.getByRole('button', { name: 'Я готов — реванш' }).click().catch(() => {})));
    await ensureReady();
    await expect(host.getByRole('button', { name: 'Начать партию' })).toBeEnabled({ timeout: 30000 });
    await host.getByRole('button', { name: 'Начать партию' }).click();
    await expect.poll(async () => pages.every(p => { const v = latest.get(p); return !!v && v.matchId !== matchId; }), { timeout: 40000, intervals: [500] }).toBe(true);
    let boots2: Boot[] = [];
    await expect.poll(async () => {
      boots2 = await Promise.all(pages.map(p => request<Boot>(p, '/bootstrap')));
      const ids = new Set(boots2.map(b => b.match?.matchId));
      return boots2.every(b => b.match && b.match.status === 'active') && ids.size === 1;
    }, { timeout: 40000, intervals: [1000] }).toBe(true);
    const matchId2 = boots2[0]!.match!.matchId;
    expect(matchId2).not.toBe(matchId);
    console.log('  rematch started:', matchId2);
    assertViews(boots2.map(b => b.match!));
    // Roles should be re-dealt (compare per-player role mapping; identical deal is possible but unlikely).
    const roleMap1 = new Map(boots.map(b => [b.session.player.id, (b.match!.state as MafiaView).you.role.kind] as const));
    const roleMap2 = new Map(boots2.map(b => [b.session.player.id, (b.match!.state as MafiaView).you.role.kind] as const));
    const changed = [...roleMap2.keys()].filter(id => roleMap1.get(id) !== roleMap2.get(id)).length;
    console.log('  rematch roles changed for', changed, 'of', count, 'players');

    // Play rematch through night + first vote UI, then forfeit everyone to end it quickly.
    const midView = await drive(matchId2, { chat: false, reconnect: false, stopAfterPhase: 'voting' });
    expect(midView.status).toBe('active');
    console.log('  rematch reached voting, forfeiting all');
    const finView = await forfeitAll(matchId2);
    expect(finView.status).toBe('finished');
    await assertFinishedDom();
    console.log('  rematch finished DOM verified');
    const endViews2 = await Promise.all(pages.map(p => request<MatchView>(p, '/matches/' + matchId2)));
    assertViews(endViews2);
    await host.screenshot({ path: `tests/.artifacts/mafia-${count}-rematch-result.png`, fullPage: true });
    console.log('  scenario', count, 'players: PASS');
  } finally {
    await Promise.all(pages.map(p => p.close().catch(() => {})));
  }
}

async function scenarioGuarded(browser: Browser, count: number) {
  try { await scenario(browser, count); }
  catch (e) { console.log('SCENARIO ' + count + ' FAILED:', String(e).slice(0, 800)); throw e; }
}

test('Mafia blitz: full game cycles at 6, 8 and 12 players incl. rematch', async ({ browser }) => {
  test.setTimeout(5400000);
  const credentials = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8')) as { user: string; password: string; port: number };
  const databaseUrl = 'postgresql://' + encodeURIComponent(credentials.user) + ':' + encodeURIComponent(credentials.password) + '@127.0.0.1:' + credentials.port + '/' + e2eDatabase() + '?schema=arcade';
  const server = await startServer(databaseUrl);
  try {
    for (const count of [6, 8, 12]) await scenarioGuarded(browser, count);
  } finally {
    await stopServer(server);
  }
});
