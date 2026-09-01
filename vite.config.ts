/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5190,
  },

  test: {
    // The geometry core is pure functions over numbers — no DOM needed, and a node
    // environment keeps the highest-value test suite in the project fast.
    // Component tests that need a DOM should opt in per-file with:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
