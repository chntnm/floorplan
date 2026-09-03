import { expect, test } from '@playwright/test';
import { clickAt, docToPage, dragBetween, selectTool } from './coords';
import { disableSaveInPlace } from './save';

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
    await expect(page.getByRole('button', { name: 'Wall', exact: true })).toHaveAttribute(
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
    await expect(page.getByRole('button', { name: 'Wall', exact: true })).toBeDisabled();

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
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

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

    // Headless Chromium has File System Access, so the app would open a picker and
    // this would wait for a download that never comes. These round-trip tests are
    // about the container, not about which of the two ways out wrote it — the save
    // paths themselves are covered in `persistence.spec.ts`.
    await disableSaveInPlace(page);

    const downloadPromise = page.waitForEvent('download');
    // Exact: "Save as…" is also a button, and a substring match takes both.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
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
    // Collected rather than just accepted: asserting the count is unchanged proves
    // nothing on its own, since it was already zero — the only thing that could fail
    // it is a dialog left open blocking the page, which reads as a mystery timeout.
    // What this test is actually about is that the app *said something*.
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.accept();
    });

    await page.getByLabel('Open a .space file').setInputFiles({
      name: 'broken.space',
      mimeType: 'application/zip',
      buffer: Buffer.from('this is not a zip'),
    });

    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('not a readable .space container');

    // And the document already open is left exactly as it was.
    await expect(page.getByTestId('count-walls')).toContainText('0');
  });
});
