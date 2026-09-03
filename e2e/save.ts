import type { Page } from '@playwright/test';

/**
 * Driving the two save paths from a test.
 *
 * Headless Chromium *has* `showSaveFilePicker`, so the app takes the in-place path
 * there by default and no download ever fires. Both helpers below work only because
 * `supportsSaveInPlace()` reads `window` at call time rather than snapshotting it at
 * module load — with a snapshot neither of these could reach the branch it wants, and
 * one of the two paths would ship with no end-to-end coverage at all.
 *
 * `showSaveFilePicker` lives on `Window.prototype`, so `delete window.showSaveFilePicker`
 * is a no-op; shadowing it with an own property is what actually hides it.
 */

/** Make the page look like Firefox or Safari: no File System Access. */
export async function disableSaveInPlace(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });
}

/**
 * Install a fake picker that keeps the bytes in the page.
 *
 * Counts how many times it was asked, which is the only way to tell a genuine
 * save-in-place from a re-prompt that happens to write the right file.
 */
export async function stubSaveInPlace(
  page: Page,
  options: { cancel?: boolean } = {},
): Promise<void> {
  await page.evaluate((cancel) => {
    const w = window as unknown as Record<string, unknown>;
    w['__picks'] = 0;
    w['__saved'] = null;
    w['__savedName'] = null;
    w['__writes'] = 0;

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: async (opts: { suggestedName?: string }) => {
        w['__picks'] = (w['__picks'] as number) + 1;
        if (cancel) {
          const err = new Error('The user aborted a request.');
          err.name = 'AbortError';
          throw err;
        }
        const name = opts?.suggestedName ?? 'untitled.space';
        return {
          name,
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          createWritable: async () => ({
            write: async (blob: Blob) => {
              w['__saved'] = Array.from(new Uint8Array(await blob.arrayBuffer()));
              w['__savedName'] = name;
              w['__writes'] = (w['__writes'] as number) + 1;
            },
            close: async () => undefined,
          }),
        };
      },
    });
  }, options.cancel ?? false);
}

/** How many times the picker has been opened. */
export function pickerCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as Record<string, number>)['__picks'] ?? 0);
}

export function writeCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as Record<string, number>)['__writes'] ?? 0);
}

export function savedName(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as unknown as Record<string, string | null>)['__savedName'] ?? null,
  );
}

/** The bytes the last in-place save wrote. */
export async function savedBytes(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(
    () => (window as unknown as Record<string, number[] | null>)['__saved'],
  );
  if (!bytes) throw new Error('nothing has been saved in place yet');
  return Buffer.from(bytes);
}
