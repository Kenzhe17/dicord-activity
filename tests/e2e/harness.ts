// Shared E2E infrastructure helpers. Every spec spawns its own backend on a
// fixed default port against the local arcade_test database; these helpers let
// a whole Playwright process be redirected so CONCURRENT `playwright test`
// invocations (other agents/sessions) do not collide on ports or databases.
//
// Port override:   ARCADE_E2E_PORT_<default>  e.g. ARCADE_E2E_PORT_3005=3105
// Database override: ARCADE_E2E_DB           e.g. ARCADE_E2E_DB=arcade_test_b
//   NOTE: the database must already exist and be migrated
//   (`prisma migrate deploy` against it); only arcade_dev/arcade_test are
//   provisioned by tooling/local-postgres.mjs.

/** Resolve the backend port for a spec: ARCADE_E2E_PORT_<fallback> wins. */
export function e2ePort(fallback: number): number {
  const raw = process.env['ARCADE_E2E_PORT_' + fallback];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('ARCADE_E2E_PORT_' + fallback + ' must be an integer port, got ' + JSON.stringify(raw));
  }
  return port;
}

/** Database name for spec-spawned backends (default arcade_test). */
export function e2eDatabase(): string {
  const name = process.env.ARCADE_E2E_DB ?? 'arcade_test';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('ARCADE_E2E_DB must be a plain database name, got ' + JSON.stringify(name));
  return name;
}
