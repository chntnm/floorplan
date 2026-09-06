/**
 * `pnpm desktop` — the Vite dev server, with an Electron window on it.
 *
 * The window loads `http://localhost:5190` rather than the `app://` scheme, which gives
 * hot module replacement and the dev server's own product-lookup middleware. Localhost
 * is a secure context, so the save picker and IndexedDB behave exactly as they do in the
 * packaged build and the shell takes the same code path either way.
 *
 * Vite is started through its Node API rather than as a spawned CLI so that the URL is
 * *reported* rather than assumed. Waiting for a port to answer cannot tell the server it
 * started from one that was already there — and pointing a window at somebody else's dev
 * server is a mistake this repository has made once already (see the note on
 * `reuseExistingServer` in playwright.config.ts). If 5190 is taken, Vite picks the next
 * free port and the window follows it there.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

// The shell itself has to be built; the renderer is served by Vite from source.
const bundle = spawn(process.execPath, ['desktop/build.mjs'], { stdio: 'inherit' });
await new Promise((resolve, reject) => {
  bundle.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`Bundling the shell failed (${code}).`)),
  );
});

const server = await createServer();
await server.listen();
server.printUrls();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  await server.close();
  throw new Error('The dev server started without a local URL to open.');
}

const app = spawn(electron, ['dist-electron/main.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, FLOORPLAN_DEV_URL: url },
});

// Closing the window ends the session. A dev server left running behind a window that
// is gone is how you end up with three of them on three ports — and a stray Vite
// watcher also holds directory handles, which on Windows is enough to make
// electron-builder fail to rename its own output directory.
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

// And the other direction: Ctrl+C, or anything else that ends this process, takes the
// window with it. Neither child is in this one's process group on Windows, so without
// this they outlive their parent and nothing is left holding their handles.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    app.kill();
    void server.close().finally(() => process.exit(0));
  });
}
