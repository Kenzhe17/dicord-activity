import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setInterval, clearInterval } from 'node:timers';
const directory = join(homedir(), '.rize3-arcade', 'local-postgres');
await mkdir(directory, { recursive: true });
const credentialsPath = join(directory, 'connection.json');
let credentials;
try { credentials = JSON.parse(await readFile(credentialsPath, 'utf8')); }
catch { credentials = { user: 'arcade_local', password: randomBytes(24).toString('hex'), port: 55432 }; await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' }); }
const db = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'), user: credentials.user, password: credentials.password, port: credentials.port,
  persistent: true, authMethod: 'scram-sha-256', createPostgresUser: false,
  postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {},
});
try { await access(join(directory, 'data', 'PG_VERSION')); } catch { await db.initialise(); }
await db.start();
const client = db.getPgClient('postgres', '127.0.0.1');
await client.connect();
for (const name of ['arcade_dev', 'arcade_test']) {
  const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (result.rowCount === 0) await client.query('CREATE DATABASE "' + name + '"');
}
await client.end();
console.log('Local PostgreSQL ready on 127.0.0.1:' + credentials.port + ' (arcade_dev / arcade_test). Credentials remain in local private configuration.');
const keepAlive = setInterval(() => {}, 30000);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; clearInterval(keepAlive); await db.stop(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
