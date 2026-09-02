import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from './coords';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

/** A 5m × 4m room, whose north wall runs along y = 0 from x = 0 to x = 5000. */
async function room(page: Page) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Room');
  await dragBetween(page, stage, { x: 0, y: 0 }, { x: 5000, y: 4000 });
  await expect(page.getByTestId('count-walls')).toContainText('4');
  return stage;
}

test.describe('the opening tool', () => {
  test('puts a door in the wall you click', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });

    await expect(page.getByTestId('count-openings')).toContainText('1');
    // Selected on drop, so the panel is already showing what you just made. A 32"
    // door is 813mm, which reads as 2' 8".
    const panel = page.getByTestId('opening-properties');
    await expect(panel.getByLabel('Width')).toHaveValue(`2' 8"`);
    await expect(panel.getByLabel('Sill')).toHaveValue(`0' 0"`);
  });

  test('does nothing when the click misses every wall', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 2000 }); // the middle of the room

    await expect(page.getByTestId('count-openings')).toContainText('0');
  });

  test('drops a window at sill height, not a door', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await selectTool(page, 'Window');
    await clickAt(page, stage, { x: 1500, y: 0 });

    // Sill 914mm is 3'0", head 914 + 1219 = 2133mm is 7'0". The sill is what makes
    // this a window rather than a doorway you would trip over.
    const panel = page.getByTestId('opening-properties');
    await expect(panel.getByLabel('Sill')).toHaveValue(`3' 0"`);
    await expect(panel).toContainText(`7' 0"`);
  });

  test('is one undo step', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await expect(page.getByTestId('count-openings')).toContainText('1');

    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('count-openings')).toContainText('0');
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });

  test('selects the doorway rather than the wall behind it', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await expect(page.getByTestId('opening-properties')).toBeVisible();
    await expect(page.getByTestId('wall-properties')).toBeHidden();
  });

  test('takes its openings with the wall when the wall is deleted', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await expect(page.getByTestId('count-openings')).toContainText('1');

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 4200, y: 0 }); // the wall, clear of the doorway
    await expect(page.getByTestId('wall-properties')).toBeVisible();
    await page.keyboard.press('Delete');

    await expect(page.getByTestId('count-walls')).toContainText('3');
    await expect(page.getByTestId('count-openings')).toContainText('0');
  });

  test('warns when an edit pushes a door off the end of its wall, and never blocks it', async ({
    page,
  }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });

    // Typed, not dragged: the panel does not clamp, because silently sliding
    // somebody's front door along the wall would hide the mistake.
    const offset = page.getByTestId('opening-properties').getByLabel('From wall start');
    await offset.fill('4800mm');
    await offset.press('Enter');

    await expect(page.getByTestId('issue-list')).toContainText('past the end');
    await expect(page.getByTestId('count-openings')).toContainText('1');
  });

  test('warns about two doors overlapping in the same wall', async ({ page }) => {
    const stage = await room(page);

    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await clickAt(page, stage, { x: 2800, y: 0 });

    await expect(page.getByTestId('count-openings')).toContainText('2');
    await expect(page.getByTestId('issue-list')).toContainText('overlap in the same wall');
  });
});
