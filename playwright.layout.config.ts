import { defineConfig } from '@playwright/test';
// Per-run outputDir (see playwright.config.ts): concurrent Playwright
// processes must not share a cleaned outputDir.
const runId = process.env.ARCADE_E2E_RUN_ID ?? 'run-' + Date.now() + '-' + process.pid;
// Self-contained Durak layout verification: specs spawn their own backend on
// dedicated ports (override via ARCADE_E2E_PORT_3005), so the shared
// dev-server webServers are not required.
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'durak-layout.spec.ts', outputDir: './tests/.artifacts-layout/' + runId, fullyParallel: false, workers: 1,
  use: { trace: 'off' },
});
