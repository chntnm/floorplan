/**
 * The desktop shell. See README, "The desktop build".
 *
 * It owns a window and nothing else. There is no desktop-only feature branch in the
 * app: the renderer is byte-for-byte the `dist/` that the web deployment serves, and
 * everything the desktop adds — a real origin, the product-lookup endpoint, a prompt
 * before closing on unsaved work — is arranged around it rather than inside it. That
 * is the property worth keeping. The moment the shell needs the app's cooperation,
 * the two builds start to drift and every feature has to be verified twice.
 *
 * The window is a plain Chromium renderer with no Node in it: `contextIsolation` on,
 * `nodeIntegration` off, `sandbox` on, and no preload script at all, because there is
 * no IPC to expose. The endpoint arrives over the same origin as the rest of the app
 * (see `protocol.ts`) and the unsaved check is a read, so the bridge that would
 * normally carry them does not need to exist.
 */

import { app, BrowserWindow, Menu, dialog, protocol, shell } from 'electron';
import { join } from 'node:path';

import { APP_INDEX, APP_SCHEME, createAppHandler } from './protocol';
import { buildMenu } from './menu';

/** Set by `desktop/dev.mjs`; absent in a packaged build. */
const DEV_URL = process.env['FLOORPLAN_DEV_URL'];

/** The built web app, beside this file — inside `app.asar` once packaged. */
const DIST = join(__dirname, '..', 'dist');

/**
 * The renderer publishes this; `src/state/unsaved.ts` explains the shape.
 * A window that cannot answer is treated as clean — a shell that refuses to close
 * because it failed to read a flag is worse than one that closes on an autosaved
 * document.
 */
const UNSAVED_EXPRESSION = 'window.__floorplanUnsaved === true';

// Must run before `app.whenReady()`. `standard` gives the scheme a host and ordinary
// relative-URL resolution; `secure` makes it a trustworthy origin, which is what the
// File System Access API and IndexedDB require. See protocol.ts.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

/**
 * Ask before discarding unsaved work.
 *
 * Closing is not silently destructive even without this — the autosave in IndexedDB
 * survives, and the recovery banner offers it back on the next launch, which is the
 * same path a crash takes. But "your work is in a prompt you have not seen yet" is a
 * poor answer to Alt+F4, so the window asks, and only the window: quitting from the
 * dock or the taskbar closes the window and lands here too.
 */
function guardClose(win: BrowserWindow): void {
  let forceClose = false;

  win.on('close', (event) => {
    if (forceClose) return;
    event.preventDefault();

    void (async () => {
      let unsaved = false;
      try {
        unsaved = (await win.webContents.executeJavaScript(UNSAVED_EXPRESSION)) === true;
      } catch {
        unsaved = false;
      }

      if (unsaved) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Close without saving', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Unsaved changes',
          message: 'This space has changes that have not been saved to a file.',
          detail:
            'Cancel and press Ctrl+S to save it. Closing keeps the autosaved copy, ' +
            'which floorplan offers back the next time it starts.',
        });
        if (response === 1) return;
      }

      forceClose = true;
      win.close();
    })();
  });
}

/**
 * Links out go to the real browser.
 *
 * Two exits, both closed: `setWindowOpenHandler` for `target=_blank` and
 * `window.open`, `will-navigate` for a plain link or a script assignment to
 * `location`. Without these, a stray link would replace the app with a web page
 * inside a window that has no address bar and no back button, and the open document
 * would be gone.
 */
function lockNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const here = DEV_URL ?? APP_INDEX;
    if (url.startsWith(here)) return;
    event.preventDefault();
    if (url.startsWith('https://')) void shell.openExternal(url);
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    // The app paints its own background; showing the window before it does gives a
    // white flash on a dark desktop.
    show: false,
    backgroundColor: '#111315',
    autoHideMenuBar: true,
    title: 'floorplan',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The 3D view is the point of the app; a window that composites without the GPU
      // would still work and would not be worth shipping.
      webgl: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  guardClose(win);
  lockNavigation(win);

  void win.loadURL(DEV_URL ?? APP_INDEX);
  return win;
}

// One instance. A second launch focuses the window that is already open rather than
// starting a rival copy with its own autosave of the same document.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, createAppHandler(DIST));
    Menu.setApplicationMenu(buildMenu(app.getVersion()));

    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
