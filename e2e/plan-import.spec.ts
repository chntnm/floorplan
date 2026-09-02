import { expect, test, type Locator, type Page } from '@playwright/test';
import { makePdf, makePng } from './fixtures';

/**
 * Import and the calibration gate — PLAN.md §6.1.
 *
 * The numbers here are load-bearing and worth stating once:
 *
 *   The fixture is **400 × 300 px**. An uncalibrated plan is shown at the nominal
 *   width of 6000mm, so its provisional scale is 6000/400 = **15 mm/px**, and the
 *   raster's left edge sits at the document origin.
 *
 *   A reference dragged from document 0mm to 3000mm therefore spans image pixels
 *   0…200. Declaring that 50ft (15240mm) gives 15240/200 = **76.2 mm/px**, and the
 *   plan becomes 400 × 76.2 = 30480mm wide — exactly 100 feet, which is what the
 *   status bar is asserted to read.
 *
 * Import deliberately does not touch the viewport, so the screen↔document mapping
 * documented in `plan-editor.spec.ts` still holds after one.
 */
const SCALE = 0.05;
const ORIGIN = { x: 120, y: 100 };

const PLAN_PNG = { width: 400, height: 300 };

async function docToPage(stage: Locator, mm: { x: number; y: number }) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('plan stage has no bounding box');
  return { x: box.x + ORIGIN.x + mm.x * SCALE, y: box.y + ORIGIN.y + mm.y * SCALE };
}

async function importPng(page: Page, name = 'plan.png') {
  await page.getByLabel('Import a floor plan').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: makePng(PLAN_PNG.width, PLAN_PNG.height),
  });
  await expect(page.getByTestId('calibration-gate')).toBeVisible();
}

/** Drag the reference line across a known span of the plan, in document mm. */
async function drawReference(
  page: Page,
  stage: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const a = await docToPage(stage, from);
  const b = await docToPage(stage, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();
  await expect(page.getByTestId('calibration-ref')).toBeVisible();
}

async function calibrate(page: Page, stage: Locator, length: string) {
  await drawReference(page, stage, { x: 0, y: 0 }, { x: 3000, y: 0 });
  await page.getByTestId('calibration-length').fill(length);
  await page.getByRole('button', { name: 'Set scale' }).click();
  await expect(page.getByTestId('calibration-gate')).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

test.describe('the calibration gate', () => {
  test('blocks the editor until the plan has a scale', async ({ page }) => {
    await importPng(page);

    // Blocking is the point. A plan with no scale produces walls whose lengths mean
    // nothing, and nothing downstream can correct them afterwards.
    await expect(page.getByRole('button', { name: 'Wall', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Room', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeDisabled();
    await expect(page.getByTestId('background-readout')).toHaveText('Plan uncalibrated');
    await expect(page.getByTestId('placement-blocked')).toBeVisible();
  });

  test('turns a drawn reference into a real scale', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await importPng(page);

    // 3000mm of document under the provisional scale is 200 image pixels. Calling
    // that 50ft makes the 400px plan exactly 100ft wide.
    await calibrate(page, stage, '50ft');

    await expect(page.getByTestId('background-readout')).toHaveText(`Plan 100' 0" wide`);
    await expect(page.getByTestId('placement-blocked')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Wall', exact: true })).toBeEnabled();
  });

  test('refuses a reference too short to have been drawn deliberately', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await importPng(page);

    // 40mm of document is under three image pixels — a slip, not a measurement.
    await drawReference(page, stage, { x: 0, y: 0 }, { x: 40, y: 0 });
    await page.getByTestId('calibration-length').fill('3m');
    await page.getByRole('button', { name: 'Set scale' }).click();

    await expect(page.getByTestId('calibration-error')).toBeVisible();
    await expect(page.getByTestId('calibration-gate')).toBeVisible();
    await expect(page.getByTestId('background-readout')).toHaveText('Plan uncalibrated');
  });

  test('rejects a length it cannot parse rather than guessing', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await importPng(page);
    await drawReference(page, stage, { x: 0, y: 0 }, { x: 3000, y: 0 });

    await page.getByTestId('calibration-length').fill('about a metre');
    await page.getByRole('button', { name: 'Set scale' }).click();

    await expect(page.getByTestId('calibration-error')).toBeVisible();
    await expect(page.getByTestId('background-readout')).toHaveText('Plan uncalibrated');
  });

  test('discarding at the gate leaves no half-imported plan behind', async ({ page }) => {
    await importPng(page);
    await page.getByRole('button', { name: 'Discard plan' }).click();

    // Keeping an uncalibrated plan would leave the document permanently unable to
    // accept placements, with nothing on screen explaining why.
    await expect(page.getByTestId('calibration-gate')).toBeHidden();
    await expect(page.getByTestId('background-readout')).toBeHidden();
    await expect(page.getByTestId('placement-blocked')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Wall', exact: true })).toBeEnabled();
  });

  test('reopens for a recalibration, and cancelling keeps the old scale', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await importPng(page);
    await calibrate(page, stage, '50ft');

    await page.getByTestId('recalibrate').click();
    await expect(page.getByTestId('calibration-gate')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByTestId('background-readout')).toHaveText(`Plan 100' 0" wide`);
  });
});

test.describe('importing', () => {
  test('says so when the file is not a format it can read', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });

    await page.getByLabel('Import a floor plan').setInputFiles({
      name: 'notes.txt',
      mimeType: 'image/png', // the browser lies; the magic bytes do not
      buffer: Buffer.from('this is not an image'),
    });

    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('PDF, PNG, JPEG or WebP');
    await expect(page.getByTestId('calibration-gate')).toBeHidden();
  });

  test('asks which page of a multi-page PDF to trace', async ({ page }) => {
    await page.getByLabel('Import a floor plan').setInputFiles({
      name: 'floors.pdf',
      mimeType: 'application/pdf',
      buffer: makePdf(3),
    });

    const picker = page.getByTestId('page-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('3 pages');

    await page.getByTestId('page-number').fill('2');
    await page.getByRole('button', { name: 'Import page' }).click();

    // The gate opening is the proof the render reached a raster — which also proves
    // the pdfjs worker resolved in the production build the e2e suite runs against.
    await expect(page.getByTestId('calibration-gate')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('background-readout')).toHaveText('Plan uncalibrated');
  });

  test('does not ask which page when there is only one', async ({ page }) => {
    await page.getByLabel('Import a floor plan').setInputFiles({
      name: 'plan.pdf',
      mimeType: 'application/pdf',
      buffer: makePdf(1),
    });

    await expect(page.getByTestId('calibration-gate')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('page-picker')).toBeHidden();
  });

  test('replaces an existing plan rather than stacking one on top', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await importPng(page);
    await calibrate(page, stage, '50ft');

    await importPng(page, 'second.png');
    await expect(page.getByTestId('background-readout')).toHaveText('Plan uncalibrated');
  });
});

test.describe('portability', () => {
  test('carries the plan into the saved file and back out', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await importPng(page);
    await calibrate(page, stage, '50ft');

    // Trace something over it, so the reopened document has to line up as well as
    // merely exist.
    const wall = page.getByRole('button', { name: 'Wall', exact: true });
    await wall.click();
    await expect(wall).toHaveAttribute('aria-pressed', 'true');
    const a = await docToPage(stage, { x: 1000, y: 2000 });
    const b = await docToPage(stage, { x: 5000, y: 2000 });
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('count-walls')).toContainText('1');

    const title = page.getByLabel('Space name');
    await title.fill('Traced Plan');
    await title.press('Enter');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save' }).click();
    const download = await downloadPromise;
    const file = await download.path();
    await expect(page.getByTestId('dirty-flag')).toBeEmpty();

    // A reload is a genuinely empty editor — the asset store is memory, not storage.
    await page.reload();
    await expect(page.getByTestId('background-readout')).toBeHidden();

    await page.getByLabel('Open a .space file').setInputFiles(file);

    // The scale survived, the walls survived, and the raster came back with them:
    // `background-missing` is the panel's warning for a manifest with no bytes.
    await expect(page.getByTestId('background-readout')).toHaveText(`Plan 100' 0" wide`);
    await expect(page.getByTestId('count-walls')).toContainText('1');
    await expect(page.getByTestId('background-missing')).toBeHidden();
    await expect(page.getByTestId('placement-blocked')).toBeHidden();
  });
});
