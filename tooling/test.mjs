import { spawn } from 'node:child_process';
import { localDatabaseUrl } from './local-database-url.mjs';
const url = process.env.ARCADE_TEST_DATABASE_URL ?? await localDatabaseUrl('arcade_test');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.startsWith('/arcade_test')) throw new Error('Tests require an isolated local arcade_test database');
const args = process.argv.slice(2);
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', ...(args.includes('--watch') ? [] : ['run']), ...args], { stdio: 'inherit', env: { ...process.env, ARCADE_TEST_DATABASE_URL: url } });
child.on('exit', code => { process.exitCode = code ?? 1; });
