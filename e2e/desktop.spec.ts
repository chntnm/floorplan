import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { makePdf } from './fixtures';

/**
 * The desktop shell, against the real thing.
 *
 * The browser suite cannot cover any of this: what is under test is the *shell* — the
 * `app://` origin, the endpoint in the main process, the content security policy — and
 * none of it exists when the app is served over http. Every assertion here is for
 * something that would otherwise fail silently rather than loudly. A page that lost its
 * secure context does not throw; `supportsSaveInPlace()` simply answers false and
 * Ctrl+S starts writing to the downloads folder. A policy one directive too strict does
 * not fail the build; the 3D view just never appears.
 *
 * One app instance, serially, because launching Electron costs a second and none of
 * these tests wants a fresh document.
 */

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];

/**
 * Point the suite at an installed build by setting `FLOORPLAN_APP` to its executable:
 *
 *     FLOORPLAN_APP=release/win-unpacked/floorplan.exe pnpm e2e:desktop
 *
 * Same assertions, one step later in the pipeline — the packaged app serves the same
 * files out of an `app.asar` archive rather than off the disk, and "it worked from
 * `dist/`" says nothing about whether that read path works.
 */
const PACKAGED = process.env['FLOORPLAN_APP'];

test.beforeAll(async () => {
  app = await electron.launch(
    PACKAGED ? { executablePath: PACKAGED } : { args: ['dist-electron/main.cjs'] },
  );
  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

test.afterAll(async () => {
  // `app.exit()` rather than `close()`: the window asks before closing on unsaved
  // work, and these tests deliberately leave work unsaved. A native dialog nobody can
  // answer would hang the run. The last test closes the window itself, so by here the
  // app may already be gone — which is a pass, not a failure to report.
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
});

test.describe('the window the shell opens', () => {
  test('is a real, secure origin — which is what the app is built on', async () => {
    const facts = await page.evaluate(() => ({
      origin: location.origin,
      secure: window.isSecureContext,
      picker: typeof (window as unknown as Record<string, unknown>)['showSaveFilePicker'],
      idb: typeof indexedDB,
    }));

    expect(facts.origin).toBe('app://floorplan');
    expect(facts.secure).toBe(true);
    // Save-in-place. Under `file://` this is `undefined`, and every Ctrl+S becomes a
    // download with no dialog — the one regression this whole scheme exists to stop.
    expect(facts.picker).toBe('function');
    expect(facts.idb).toBe('object');
  });

  test('can open the database crash recovery is kept in', async () => {
    // Chromium refuses IndexedDB on an opaque origin by failing the open request, not
    // by hiding the API — so the type check above is not on its own enough.
    const opened = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = indexedDB.open('floorplan-desktop-probe', 1);
          request.onsuccess = () => {
            request.result.close();
            resolve('ok');
          };
          request.onerror = () => resolve(String(request.error));
        }),
    );
    expect(opened).toBe('ok');
  });
});

test.describe('the app inside it', () => {
  test('renders the editor and builds the 3D view', async () => {
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();

    await page.getByRole('button', { name: 'Space', exact: true }).click();
    // The 3D chunk is a dynamic import, and a lazily loaded chunk is exactly what a
    // too-strict script-src or a wrong MIME type takes down.
    await expect(page.getByTestId('space-view')).toBeVisible();
    await expect(page.locator('.space__canvas canvas')).toBeVisible();

    await page.getByRole('button', { name: 'Plan', exact: true }).click();
    await expect(page.getByTestId('plan-stage')).toBeVisible();
  });

  test('runs the pdfjs worker under the content security policy', async () => {
    // The worker is a module script fetched from the app origin, and pdfjs decodes
    // some images in WebAssembly. Both are things a policy can forbid, and the gate
    // opening is proof neither did: it appears only once a page has rasterised.
    await page.getByLabel('Import a floor plan').setInputFiles({
      name: 'plan.pdf',
      mimeType: 'application/pdf',
      buffer: makePdf(1),
    });

    await expect(page.getByTestId('calibration-gate')).toBeVisible({ timeout: 30_000 });
  });

  test('reports unsaved work to the shell that has to ask about it', async () => {
    // The close prompt lives in the main process, and this is the seam it reads
    // through. Asserting it from the main process asserts the actual call.
    const title = page.getByTestId('doc-title');
    await title.fill('Desktop check');
    await title.blur();

    const unsaved = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
        'window.__floorplanUnsaved === true',
      ),
    );
    expect(unsaved).toBe(true);
  });
});

test.describe('the product lookup endpoint, in the main process', () => {
  test('answers JSON on the app origin', async () => {
    // Absent, this comes back as the index page with a 200, which the client reads as
    // "no endpoint here" — so the content type is the assertion, not the status.
    const answer = await page.evaluate(async () => {
      const response = await fetch('/api/product-lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'not a url' }),
      });
      return { type: response.headers.get('content-type'), status: response.status };
    });

    expect(answer.type).toContain('application/json');
    expect(answer.status).toBe(400);
  });

  test('still refuses to fetch the machine it is now running on', async () => {
    // Moving the lookup from a serverless function onto the user's own computer puts
    // it inside their network. The guards in src/server/lookup.ts are what make that
    // sound, and this is the check that they came along.
    const answer = await page.evaluate(async () => {
      const response = await fetch('/api/product-lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1:5190/admin' }),
      });
      return { status: response.status, message: (await response.json())['message'] };
    });

    expect(answer.status).toBe(400);
    expect(String(answer.message)).toMatch(/public|address|https/i);
  });
});

test('nothing in that session tripped the content security policy', () => {
  expect(consoleErrors.filter((line) => /content security policy/i.test(line))).toEqual([]);
});

/**
 * Last, because it ends the session it is testing.
 *
 * The close guard cancels the first close, asks the renderer a question and only then
 * closes for real — so the window closes twice, and the second pass has to be let
 * through. Get that wrong and the failure is not a missing prompt, it is a window that
 * cannot be closed at all, which is the worst thing in this shell. Both passes are
 * exercised here without a native dialog ever needing an answer.
 */
test('closes a window with nothing unsaved, and holds one that has', async () => {
  // Ask for the close and come back for the answer separately. Waiting inside the
  // evaluate spans the moment a native modal opens, and the nested message loop that
  // runs behind one loses the reply.
  const askToClose = () =>
    app
      .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
      .catch(() => undefined);

  const stillOpen = async () => {
    try {
      return await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return !!win && !win.isDestroyed();
      });
    } catch {
      // The app is gone, which is as closed as a window gets.
      return false;
    }
  };

  const setFlag = (value: boolean) =>
    page.evaluate((v) => {
      (window as unknown as Record<string, unknown>)['__floorplanUnsaved'] = v;
    }, value);

  await setFlag(true);
  await askToClose();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await stillOpen()).toBe(true);

  // The prompt from that attempt is still up, and answering a native dialog is not
  // something a test can do — but it is a modal child of the window, so the close that
  // follows takes it with it.
  await setFlag(false);
  await askToClose();
  await expect.poll(stillOpen, { timeout: 10_000 }).toBe(false);
});
