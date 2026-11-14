import { defineConfig } from '@playwright/test';
// Per-run outputDir (see playwright.config.ts): concurrent Playwright
// processes must not share a cleaned outputDir.
const runId = process.env.ARCADE_E2E_RUN_ID ?? 'run-' + Date.now() + '-' + process.pid;
// Durak-only QA: every spec spawns its own backend on dedicated ports
// (3003-3009; override via ARCADE_E2E_PORT_<port> env vars) against the local
// arcade_test DB (override via ARCADE_E2E_DB), so no shared
// dev-server/vite webServers are needed and other games' suites cannot
// collide on ports or artifact dirs.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['durak.spec.ts', 'durak-mobile.spec.ts', 'durak-layout.spec.ts', 'durak-qa.spec.ts', 'surrender.spec.ts'],
  outputDir: './tests/.artifacts-durak/' + runId,
  fullyParallel: false,
  workers: 1,
  use: { trace: 'retain-on-failure' },
});
