import { defineConfig } from '@playwright/test';
// Per-run outputDir (see playwright.config.ts): concurrent Playwright
// processes must not share a cleaned outputDir.
const runId = process.env.ARCADE_E2E_RUN_ID ?? 'run-' + Date.now() + '-' + process.pid;
// Mafia E2E spawns its own real server on :3007 inside the spec (override via
// ARCADE_E2E_PORT_3007); the shared playwright.config.ts webServers
// (3001/5173) are not needed and may already be occupied by other agents, so
// this config omits them.
export default defineConfig({
  testDir: './tests/e2e', outputDir: './tests/.artifacts/' + runId, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:' + (process.env.ARCADE_E2E_PORT_3007 ?? '3007'), trace: 'retain-on-failure' },
});
