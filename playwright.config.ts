import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', outputDir: './tests/.artifacts', fullyParallel: false, workers: 1, use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node tooling/dev-server.mjs --test', url: 'http://127.0.0.1:3001/health/live', reuseExistingServer: false },
    { command: 'pnpm --filter @rize/web dev', url: 'http://127.0.0.1:5173', reuseExistingServer: false },
  ],
});
