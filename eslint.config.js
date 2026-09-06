import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist',
      // Build output: the bundled main process, and what electron-builder packs.
      'dist-electron',
      'release',
      'node_modules',
      'playwright-report',
      'test-results',
      'coverage',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Plain node scripts — the fixture generator. Not part of the bundle and not
    // typechecked, so they need the node globals the browser config does not give.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Geometry code reads better with explicit numeric intent than with
      // inferred-everything; this is advisory, not enforced.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
