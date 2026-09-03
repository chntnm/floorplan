import { expect, test } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from './coords';

/**
 * Room detection and per-room ceiling heights — PLAN.md §11.
 *
 * The screen-to-document mapping comes from `./coords`; nothing here zooms, pans or
 * fits, so it holds throughout.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

test.describe('detecting rooms from walls', () => {
  test('finds the two rooms a partitioned rectangle encloses', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');

    // A 6 x 4 shell drawn as a wall loop, so nothing has traced a room yet.
    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 6000, y: 0 });
    await clickAt(page, stage, { x: 6000, y: 4000 });
    await clickAt(page, stage, { x: 0, y: 4000 });
    await clickAt(page, stage, { x: 0, y: 0 });
    await expect(page.getByTestId('count-walls')).toContainText('4');

    // A partition butting into the middle of the top and bottom walls — the
    // T-junction case, where the endpoints land on another wall's interior.
    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 4000, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 4000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('count-rooms')).toContainText('0');
    await page.getByTestId('detect-rooms').click();
    await expect(page.getByTestId('count-rooms')).toContainText('2');
    await expect(page.getByTestId('detect-report')).toContainText('2 new');
  });

  test('changes nothing the second time it is run', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });

    // The Room tool draws its boundary on the wall centrelines, which is exactly
    // what detection derives — so there is nothing to find and nothing to change.
    await page.getByTestId('detect-rooms').click();
    await expect(page.getByTestId('detect-report')).toContainText('No change');
    await expect(page.getByTestId('count-rooms')).toContainText('1');
  });

  test('keeps the name of a room it reshapes', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 6000, y: 4000 });

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 3000, y: 2000 });
    const name = page.getByTestId('room-properties').getByRole('textbox').first();
    await name.fill('Living room');
    await name.press('Enter');

    // Partition it. The larger half keeps the name; the smaller becomes a new room.
    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 4000, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 4000 });
    await page.keyboard.press('Enter');
    await page.getByTestId('detect-rooms').click();

    await expect(page.getByTestId('count-rooms')).toContainText('2');
    await expect(page.getByTestId('detect-report')).toContainText('1 new');
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2000, y: 2000 });
    await expect(page.getByTestId('room-properties').getByRole('textbox').first()).toHaveValue(
      'Living room',
    );
  });

  test('is one undo step', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 3000 });
    await clickAt(page, stage, { x: 0, y: 3000 });
    await clickAt(page, stage, { x: 0, y: 0 });

    await page.getByTestId('detect-rooms').click();
    await expect(page.getByTestId('count-rooms')).toContainText('1');

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('count-rooms')).toContainText('0');
    // And the walls it was derived from are still there — undo reversed the
    // detection, not the drawing.
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });

  test('is locked in furnish mode, like every other structure edit', async ({ page }) => {
    await page.getByRole('button', { name: 'Arrange furniture', exact: true }).click();
    await expect(page.getByTestId('detect-rooms')).toBeDisabled();
  });
});

test.describe('per-room ceiling height', () => {
  test('lowering a ceiling reports the furniture that no longer fits', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 5000, y: 4000 });

    // A 2000mm-tall wardrobe clears a standard 2438 ceiling with room to spare.
    await page.getByLabel('Add from the preset library').selectOption({ label: 'Storage — Wardrobe' });
    await page.getByRole('button', { name: 'Place', exact: true }).last().click();
    await clickAt(page, stage, { x: 2500, y: 2000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('no-issues')).toBeVisible();

    // Back to the plan: placing a preset arms furnish mode, and a ceiling height is
    // a structure property like every other thing a room owns.
    await page.getByRole('button', { name: 'Edit floor plan', exact: true }).click();

    // Drop the ceiling below it. `ceilingHeightAt` reads the room the placement
    // stands in, so the headroom check answers differently with no other change.
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 1000, y: 3500 });
    const ceiling = page.getByTestId('room-ceiling');
    // Suffixed, because the document displays feet and inches and a bare number is
    // read in the display unit — 1900 would be 1900 *inches*.
    await ceiling.fill('1900mm');
    await ceiling.press('Enter');

    await expect(page.getByTestId('issue-list')).toContainText('Headroom');
  });
});
