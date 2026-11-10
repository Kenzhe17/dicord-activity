import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { URL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout, clearTimeout } from 'node:timers';
import { localDatabaseUrl } from './local-database-url.mjs';
const child = spawn(process.execPath, [process.argv[2] ?? fileURLToPath(new URL('../apps/server/dist/index.js', import.meta.url))], {
  env: { ...process.env, NODE_ENV: 'production', ARCADE_ENV: 'production', ARCADE_AUTH_MODE: 'disabled', ARCADE_HOST: '127.0.0.1', PORT: '0', ARCADE_DATABASE_URL: await localDatabaseUrl('arcade_test'), ARCADE_ENABLE_TEST_GAME: 'false', ARCADE_SERVE_WEB: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Built server startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Built server exited: ' + code)); });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const live = await globalThis.fetch(base + '/health/live');
  const ready = await globalThis.fetch(base + '/health/ready');
  const config = await (await globalThis.fetch(base + '/api/config')).json();
  assert.equal(live.status, 200);
  assert.equal(ready.status, 200);
  assert.equal(config.authMode, 'disabled');
  assert.equal(config.persistence, 'postgresql');
  const games = await (await globalThis.fetch(base + '/.proxy/api/games')).json();
  assert.equal(games.some(game => game.id === 'sandbox'), false);
  assert.equal(games.find(game => game.id === 'durak')?.status, 'ready');
  assert.equal(games.find(game => game.id === 'uno')?.status, 'planned');
  assert.equal(games.find(game => game.id === 'mafia')?.status, 'planned');
  const html = await globalThis.fetch(base + '/');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('x-frame-options'), null);
  const source = await html.text();
  const asset = source.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await globalThis.fetch(base + asset)).status, 200);
  console.log('Built production smoke passed: PostgreSQL ready, Durak available, UNO/Mafia planned, sandbox hidden, static HTML/assets and /.proxy API served, Discord framing enabled.');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
}
