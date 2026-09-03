import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { clickAt, selectTool } from './coords';
import {
  disableSaveInPlace,
  pickerCount,
  savedBytes,
  savedName,
  stubSaveInPlace,
  writeCount,
} from './save';

/**
 * Saving, autosaving and getting work back — PLAN.md §5.
 *
 * The claim under test is behavioural and not visible in a screenshot: "the handle is
 * retained in memory so Ctrl+S is a true save-in-place, no download prompt". A unit
 * test with a fake handle passes even when the wiring re-prompts every time, so the
 * discriminating assertion is the *count* of picker openings across two saves.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

async function drawWall(page: Page, y = 0) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Wall');
  await clickAt(page, stage, { x: 0, y });
  await clickAt(page, stage, { x: 4000, y });
  await page.keyboard.press('Enter');
}

/**
 * Save, and wait for the write to land.
 *
 * The click resolves when the handler is *called*; building the container and
 * encoding the thumbnail are both async. Reading the bytes straight after the click
 * races that, and the cleared dirty flag is the app's own signal that the write
 * resolved — there is nothing to poll that is closer to the truth.
 */
async function saveAndSettle(page: Page, testId = 'save-file') {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId('dirty-flag')).toBeEmpty();
}

async function nameIt(page: Page, name: string) {
  const title = page.getByLabel('Space name');
  await title.fill(name);
  await title.press('Enter');
}

test.describe('saving in place', () => {
  test('asks where to save once, and never again for that document', async ({ page }) => {
    await stubSaveInPlace(page);
    await drawWall(page);
    await nameIt(page, 'Maple Street');

    await saveAndSettle(page);
    expect(await pickerCount(page)).toBe(1);
    expect(await savedName(page)).toBe('Maple-Street.space');

    // The second save is the whole feature. A wiring that re-prompted here would
    // still write the right bytes, and a unit test with a fake handle would still
    // pass — the count is the only thing that can tell the two apart.
    await drawWall(page, 2000);
    await expect(page.getByTestId('dirty-flag')).toHaveText('•');
    await page.keyboard.press('Control+s');

    await expect(page.getByTestId('dirty-flag')).toBeEmpty();
    expect(await pickerCount(page)).toBe(1);
    expect(await writeCount(page)).toBe(2);
  });

  test('asks again when you explicitly say save as', async ({ page }) => {
    await stubSaveInPlace(page);
    await drawWall(page);
    await saveAndSettle(page);
    expect(await pickerCount(page)).toBe(1);

    // Without this the retained handle is a trap: once a document has a file there
    // would be no way to write it anywhere else.
    //
    // Polled rather than read once: the document is already clean, so the dirty flag
    // settles instantly and says nothing about this save — and the picker opens only
    // after the container bytes and the thumbnail have been built.
    await page.getByTestId('save-file-as').click();
    await expect.poll(() => pickerCount(page)).toBe(2);
  });

  test('a cancelled save leaves the document unsaved and says nothing', async ({ page }) => {
    await stubSaveInPlace(page, { cancel: true });
    await drawWall(page);

    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });

    await page.getByTestId('save-file').click();

    // Dismissing the picker is a decision, not a failure. An alert would report a
    // problem that did not happen, and a cleared dirty flag would claim a file
    // exists that does not.
    await expect(page.getByTestId('dirty-flag')).toHaveText('•');
    expect(dialogs).toBe(0);
    expect(await writeCount(page)).toBe(0);
  });

  test('falls back to a download where there is no File System Access', async ({ page }) => {
    // Firefox and Safari. Not a degraded mode to apologise for — it is what proved
    // the portability requirement through every phase before this one.
    await disableSaveInPlace(page);
    await drawWall(page);
    await nameIt(page, 'Maple Street');

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('save-file').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('Maple-Street.space');
    await expect(page.getByTestId('dirty-flag')).toBeEmpty();
  });
});

test.describe('the container', () => {
  test('round-trips through the bytes a save-in-place wrote', async ({ page }) => {
    await stubSaveInPlace(page);
    await drawWall(page);
    await drawWall(page, 2000);
    await nameIt(page, 'Two Walls');
    await saveAndSettle(page);

    const bytes = await savedBytes(page);

    await page.goto('/');
    await expect(page.getByTestId('count-walls')).toContainText('0');
    await page.getByLabel('Open a .space file').setInputFiles({
      name: 'Two-Walls.space',
      mimeType: 'application/zip',
      buffer: bytes,
    });

    await expect(page.getByTestId('count-walls')).toContainText('2');
    await expect(page.getByLabel('Space name')).toHaveValue('Two Walls');
  });

  test('carries a thumbnail', async ({ page }) => {
    await stubSaveInPlace(page);
    await drawWall(page);
    await saveAndSettle(page);

    const entries = unzipSync(new Uint8Array(await savedBytes(page)));
    expect(Object.keys(entries)).toContain('thumbnail.png');
    // A PNG header alone would satisfy "present". Something was actually drawn.
    expect(entries['thumbnail.png']!.byteLength).toBeGreaterThan(200);
    expect(Array.from(entries['thumbnail.png']!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('an empty document saves without a thumbnail rather than a blank square', async ({
    page,
  }) => {
    await stubSaveInPlace(page);
    await nameIt(page, 'Nothing Yet');
    await saveAndSettle(page);

    const entries = unzipSync(new Uint8Array(await savedBytes(page)));
    expect(Object.keys(entries)).not.toContain('thumbnail.png');
    expect(Object.keys(entries)).toContain('document.json');
  });
});

test.describe('autosave and recovery', () => {
  test('offers work back after the tab dies', async ({ page }) => {
    await drawWall(page);
    await nameIt(page, 'Unsaved Flat');

    // The quiet debounce is 2s; wait for the write rather than for a wall-clock
    // guess, so a slower machine does not turn this into a flake.
    await expect
      .poll(async () => page.evaluate(autosaveCount), { timeout: 15_000 })
      .toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId('plan-stage')).toBeVisible();
    // A reload is a genuinely empty editor — nothing is carried in memory.
    await expect(page.getByTestId('count-walls')).toContainText('0');

    const banner = page.getByTestId('recovery-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Unsaved Flat');

    await page.getByTestId('recovery-restore').click();
    await expect(page.getByTestId('count-walls')).toContainText('1');
    // Never written to a file, so it arrives with unsaved changes. Opening it clean
    // would let the user close the tab a second time on the same work.
    await expect(page.getByTestId('dirty-flag')).toHaveText('•');
  });

  test('does not offer work that was saved to a file', async ({ page }) => {
    // The rule that keeps the prompt worth reading. Without it every clean reload
    // greets you with an offer to recover something you already saved, and the
    // prompt is trained out of you long before the one time it matters.
    await stubSaveInPlace(page);
    await drawWall(page);
    await expect
      .poll(async () => page.evaluate(autosaveCount), { timeout: 15_000 })
      .toBeGreaterThan(0);

    await saveAndSettle(page);
    await expect.poll(async () => page.evaluate(autosaveCount), { timeout: 15_000 }).toBe(0);

    await page.reload();
    await expect(page.getByTestId('plan-stage')).toBeVisible();
    await expect(page.getByTestId('recovery-banner')).toBeHidden();
  });

  test('a discarded offer does not come back', async ({ page }) => {
    await drawWall(page);
    await expect
      .poll(async () => page.evaluate(autosaveCount), { timeout: 15_000 })
      .toBeGreaterThan(0);

    await page.reload();
    await page.getByTestId('recovery-discard').click();
    await expect(page.getByTestId('recovery-banner')).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('plan-stage')).toBeVisible();
    await expect(page.getByTestId('recovery-banner')).toBeHidden();
  });
});

test.describe('dropping a file on the window', () => {
  test('opens a dropped .space', async ({ page }) => {
    await stubSaveInPlace(page);
    await drawWall(page);
    await nameIt(page, 'Dropped Space');
    await saveAndSettle(page);
    const bytes = await savedBytes(page);

    await page.goto('/');
    await expect(page.getByTestId('count-walls')).toContainText('0');

    const transfer = await page.evaluateHandle((data) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array(data)], 'Dropped-Space.space', { type: 'application/zip' }),
      );
      return dt;
    }, Array.from(bytes));

    await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });

    await expect(page.getByTestId('count-walls')).toContainText('1');
    await expect(page.getByLabel('Space name')).toHaveValue('Dropped Space');
  });

  test('shows an overlay while a file is over the window', async ({ page }) => {
    const transfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'plan.png', { type: 'image/png' }));
      return dt;
    });

    await expect(page.getByTestId('drop-overlay')).toBeHidden();
    await page.dispatchEvent('body', 'dragover', { dataTransfer: transfer });
    await expect(page.getByTestId('drop-overlay')).toBeVisible();
  });
});

/** How many autosave records the database holds. Runs in the page. */
function autosaveCount(): Promise<number> {
  return new Promise((resolve) => {
    const open = indexedDB.open('floorplan', 1);
    open.onerror = () => resolve(0);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('documents')) {
        db.close();
        resolve(0);
        return;
      }
      const request = db.transaction('documents', 'readonly').objectStore('documents').count();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => {
        db.close();
        resolve(0);
      };
    };
  });
}
