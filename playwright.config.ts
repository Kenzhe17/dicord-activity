import { defineConfig } from '@playwright/test';
// Per-run outputDir: Playwright cleans outputDir at startup, so a shared dir
// lets a concurrent `playwright test` process wipe trace/video/HAR temp files
// mid-run (ENOENT at context.close). ARCADE_E2E_RUN_ID pins a stable dir when
// needed; default is unique per process.
const runId = process.env.ARCADE_E2E_RUN_ID ?? 'run-' + Date.now() + '-' + process.pid;
export default defineConfig({
  testDir: './tests/e2e', outputDir: './tests/.artifacts/' + runId, fullyParallel: false, workers: 1, use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node tooling/dev-server.mjs --test', url: 'http://127.0.0.1:3001/health/live', reuseExistingServer: false },
    { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1', cwd: 'apps/web', url: 'http://127.0.0.1:5173', reuseExistingServer: false },
  ],
});
