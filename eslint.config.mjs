import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['.cache/**', '**/node_modules/**', '**/dist/**', '**/generated/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/consistent-type-imports': 'error', '@typescript-eslint/no-explicit-any': 'error' } },
  { files: ['tooling/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', AbortSignal: 'readonly', fetch: 'readonly' } } },
);
