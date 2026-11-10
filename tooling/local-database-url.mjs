import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
export async function localDatabaseUrl(database = 'arcade_dev') {
  if (!['arcade_dev', 'arcade_test'].includes(database)) throw new Error('Only isolated local databases are allowed');
  const c = JSON.parse(await readFile(join(homedir(), '.rize3-arcade/local-postgres/connection.json'), 'utf8'));
  return 'postgresql://' + encodeURIComponent(c.user) + ':' + encodeURIComponent(c.password) + '@127.0.0.1:' + c.port + '/' + database + '?schema=arcade';
}
