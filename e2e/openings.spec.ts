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

test.describe('hanging the leaf', () => {
  /** A room with a door in the middle of its north wall, left selected. */
  async function roomWithDoor(page: Page) {
    const stage = await room(page);
    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await expect(page.getByTestId('opening-swing')).toBeVisible();
    return stage;
  }

  /** Put a chest of drawers in the middle of the room, 400mm off the north wall. */
  async function dresser(page: Page, stage: ReturnType<Page['getByTestId']>) {
    await page.getByTestId('add-item').click();
    // Scoped to the form: the selected door's panel has a Width field too.
    const form = page.getByTestId('item-form');
    await form.getByLabel('Item name').fill('Dresser');
    await form.getByLabel('Width').fill('1500mm');
    await form.getByLabel('Depth').fill('500mm');
    await form.getByLabel('Height').fill('810mm');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Place', exact: true }).click();
    await clickAt(page, stage, { x: 2500, y: 400 });
  }

  test('hangs a new door the ordinary way, with a swing to edit', async ({ page }) => {
    await roomWithDoor(page);

    const panel = page.getByTestId('opening-properties');
    await expect(panel).toContainText('Hinged');
    await expect(panel).toContainText('at wall start');
    await expect(page.getByTestId('swing-angle')).toHaveValue('90');
  });

  test('flips the hinge to the other jamb', async ({ page }) => {
    await roomWithDoor(page);

    await page.getByTestId('flip-hinge').click();
    await expect(page.getByTestId('opening-properties')).toContainText('at wall end');

    // One undo step, like every other edit.
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('opening-properties')).toContainText('at wall start');
  });

  test('takes an angle typed a digit at a time', async ({ page }) => {
    // Typed rather than filled. The stored angle is clamped at 15, so a field that
    // wrote per keystroke would turn the `1` of `135` into `15` and swallow the rest
    // — and `fill` is the one input path that never notices, because it delivers the
    // whole value in a single change event.
    await roomWithDoor(page);

    const angle = page.getByTestId('swing-angle');
    await angle.selectText();
    await angle.pressSequentially('135');
    await angle.press('Enter');
    await expect(angle).toHaveValue('135');

    // And one undo step for the whole edit, not one per character.
    await page.keyboard.press('Control+z');
    await expect(angle).toHaveValue('90');
  });

  test('clamps an angle no door could open to', async ({ page }) => {
    await roomWithDoor(page);

    const angle = page.getByTestId('swing-angle');
    await angle.fill('500');
    await angle.press('Enter');
    await expect(angle).toHaveValue('180');
  });

  test('reports furniture standing in the swing, and stops once the door is turned around', async ({
    page,
  }) => {
    const stage = await roomWithDoor(page);
    await dresser(page, stage);

    await expect(page.getByTestId('issue-list')).toContainText('cannot open fully');
    await expect(page.getByTestId('issue-list')).toContainText('Dresser');

    // Hang the door to open the other way and the dresser is no longer in it.
    await page.getByRole('button', { name: 'Edit floor plan', exact: true }).click();
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await page.getByTestId('flip-side').click();

    // Nothing left to report at all, so the list is gone rather than empty.
    await expect(page.getByTestId('no-issues')).toBeVisible();
  });

  test('asks nothing of the room once the door slides into the wall', async ({ page }) => {
    // The whole argument for a pocket door: the leaf goes inside the wall, so the
    // dresser beside it stops being a problem without moving anything.
    const stage = await roomWithDoor(page);
    await dresser(page, stage);
    await expect(page.getByTestId('issue-list')).toContainText('cannot open fully');

    await page.getByRole('button', { name: 'Edit floor plan', exact: true }).click();
    await selectTool(page, 'Select');
    await clickAt(page, stage, { x: 2500, y: 0 });
    await page.getByLabel('Opening kind').selectOption('pocket');

    await expect(page.getByTestId('no-issues')).toBeVisible();
    await expect(page.getByTestId('swing-angle')).toHaveCount(0); // nothing to swing
  });

  test('reports a pocket door with no wall to slide into', async ({ page }) => {
    const stage = await room(page);
    await selectTool(page, 'Opening');
    await clickAt(page, stage, { x: 400, y: 0 }); // hard against the corner

    await page.getByLabel('Opening kind').selectOption('pocket');
    await expect(page.getByTestId('issue-list')).toContainText('to slide into');
  });

  test('offers no swing at all on a cased opening, and gives it back on the way out', async ({
    page,
  }) => {
    await roomWithDoor(page);
    await page.getByTestId('flip-hinge').click();

    await page.getByLabel('Opening kind').selectOption('cased');
    await expect(page.getByTestId('opening-swing')).toHaveCount(0);
    await expect(page.getByTestId('opening-properties')).toContainText('No leaf');

    // The hinge you chose survives the round trip — the document keeps the field
    // even while the kind does not read it.
    await page.getByLabel('Opening kind').selectOption('door');
    await expect(page.getByTestId('opening-properties')).toContainText('at wall end');
  });
});
