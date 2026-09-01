import { defineConfig, devices } from '@playwright/test';

const PORT = 5191;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // Serialized in CI; locally Playwright's default (cores / 2) is fine.
  // Spread rather than `undefined` — exactOptionalPropertyTypes is on.
  ...(process.env.CI ? { workers: 1 } : {}),

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Runs against a production build so e2e exercises what actually ships.
  webServer: {
    command: `pnpm run build && pnpm run preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Always start our own server. Reusing whatever happens to be on the port
    // silently tested a sibling project's app once already.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
