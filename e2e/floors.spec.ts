import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from './coords';

/**
 * Multiple floors — PLAN.md §11.
 *
 * The screen-to-document mapping comes from `./coords`. Switching floors deliberately
 * does not re-fit the viewport, so the mapping survives one — which is itself asserted
 * below, because a viewport that jumped on every floor change would make aligning a
 * staircase against the ghost impossible.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

async function drawRoom(page: Page, to = { x: 5000, y: 4000 }) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Room');
  await dragBetween(page, stage, { x: 0, y: 0 }, to);
  await expect(page.getByTestId('count-walls')).toContainText('4');
  return stage;
}

test.describe('the stack', () => {
  test('adds a floor above and opens it empty', async ({ page }) => {
    await drawRoom(page);
    await page.getByTestId('add-floor-above').click();

    await expect(page.getByTestId('count-walls')).toContainText('0');
    await expect(page.getByTestId('count-rooms')).toContainText('0');
    // Stacked to clear the ground floor's ceiling plus the structure between: 2438
    // plus 300 is 2738mm, which reads as 8' 11.75".
    await expect(page.getByTestId('floor-elevation')).toHaveValue(`8' 11.75"`);
  });

  test('goes back to the floor you drew on, with everything still on it', async ({ page }) => {
    await drawRoom(page);
    await page.getByTestId('add-floor-above').click();
    await expect(page.getByTestId('count-walls')).toContainText('0');

    await page.getByTestId('floor-picker').selectOption({ label: 'Ground' });
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });

  test('lists the top of the building at the top, the way a lift panel reads', async ({ page }) => {
    await page.getByTestId('add-floor-above').click();
    await page.getByTestId('add-floor-below').click();

    const labels = await page.getByTestId('floor-picker').locator('option').allTextContents();
    expect(labels).toEqual(['Level 2', 'Ground', 'Basement']);
  });

  test('refuses to delete the only floor, and says why', async ({ page }) => {
    await page.getByTestId('delete-floor').click();
    await expect(page.getByTestId('floor-error')).toContainText('at least one floor');
    await expect(page.getByTestId('floor-picker').locator('option')).toHaveCount(1);
  });

  test('does not put a floor change on the undo stack', async ({ page }) => {
    // Undo walks back edits. Having it teleport you between storeys instead would
    // make the stack unusable.
    await drawRoom(page);
    await page.getByTestId('add-floor-above').click();
    await page.getByTestId('floor-picker').selectOption({ label: 'Ground' });

    // One press undoes the *add*, not the two switches around it.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('floor-picker').locator('option')).toHaveCount(1);
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });

  test('carries every floor into the file and back out', async ({ page }) => {
    await drawRoom(page);
    await page.getByTestId('add-floor-above').click();
    await drawRoom(page, { x: 3000, y: 3000 });

    const download = page.waitForEvent('download');
    await page.getByTestId('save-file').click();
    const path = await (await download).path();

    await page.goto('/');
    await page.getByLabel('Open a .space file').setInputFiles(path);

    await expect(page.getByTestId('floor-picker').locator('option')).toHaveCount(2);
    // Reopened on the floor it was left on, which is why `activeFloorId` lives in the
    // document rather than in the editor — and the upstairs room came back with it.
    await expect(page.getByTestId('floor-picker').locator('option:checked')).toHaveText('Level 2');
    await expect(page.getByTestId('count-rooms')).toContainText('1');

    await page.getByTestId('floor-picker').selectOption({ label: 'Ground' });
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });
});

test.describe('the ghost underlay', () => {
  test('counts nothing and moves nothing', async ({ page }) => {
    // The regression this layer invites: ghost geometry leaking into the wall and
    // room counts, or into floorBounds and therefore zoom-to-fit.
    await drawRoom(page);
    await page.getByTestId('add-floor-above').click();

    await expect(page.getByTestId('count-walls')).toContainText('0');
    await expect(page.getByTestId('count-rooms')).toContainText('0');
  });

  test('is not in the hit graph, so empty canvas over it is still empty', async ({ page }) => {
    // `listening={false}` is load-bearing here. PlanStage reads a click as empty
    // canvas by `e.target === stage`, and that is what clears the selection and
    // starts a pan — so a listening ghost shape would silently break both, on every
    // floor above the ground one, only where a wall happens to sit underneath.
    const stage = await drawRoom(page);
    await page.getByTestId('add-floor-above').click();

    // A wall upstairs, clear of the ground floor's walls, and select it.
    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 1000, y: 1000 });
    await clickAt(page, stage, { x: 3000, y: 1000 });
    await page.keyboard.press('Enter');
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2000, y: 1000 });
    await expect(page.getByTestId('wall-properties')).toBeVisible();

    // Now click straight onto a ghost wall — the ground floor's south wall, where
    // nothing on this floor exists. It is empty canvas, and the selection goes.
    await clickAt(page, stage, { x: 2500, y: 4000 });
    await expect(page.getByTestId('wall-properties')).toHaveCount(0);
  });

  test('leaves the floor below alone when you edit the one above', async ({ page }) => {
    const stage = await drawRoom(page);
    await page.getByTestId('add-floor-above').click();

    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 5000, y: 0 });
    await page.keyboard.press('Enter');

    // Traced directly over a ghost wall, then deleted: the ground floor keeps its four.
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('count-walls')).toContainText('0');
    await page.getByTestId('floor-picker').selectOption({ label: 'Ground' });
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });

  test('keeps the viewport still across a floor change', async ({ page }) => {
    // Aligning an upstairs wall over the one holding it up is the whole point of the
    // underlay, and it only works if the two floors are drawn at the same place.
    const stage = await drawRoom(page);
    await page.getByTestId('add-floor-above').click();

    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 5000, y: 0 });
    await page.keyboard.press('Enter');

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2500, y: 0 });
    // 5000mm is 16' 4.875". Drawn at the same document coordinates as the ghost wall
    // it was traced over, which is only true if nothing re-fitted the viewport.
    await expect(page.getByTestId('wall-properties')).toContainText(`16' 4.875"`);
  });
});

test.describe('moving furniture between floors', () => {
  test('moves a placement to another floor, and takes it off this one', async ({ page }) => {
    const stage = await drawRoom(page);
    await page.getByLabel('Add from the preset library').selectOption({ label: 'Storage — Dresser' });
    await page.getByRole('button', { name: 'Place', exact: true }).last().click();
    await clickAt(page, stage, { x: 2500, y: 2000 });
    await page.keyboard.press('Escape');

    // A floor to move it to, then back to select it.
    await page.getByRole('button', { name: 'Edit floor plan', exact: true }).click();
    await page.getByTestId('add-floor-above').click();
    await page.getByTestId('floor-picker').selectOption({ label: 'Ground' });

    await page.getByRole('button', { name: 'Arrange furniture', exact: true }).click();
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2500, y: 2000 });
    await expect(page.getByTestId('placement-properties')).toBeVisible();

    await page.getByTestId('move-to-floor').selectOption({ label: 'Level 2' });
    await expect(page.getByTestId('count-placements')).toContainText('0');

    await page.getByTestId('floor-picker').selectOption({ label: 'Level 2' });
    await expect(page.getByTestId('count-placements')).toContainText('1');
  });
});

test.describe('the space view', () => {
  test('shows one floor, then the stack', async ({ page }) => {
    await drawRoom(page);
    await page.getByTestId('add-floor-above').click();
    await drawRoom(page, { x: 3000, y: 3000 });

    await page.getByRole('button', { name: 'Space', exact: true }).click();
    await expect(page.getByTestId('space-view')).toBeVisible();

    await expect(page.getByTestId('floors-active')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('floors-all').click();
    await expect(page.getByTestId('floors-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('floors-active')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('clicking through the stack in 3D', () => {
  test('selects the wall on the floor you are editing, not the storey in front of it', async ({
    page,
  }) => {
    // A solid on another floor must decline the click *before* stopping propagation.
    // R3F calls every intersected mesh in distance order until one stops it, so a
    // scenery solid that stopped first and declined second would eat the click on the
    // wall behind it — and looking at a building with every floor shown, the top
    // storey would swallow everything.
    await drawRoom(page, { x: 6000, y: 5000 });
    await page.getByTestId('add-floor-above').click();
    // Directly over the ground floor, so an upstairs wall really is in the way.
    await drawRoom(page, { x: 6000, y: 5000 });
    await page.getByTestId('floor-picker').selectOption({ label: 'Ground' });

    await page.getByRole('button', { name: 'Space', exact: true }).click();
    await expect(page.getByTestId('space-view')).toBeVisible();
    await page.getByTestId('floors-all').click();

    const canvas = page.locator('.space__canvas canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.getByTestId('wall-properties')).toBeVisible();
  });
});
