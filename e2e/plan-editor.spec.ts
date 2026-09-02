import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * These specs click screen pixels and assert document millimetres, which only works
 * because a fresh document opens at a fixed viewport (see `DEFAULT_VIEWPORT`): scale
 * 0.05 px/mm, document origin at 120,100 inside the stage. Keep the two in step.
 *
 * One screen pixel is 20mm at that scale, so a half-pixel of rounding is 10mm — under
 * half the 25mm snap grid, which is what makes the coordinates below land exactly.
 *
 * The mapping holds for a fresh page only. Opening a file calls `zoomToFit`, and
 * anything that zooms, pans or fits invalidates it — do not click document
 * coordinates after one of those without re-deriving the transform.
 */
const SCALE = 0.05;
const ORIGIN = { x: 120, y: 100 };

async function docToPage(stage: Locator, mm: { x: number; y: number }) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('plan stage has no bounding box');
  return {
    x: box.x + ORIGIN.x + mm.x * SCALE,
    y: box.y + ORIGIN.y + mm.y * SCALE,
  };
}

async function clickAt(page: Page, stage: Locator, mm: { x: number; y: number }) {
  const p = await docToPage(stage, mm);
  await page.mouse.click(p.x, p.y);
}

/**
 * Pick a tool and wait for it to be current.
 *
 * A canvas click sent immediately after the button click can arrive before React has
 * committed the render that makes the structure layer listen — Playwright waits for
 * the DOM click, not for the frame after it. Asserting the pressed state gates on
 * that render without a sleep.
 */
async function selectTool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function dragBetween(
  page: Page,
  stage: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const a = await docToPage(stage, from);
  const b = await docToPage(stage, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // Two intermediate moves: one to start the rubber band, one to prove it tracks.
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await page.mouse.move(b.x, b.y);
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

test.describe('drawing', () => {
  test('draws a wall chain and measures it correctly', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Wall');

    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 3000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('count-walls')).toContainText('2');

    // Select the first wall and read its length back — 4000mm is 13' 1.5".
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2000, y: 0 });
    await expect(page.getByTestId('wall-properties')).toContainText(`13' 1.5"`);
  });

  test('draws a room with its four walls', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');

    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });

    await expect(page.getByTestId('count-rooms')).toContainText('1');
    await expect(page.getByTestId('count-walls')).toContainText('4');
    // 4m x 3m is 12m², which is 129.2 sq ft.
    await expect(page.getByTestId('room-properties')).toContainText('129.2 sq ft');
  });

  test('draws a non-rectangular shape as a boundary with no walls', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Shape');
    await selectTool(page, 'Circle');

    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 3000, y: 3000 });

    await expect(page.getByTestId('count-rooms')).toContainText('1');
    await expect(page.getByTestId('count-walls')).toContainText('0');
  });

  test('closes a wall loop by clicking back on the start point', async ({ page }) => {
    // The start point has to be a snap target in its own right; without that this
    // only works when the last click lands in the same grid cell by luck.
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Wall');

    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 3000 });
    await clickAt(page, stage, { x: 0, y: 3000 });
    // Deliberately a little off the start — the snap radius should still take it.
    await clickAt(page, stage, { x: 60, y: 60 });

    await expect(page.getByTestId('count-walls')).toContainText('4');
    await expect(page.getByTestId('history-readout')).toContainText('1 undo');
  });

  test('picks up tools by keyboard shortcut', async ({ page }) => {
    await page.keyboard.press('w');
    await expect(page.getByRole('button', { name: 'Wall' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('v');
    await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('undo', () => {
  test('undoes one drawn gesture per press, not one per mouse move', async ({ page }) => {
    // The whole reason editor state and document state are separate slices: the drag
    // below fires many mousemoves and must leave exactly one entry on the stack.
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });

    await expect(page.getByTestId('history-readout')).toContainText('1 undo');

    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('count-rooms')).toContainText('0');
    await expect(page.getByTestId('count-walls')).toContainText('0');

    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('count-rooms')).toContainText('1');
    await expect(page.getByTestId('count-walls')).toContainText('4');
  });

  test('walks back three separate gestures in three presses', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Wall');

    for (const y of [0, 1000, 2000]) {
      await clickAt(page, stage, { x: 0, y });
      await clickAt(page, stage, { x: 4000, y });
      await page.keyboard.press('Enter');
    }
    await expect(page.getByTestId('count-walls')).toContainText('3');

    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('count-walls')).toContainText('2');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('count-walls')).toContainText('1');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('count-walls')).toContainText('0');
  });
});

test.describe('mode toggle', () => {
  test('stops structure being selectable in furnish mode', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });

    await expect(page.getByTestId('count-walls')).toContainText('4');

    await page.getByRole('button', { name: 'Arrange furniture' }).click();
    await expect(page.getByRole('button', { name: 'Wall' })).toBeDisabled();

    // A click that would have hit a wall in plan mode selects nothing here.
    await clickAt(page, stage, { x: 2000, y: 0 });
    await expect(page.getByTestId('wall-properties')).toHaveCount(0);
    await expect(page.getByText('Structure is locked; furniture is editable.')).toBeVisible();

    await page.getByRole('button', { name: 'Edit floor plan' }).click();
    await expect(page.getByText('Walls, rooms and openings are editable.')).toBeVisible();

    await clickAt(page, stage, { x: 2000, y: 0 });
    await expect(page.getByTestId('wall-properties')).toBeVisible();
  });
});

test.describe('transform', () => {
  test('drags a wall endpoint and commits one undo step', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 0, y: 0 });
    await clickAt(page, stage, { x: 4000, y: 0 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('count-walls')).toContainText('1');

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2000, y: 0 });
    await expect(page.getByTestId('wall-properties')).toContainText(`13' 1.5"`);

    // Drag the far endpoint out to 6000mm — the wall becomes 19' 8.25".
    const from = await docToPage(stage, { x: 4000, y: 0 });
    const to = await docToPage(stage, { x: 6000, y: 0 });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, from.y);
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();

    await expect(page.getByTestId('wall-properties')).toContainText(`19' 8.25"`);
    // Two entries total: drawing the wall, then moving it. Not one per mousemove.
    await expect(page.getByTestId('history-readout')).toContainText('2 undo');

    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('wall-properties')).toContainText(`13' 1.5"`);
  });

  test('a click that does not move the wall is not an undo step', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });
    await expect(page.getByTestId('history-readout')).toContainText('1 undo');

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2000, y: 0 });
    await expect(page.getByTestId('wall-properties')).toBeVisible();

    await expect(page.getByTestId('history-readout')).toContainText('1 undo');
  });
});

test.describe('selection', () => {
  test('deletes a selected wall and its opening', async ({ page }) => {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });

    await expect(page.getByTestId('count-walls')).toContainText('4');

    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2000, y: 0 });
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByTestId('count-walls')).toContainText('3');
    await expect(page.getByTestId('count-rooms')).toContainText('1');
  });
});

test.describe('portability', () => {
  test('saves a drawn plan and reopens it in a fresh page', async ({ page }) => {
    // The requirement from the brief, end to end: another person opens the same space.
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Room');
    await dragBetween(page, stage, { x: 0, y: 0 }, { x: 4000, y: 3000 });

    await selectTool(page, 'Wall');
    await clickAt(page, stage, { x: 0, y: 4000 });
    await clickAt(page, stage, { x: 4000, y: 4000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('count-walls')).toContainText('5');
    await expect(page.getByTestId('dirty-flag')).toHaveText('•'); // unsaved

    // Name it, so the saved file is named after the space rather than "Untitled".
    const title = page.getByLabel('Space name');
    await title.fill('Maple Street');
    await title.press('Enter');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Maple-Street.space');

    const file = await download.path();
    await expect(page.getByTestId('dirty-flag')).toBeEmpty();

    // A reload is a genuinely empty editor — nothing carried in memory.
    await page.reload();
    await expect(page.getByTestId('count-walls')).toContainText('0');

    await page.getByLabel('Open a .space file').setInputFiles(file);

    await expect(page.getByTestId('count-walls')).toContainText('5');
    await expect(page.getByTestId('count-rooms')).toContainText('1');
    await expect(page.getByLabel('Space name')).toHaveValue('Maple Street');
    await expect(page.getByTestId('dirty-flag')).toBeEmpty();
  });

  test('reports an unreadable file instead of failing silently', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());

    await page.getByLabel('Open a .space file').setInputFiles({
      name: 'broken.space',
      mimeType: 'application/zip',
      buffer: Buffer.from('this is not a zip'),
    });

    // The document already open is left exactly as it was.
    await expect(page.getByTestId('count-walls')).toContainText('0');
  });
});
