import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['legacy/**', 'node_modules/**', 'dist/**', 'webui/dist/**', '.kilo/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } }
];
