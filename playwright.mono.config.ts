import { defineConfig } from '@playwright/test';
const runId = process.env.ARCADE_E2E_RUN_ID ?? 'mono-' + Date.now() + '-' + process.pid;
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'monopoly*.spec.ts', outputDir: './tests/.artifacts/' + runId,
  fullyParallel: false, workers: 1, use: { trace: 'retain-on-failure' },
});
