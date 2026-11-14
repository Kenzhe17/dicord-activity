import { defineConfig } from '@playwright/test';
// Per-run outputDir (see playwright.config.ts): concurrent Playwright
// processes must not share a cleaned outputDir.
const runId = process.env.ARCADE_E2E_RUN_ID ?? 'run-' + Date.now() + '-' + process.pid;
// Agent-3 mafia mobile/desktop layout spec: spawns its own backend on :3006
// (override via ARCADE_E2E_PORT_3006) and serves the built web dist — no
// shared dev servers needed.
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/mafia-mobile.spec.ts', outputDir: './tests/.artifacts/' + runId, fullyParallel: false, workers: 1,
  use: { trace: 'retain-on-failure' },
});
