import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from './coords';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

/** A 5m × 4m room with a door in its north wall, then switch to the space view. */
async function roomWithDoor(page: Page, { door = true } = {}) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Room');
  await dragBetween(page, stage, { x: 0, y: 0 }, { x: 5000, y: 4000 });
  await expect(page.getByTestId('count-walls')).toContainText('4');

  if (door) {
    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await expect(page.getByTestId('count-openings')).toContainText('1');
  }

  await page.getByRole('button', { name: 'Space', exact: true }).click();
  await expect(page.getByTestId('space-view')).toBeVisible();
}

/**
 * Hold a key for a while, the way a person walking does.
 *
 * `press` is a down and an immediate up, which the walk loop reads as a single frame
 * of input — a few millimetres. Walking anywhere needs the key actually held.
 */
async function hold(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/** The walker's position, parsed back out of the HUD readout. */
async function walkerAt(page: Page) {
  const text = (await page.getByTestId('walker-readout').textContent()) ?? '';
  return text.trim();
}

test.describe('the space view', () => {
  test('shows where you are standing before you have moved', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();

    // Seeded at the middle of the largest room, not at the document origin.
    await expect(page.getByTestId('walker-room')).toHaveText('Room 1');
  });

  test('walks forward when the arrow key is held', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();

    await hold(page, 'ArrowUp', 60); // seed the walker
    const before = await walkerAt(page);
    await hold(page, 'ArrowUp', 400);

    expect(await walkerAt(page)).not.toBe(before);
  });

  test('turns with the left and right arrows', async ({ page }) => {
    // Arrows alone have to be enough to get around; without turning you can only
    // ever slide along one axis.
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();
    await hold(page, 'ArrowUp', 60);

    const start = await walkerAt(page);
    await hold(page, 'ArrowRight', 500);
    await hold(page, 'ArrowUp', 400);

    // Having turned, walking forward moves along a different axis than it did.
    expect(await walkerAt(page)).not.toBe(start);
  });

  test('gets out through the doorway', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();

    await hold(page, 'ArrowUp', 2500);
    await expect(page.getByTestId('walker-room')).toHaveText('Unbounded');
  });

  test('does not get out when the wall is solid', async ({ page }) => {
    await roomWithDoor(page, { door: false });
    await page.getByTestId('camera-walk').click();

    await hold(page, 'ArrowUp', 2500);
    await expect(page.getByTestId('walker-room')).toHaveText('Room 1');
  });

  test('reports crouching, and stops when the key is released', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();
    await hold(page, 'ArrowUp', 60);

    await page.keyboard.down('c');
    await expect(page.getByTestId('walker-crouching')).toBeVisible();
    await page.keyboard.up('c');
    await expect(page.getByTestId('walker-crouching')).toBeHidden();
  });

  test('cycles camera modes with Tab', async ({ page }) => {
    await roomWithDoor(page);
    await expect(page.getByTestId('camera-orbit')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('camera-walk')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('camera-fly')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('camera-orbit')).toHaveAttribute('aria-pressed', 'true');
  });

  test('flies through a wall that walking cannot pass', async ({ page }) => {
    await roomWithDoor(page, { door: false });
    await page.getByTestId('camera-fly').click();

    await hold(page, 'ArrowUp', 2500);
    await expect(page.getByTestId('walker-room')).toHaveText('Unbounded');
  });

  test('shows the keys for the mode you are in', async ({ page }) => {
    await roomWithDoor(page);
    await expect(page.getByTestId('hud-help')).toContainText('orbit');

    await page.getByTestId('camera-walk').click();
    await expect(page.getByTestId('hud-help')).toContainText('crouch');
  });
});

test.describe('saved views', () => {
  test('bookmarks where you are standing and travels back to it', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();
    await hold(page, 'ArrowUp', 60);

    await page.getByTestId('save-view').click();
    await page.getByLabel('Name for this view').fill('By the door');
    await page.getByTestId('confirm-view').click();

    const bookmark = page.getByRole('button', { name: 'By the door', exact: true });
    await expect(bookmark).toBeVisible();

    // Walk away, then travel back.
    await hold(page, 'ArrowUp', 800);
    const away = await walkerAt(page);
    await bookmark.click();
    await expect(page.getByTestId('walker-readout')).not.toHaveText(away);
  });

  test('carries a saved view into the file and back out', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();
    await hold(page, 'ArrowUp', 60);

    await page.getByTestId('save-view').click();
    await page.getByLabel('Name for this view').fill('Doorway');
    await page.getByTestId('confirm-view').click();

    const download = page.waitForEvent('download');
    await page.getByTestId('save-file').click();
    const file = await download;
    const path = await file.path();

    await page.goto('/');
    await page.getByLabel('Open a .space file').setInputFiles(path);
    await page.getByRole('button', { name: 'Space', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Doorway', exact: true })).toBeVisible();
  });

  test('removes a bookmark', async ({ page }) => {
    await roomWithDoor(page);
    await page.getByTestId('camera-walk').click();
    await hold(page, 'ArrowUp', 60);

    await page.getByTestId('save-view').click();
    await page.getByTestId('confirm-view').click();

    await page.getByRole('button', { name: /^Remove view/ }).click();
    await expect(page.getByTestId('save-view')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Remove view/ })).toHaveCount(0);
  });
});

test.describe('mounts', () => {
  test('hangs a wall-mounted item on the wall it was dropped against', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 5000, y: 4000 });

    await page.getByTestId('add-item').click();
    await page.getByLabel('Item name').fill('Wall shelf');
    await page.getByLabel('Width').fill('900mm');
    await page.getByLabel('Depth').fill('250mm');
    await page.getByLabel('Height').fill('300mm');
    await page.getByLabel('Mount').selectOption('wall');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByRole('button', { name: 'Place', exact: true }).click();
    await clickAt(page, stage, { x: 2500, y: 100 }); // right against the north wall

    const panel = page.getByTestId('placement-properties');
    await expect(panel.getByLabel('Mount')).toHaveValue('wall');
    await expect(panel.getByTestId('placement-elevation')).toBeVisible();
  });

  test('says so when there is no wall to mount on, instead of guessing one', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 5000, y: 4000 });

    await page.getByTestId('add-item').click();
    await page.getByLabel('Item name').fill('Wall shelf');
    await page.getByLabel('Width').fill('900mm');
    await page.getByLabel('Depth').fill('250mm');
    await page.getByLabel('Height').fill('300mm');
    await page.getByLabel('Mount').selectOption('wall');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByRole('button', { name: 'Place', exact: true }).click();
    await clickAt(page, stage, { x: 2500, y: 2000 }); // the middle of the room

    await expect(page.getByTestId('inventory-notice')).toContainText('no wall here');
    await expect(page.getByTestId('placement-properties').getByLabel('Mount')).toHaveValue('floor');
  });
});
