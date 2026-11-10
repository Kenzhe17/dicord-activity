import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { localDatabaseUrl } from './local-database-url.mjs';
const database = process.argv.includes('--test') ? 'arcade_test' : 'arcade_dev';
const url = await localDatabaseUrl(database);
const cli = fileURLToPath(new URL('../packages/database/node_modules/prisma/build/index.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'migrate', 'deploy'], {
  cwd: fileURLToPath(new URL('../packages/database', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, ARCADE_DATABASE_URL: url },
});
child.once('exit', code => { process.exitCode = code ?? 1; });
