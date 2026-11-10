import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { localDatabaseUrl } from './local-database-url.mjs';
const url = process.argv.includes('--test') ? await localDatabaseUrl('arcade_test') : await localDatabaseUrl('arcade_dev');
const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, ARCADE_ENV: 'development', ARCADE_AUTH_MODE: 'mock', ARCADE_DATABASE_URL: url, ARCADE_ENABLE_TEST_GAME: 'true' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 0; });
