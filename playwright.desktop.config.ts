import { defineConfig } from '@playwright/test';

/**
 * The desktop suite. `pnpm e2e:desktop`.
 *
 * Its own config because it has neither a browser nor a web server: Playwright launches
 * the bundled main process itself and drives the window Electron opens. Kept out of
 * `pnpm e2e` — and out of CI — because it needs the Electron binary and a display,
 * neither of which the Linux runner has without more machinery than one smoke suite is
 * worth. Run it before cutting an installer.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'desktop.spec.ts',
  // One Electron instance, shared across the file. Parallel workers would each launch
  // their own, and every one after the first loses the single-instance lock and quits.
  workers: 1,
  reporter: 'list',
  timeout: 60_000,

  // The shell loads the built app off disk, so both halves have to exist first.
  globalSetup: './e2e/desktop-setup.ts',
});
