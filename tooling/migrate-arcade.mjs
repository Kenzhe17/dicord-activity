import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// One-off Arcade migration job. Applies pending Prisma migrations to the
// dedicated Arcade PostgreSQL and verifies the arcade schema afterwards.
// Never prints ARCADE_DATABASE_URL or any credentials.

const databaseDir = fileURLToPath(new URL('../packages/database', import.meta.url));
const prismaCli = fileURLToPath(new URL('../packages/database/node_modules/prisma/build/index.js', import.meta.url));

if (!process.env['ARCADE_DATABASE_URL']) {
  console.error('ARCADE_DATABASE_URL is not set; refusing to run migrations.');
  process.exit(1);
}

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: databaseDir,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

console.log('== Target: ARCADE_DATABASE_URL (value hidden) ==');
console.log('== prisma migrate status ==');
// Pending migrations are expected before the first run; status is informational.
runPrisma(['migrate', 'status']);

console.log('== prisma migrate deploy ==');
const deployStatus = runPrisma(['migrate', 'deploy']);
if (deployStatus !== 0) {
  console.error('prisma migrate deploy failed with exit code ' + deployStatus);
  process.exit(deployStatus);
}

const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const { Client } = require('pg');
const client = new Client({ connectionString: process.env['ARCADE_DATABASE_URL'] });

const EXPECTED_TABLES = [
  'Player', 'AuthSession', 'AuthChallenge', 'RoomSnapshot', 'RoomMember',
  'MatchSnapshot', 'MatchAction', 'MatchParticipant', 'PlayerStatistic',
  'RecoveryEvent', 'RequestReceipt', 'EconomyOperation',
];

try {
  await client.connect();
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'arcade' ORDER BY table_name`,
  );
  const names = new Set(tables.rows.map(row => row.table_name));
  const missing = EXPECTED_TABLES.filter(name => !names.has(name));
  const migrations = await client.query(
    `SELECT migration_name, finished_at IS NOT NULL AS finished FROM arcade._prisma_migrations ORDER BY started_at`,
  );
  const unfinished = migrations.rows.filter(row => !row.finished);
  console.log('arcade tables (' + names.size + '): ' + [...names].sort().join(', '));
  console.log('applied migrations: ' + migrations.rows.map(row => row.migration_name).join(', '));
  if (missing.length > 0) {
    console.error('Verification failed, missing arcade tables: ' + missing.join(', '));
    process.exit(1);
  }
  if (unfinished.length > 0) {
    console.error('Verification failed, unfinished migrations: ' + unfinished.map(row => row.migration_name).join(', '));
    process.exit(1);
  }
  console.log('Verification OK: arcade schema complete, all migrations finished.');
} finally {
  await client.end();
}
