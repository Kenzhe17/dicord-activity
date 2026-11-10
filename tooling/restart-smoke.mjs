import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout, clearTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { localDatabaseUrl } from './local-database-url.mjs';
const url = await localDatabaseUrl('arcade_test');
async function start() {
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], { env: { ...process.env, NODE_ENV: 'test', ARCADE_ENV: 'test', ARCADE_AUTH_MODE: 'mock', ARCADE_ENABLE_TEST_GAME: 'true', ARCADE_DATABASE_URL: url, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Backend timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Backend exited: ' + code)); });
    child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  return { child, base };
}
async function stop(server) { if (server.child.exitCode === null) { const exit = once(server.child, 'exit'); server.child.kill('SIGTERM'); await exit; } }
let server = await start();
async function request(path, token, body, method = 'POST') {
  const response = await globalThis.fetch(server.base + '/api' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200, 'Request failed: ' + path);
  return response.json();
}
try {
  const a = await request('/auth/dev', null, { name: 'Process restart A' });
  const b = await request('/auth/dev', null, { name: 'Process restart B' });
  const room = await request('/rooms', a.token, { requestId: randomUUID(), gameId: 'sandbox', name: 'Restart smoke', visibility: 'private', settings: { target: 3 } });
  const invite = await request('/rooms/' + room.id + '/invite', a.token);
  await request('/rooms/' + room.id + '/join', b.token, { inviteToken: invite.code.split(':')[1] });
  await request('/rooms/' + room.id + '/ready', a.token, { ready: true, expectedVersion: 1, requestId: randomUUID() });
  await request('/rooms/' + room.id + '/ready', b.token, { ready: true, expectedVersion: 2, requestId: randomUUID() });
  const match = await request('/rooms/' + room.id + '/start', a.token, { requestId: randomUUID() });
  const first = { protocol: 1, roomId: room.id, matchId: match.matchId, requestId: randomUUID(), expectedVersion: 0, action: { type: 'advance', steps: 2 } };
  await request('/matches/' + match.matchId + '/actions', a.token, first);
  const oldPid = server.child.pid;
  await stop(server);
  server = await start();
  assert.notEqual(server.child.pid, oldPid);
  const resumed = await request('/bootstrap', a.token, undefined, 'GET');
  assert.equal(resumed.room.id, room.id);
  assert.equal(resumed.match.version, 1);
  assert.equal((await request('/matches/' + match.matchId + '/actions', a.token, first)).version, 1);
  await request('/matches/' + match.matchId + '/actions', b.token, { ...first, requestId: randomUUID(), expectedVersion: 1, action: { type: 'advance', steps: 1 } });
  await request('/matches/' + match.matchId + '/actions', a.token, { ...first, requestId: randomUUID(), expectedVersion: 2, action: { type: 'advance', steps: 1 } });
  const history = await request('/history', a.token, undefined, 'GET');
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'win');
  await request('/rooms/' + room.id, a.token, undefined, 'DELETE');
  console.log('Real backend process restart passed: session, private room, active game, idempotency and result survived.');
} finally { await stop(server); }
