import { defineConfig, devices } from '@playwright/test';

const PORT = 5192;

/**
 * The README's screenshots and clips, captured from the running application.
 *
 * Deliberately separate from `playwright.config.ts`, because this is not a test
 * run. It asserts only enough to know the app got into the state being
 * photographed — a capture that silently shot an empty canvas is worse than no
 * capture, since it looks like a product bug. It must never gate CI on whether a
 * GIF re-encoded byte-identically.
 *
 * Same webServer contract as the e2e config: a production build, on its own port.
 */
export default defineConfig({
  testDir: './media',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 180_000,

  use: {
    baseURL: `http://localhost:${PORT}`,
  },

  projects: [
    {
      name: 'capture',
      use: {
        ...devices['Desktop Chrome'],
        // After the device spread, or Desktop Chrome's own 1280x720 at 1x wins.
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        launchOptions: {
          // Headless Chromium has no GPU. Without a software rasteriser the
          // three.js canvas photographs as an empty rectangle.
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],

  webServer: {
    command: `pnpm run build && pnpm run preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
