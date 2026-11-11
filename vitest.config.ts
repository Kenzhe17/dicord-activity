import { defineConfig } from 'vitest/config';
// Persistent integration suites share arcade_test. Independent server pollers
// must not advance another file's active timer fixture. Concurrency within a
// scenario (multiple clients, conflicting actions) is still tested explicitly.
export default defineConfig({ test: { fileParallelism: false, include: ['packages/**/*.test.ts', 'games/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'], testTimeout: 10000, restoreMocks: true } });
