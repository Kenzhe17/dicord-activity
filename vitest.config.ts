import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'games/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'], testTimeout: 10000, restoreMocks: true } });
