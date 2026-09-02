import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from './coords';
import { makePng } from './fixtures';

/**
 * Inventory and placement — PLAN.md §4.3, §7, §9.
 *
 * The screen-to-document mapping comes from `./coords`; nothing here zooms, pans or
 * fits, so it holds throughout.
 */

/** Draw a 4m × 3m room, which also gives us four walls to snap against. */
async function drawRoom(page: Page) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Room');
  await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });
  await expect(page.getByTestId('count-rooms')).toContainText('1');
  await expect(page.getByTestId('count-walls')).toContainText('4');
}

async function addPreset(page: Page, label: string) {
  await page.getByLabel('Add from the preset library').selectOption({ label });
  await expect(page.getByTestId('item-list')).toContainText(label.split(' — ')[1]!);
}

/** Arm an item for placing. This also switches into furnish mode. */
async function armFirstItem(page: Page) {
  const place = page.getByRole('button', { name: 'Place', exact: true }).first();
  await place.click();
  await expect(page.getByTestId('placing-note')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

test.describe('the catalog', () => {
  test('adds a standard size in one click', async ({ page }) => {
    await addPreset(page, 'Beds — Queen bed');

    const row = page.getByTestId('item-row').first();
    // A US queen is 60" x 80", and it starts unplaced.
    await expect(row).toContainText(`5' 0"`);
    await expect(row).toContainText(`6' 8"`);
    await expect(page.getByTestId('item-count')).toHaveText('0/1');
  });

  test('accepts a hand-entered item in any unit', async ({ page }) => {
    await page.getByTestId('add-item').click();
    await page.getByLabel('Item name').fill('Workbench');
    await page.getByLabel('Width').fill('1.8m');
    await page.getByLabel('Depth').fill('30"');
    await page.getByLabel('Height').fill('900');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByTestId('item-list')).toContainText('Workbench');
    // 1.8m and 30in, echoed back in the document's own unit.
    await expect(page.getByTestId('item-row').first()).toContainText(`5' 10.875"`);
  });

  test('refuses an item with no solid part left, and says why', async ({ page }) => {
    // A void as tall as the object inverts its span, so it would collide with
    // nothing at all and quietly stop being checked.
    await page.getByTestId('add-item').click();
    await page.getByLabel('Item name').fill('Impossible table');
    await page.getByLabel('Width').fill('1800mm');
    await page.getByLabel('Depth').fill('900mm');
    await page.getByLabel('Height').fill('760mm');
    await page.getByLabel('Open below').fill('900mm');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByTestId('inventory-error')).toContainText('less than the height');
    await expect(page.getByTestId('item-list')).toBeEmpty();
  });

  test('catches a units mistake instead of building a 45m table', async ({ page }) => {
    // A bare number follows the document's display unit, so in a ft-in space "1800"
    // is 1800 inches. The field echoes back what it understood, and the size guard
    // is the backstop when nobody reads it.
    await page.getByTestId('add-item').click();
    await page.getByLabel('Item name').fill('Table');
    await page.getByLabel('Width').fill('1800');
    await page.getByLabel('Depth').fill('900');
    await page.getByLabel('Height').fill('760');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByTestId('inventory-error')).toContainText('check the units');
  });

  test('keeps placements when the item they point at is edited', async ({ page }) => {
    await addPreset(page, 'Seating — Armchair');
    await armFirstItem(page);
    await clickAt(page, page.getByTestId('plan-stage'), { x: 2000, y: 1500 });
    await expect(page.getByTestId('count-placements')).toContainText('1');

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit Armchair' }).click();
    await page.getByLabel('Item name').fill('Reading chair');
    await page.getByTestId('item-form').getByRole('button', { name: 'Save' }).click();

    // The id survives an edit, so the placement is not orphaned.
    await expect(page.getByTestId('count-placements')).toContainText('1');
    await expect(page.getByTestId('item-list')).toContainText('Reading chair');
  });

  test('removes an item together with everything placed from it', async ({ page }) => {
    await addPreset(page, 'Seating — Dining chair');
    await armFirstItem(page);
    const stage = page.getByTestId('plan-stage');
    await clickAt(page, stage, { x: 1000, y: 1000 });
    await clickAt(page, stage, { x: 2000, y: 1000 });
    await expect(page.getByTestId('count-placements')).toContainText('2');

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Remove Dining chair' }).click();
    await expect(page.getByTestId('count-placements')).toContainText('0');
  });
});

test.describe('placing', () => {
  test('tracks owned against placed', async ({ page }) => {
    // "I own 6, 4 are placed" is the whole reason the catalog and the placements are
    // separate things.
    await addPreset(page, 'Seating — Dining chair');
    await armFirstItem(page);

    const stage = page.getByTestId('plan-stage');
    for (const x of [500, 1500, 2500, 3500]) await clickAt(page, stage, { x, y: 2500 });

    await expect(page.getByTestId('count-placements')).toContainText('4');
    await expect(page.getByTestId('item-count')).toHaveText('4/1');

    await page.getByLabel('Quantity of Dining chair owned').fill('6');
    await expect(page.getByTestId('item-count')).toHaveText('4/6');
  });

  test('snaps flush to a wall and turns to face it', async ({ page }) => {
    await drawRoom(page);
    await addPreset(page, 'Seating — Sofa (3-seat)');
    await armFirstItem(page);

    // Just inside the room's left wall, which runs vertically. A sofa dropped here
    // without a wall snap would stay at rotation 0; only the snap turns it.
    await clickAt(page, page.getByTestId('plan-stage'), { x: 300, y: 1500 });

    await expect(page.getByTestId('placement-properties')).toBeVisible();
    await expect(page.getByTestId('placement-rotation')).toHaveText('270°');
  });

  test('rotates from the properties panel and the keyboard', async ({ page }) => {
    await addPreset(page, 'Storage — Dresser');
    await armFirstItem(page);
    await clickAt(page, page.getByTestId('plan-stage'), { x: 2000, y: 2000 });
    await page.keyboard.press('Escape');

    // Escape cleared the selection too, so reselect by clicking it.
    await clickAt(page, page.getByTestId('plan-stage'), { x: 2000, y: 2000 });
    await expect(page.getByTestId('placement-rotation')).toHaveText('0°');

    await page.getByRole('button', { name: 'Rotate right' }).click();
    await expect(page.getByTestId('placement-rotation')).toHaveText('15°');

    await page.keyboard.press(']');
    await expect(page.getByTestId('placement-rotation')).toHaveText('30°');

    await page.keyboard.press('[');
    await page.keyboard.press('[');
    await expect(page.getByTestId('placement-rotation')).toHaveText('0°');
  });

  test('a drag across the plan is one undo step', async ({ page }) => {
    await addPreset(page, 'Storage — Dresser');
    await armFirstItem(page);
    const stage = page.getByTestId('plan-stage');
    await clickAt(page, stage, { x: 2000, y: 2000 });
    await page.keyboard.press('Escape');

    const before = await page.getByTestId('history-readout').textContent();
    await dragBetween(page, stage, { x: 2000, y: 2000 }, { x: 3500, y: 500 });

    // One entry for the whole drag, not one per mousemove.
    const undos = (n: string) => Number(n.split(' ')[0]);
    expect(undos((await page.getByTestId('history-readout').textContent())!)).toBe(
      undos(before!) + 1,
    );
  });
});

test.describe('validation', () => {
  test('warns about two solid things in the same place, and never blocks it', async ({ page }) => {
    // Armchairs, not dressers: a dresser can host things on top, so a second one
    // dropped on it would surface-mount rather than collide.
    await addPreset(page, 'Seating — Armchair');
    await armFirstItem(page);

    const stage = page.getByTestId('plan-stage');
    await clickAt(page, stage, { x: 2000, y: 2000 });
    await clickAt(page, stage, { x: 2100, y: 2000 });

    // Both were placed. The app said so and got out of the way.
    await expect(page.getByTestId('count-placements')).toContainText('2');
    await expect(page.getByTestId('issue-list')).toContainText('overlaps');
  });

  test('stacks onto something that can host, rather than reporting a collision', async ({
    page,
  }) => {
    await addPreset(page, 'Storage — Dresser');
    await armFirstItem(page);
    const stage = page.getByTestId('plan-stage');
    await clickAt(page, stage, { x: 2000, y: 2000 });
    await clickAt(page, stage, { x: 2000, y: 2000 });

    await expect(page.getByTestId('count-placements')).toContainText('2');
    await expect(page.getByTestId('placement-properties')).toContainText('On a surface');
    await expect(page.getByTestId('no-issues')).toBeVisible();
  });

  test('does not call a rug under a table a collision', async ({ page }) => {
    // Footprints overlap completely; solid spans do not. This is the case the
    // vertical axis exists for.
    await addPreset(page, 'Other — Rug (8 x 10 ft)');
    await armFirstItem(page);
    const stage = page.getByTestId('plan-stage');
    await clickAt(page, stage, { x: 2000, y: 2000 });
    await page.keyboard.press('Escape');

    await addPreset(page, 'Tables — Dining table (6)');
    await page.getByRole('button', { name: 'Place', exact: true }).nth(1).click();
    await clickAt(page, stage, { x: 2000, y: 2000 });

    await expect(page.getByTestId('count-placements')).toContainText('2');
    await expect(page.getByTestId('no-issues')).toBeVisible();
  });
});

test.describe('the calibration gate', () => {
  test('will not let anything be placed on an unscaled plan', async ({ page }) => {
    await addPreset(page, 'Storage — Dresser');
    await expect(page.getByRole('button', { name: 'Place', exact: true })).toBeEnabled();

    await page.getByLabel('Import a floor plan').setInputFiles({
      name: 'plan.png',
      mimeType: 'image/png',
      buffer: makePng(400, 300),
    });
    await expect(page.getByTestId('calibration-gate')).toBeVisible();

    // The reason is stated in both places a person might look, and the action that
    // would fail is not offered. `addPlacement` still throws underneath — that is
    // the enforcement, and it is pinned by the unit tests.
    await expect(page.getByTestId('inventory-blocked')).toContainText('calibrated');
    await expect(page.getByTestId('placement-blocked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place', exact: true })).toBeDisabled();
    await expect(page.getByTestId('count-placements')).toContainText('0');
  });
});
