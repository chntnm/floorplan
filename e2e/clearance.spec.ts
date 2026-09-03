import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from './coords';

/**
 * Clearance zones and the walkway probe — PLAN.md §9.3.
 *
 * The screen-to-document mapping comes from `./coords`; nothing here zooms, pans or
 * fits, so it holds throughout.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

/** A 5m × 4m room, whose north wall runs along y = 0. */
async function drawRoom(page: Page) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Room');
  await dragBetween(page, stage, { x: 0, y: 0 }, { x: 5000, y: 4000 });
  await expect(page.getByTestId('count-walls')).toContainText('4');
  return stage;
}

async function addPreset(page: Page, label: string) {
  await page.getByLabel('Add from the preset library').selectOption({ label });
  await expect(page.getByTestId('item-list')).toContainText(label.split(' — ')[1]!);
}

/** Add a preset and drop one at `at`. */
async function placePreset(page: Page, label: string, at: { x: number; y: number }) {
  const stage = page.getByTestId('plan-stage');
  await addPreset(page, label);
  await page
    .getByRole('button', { name: 'Place', exact: true })
    .last()
    .click();
  await clickAt(page, stage, at);
  // The arm is a repeat-drop mode — "click the plan to place it, Esc to stop" — so
  // without this the next click anywhere drops a second one.
  await page.keyboard.press('Escape');
}

test.describe('clearance zones', () => {
  test('reports a bookcase standing in a dresser drawer pull', async ({ page }) => {
    await drawRoom(page);
    // Against the north wall, so the drawers face into the room.
    await placePreset(page, 'Storage — Dresser', { x: 2500, y: 300 });
    await placePreset(page, 'Storage — Bookcase', { x: 2500, y: 900 });

    const issues = page.getByTestId('issue-list');
    await expect(issues).toContainText('blocks the drawer pull clearance in front of Dresser');
  });

  test('stops reporting once the bookcase is somewhere else', async ({ page }) => {
    await drawRoom(page);
    await placePreset(page, 'Storage — Dresser', { x: 2500, y: 300 });
    await placePreset(page, 'Storage — Bookcase', { x: 2500, y: 3500 });

    // Nothing left to report at all, so the list is gone rather than empty.
    await expect(page.getByTestId('no-issues')).toBeVisible();
  });

  test('says nothing about a rug in front of the drawers', async ({ page }) => {
    // A rug is 10mm; you step over it. The threshold is a property of the thing in
    // the way, not of the space, so a taller object in the same spot still reports.
    await drawRoom(page);
    await placePreset(page, 'Storage — Dresser', { x: 2500, y: 300 });
    // Clear of the dresser's own footprint, with its near edge well inside the
    // 900mm the drawers need.
    await placePreset(page, 'Other — Rug (5 x 8 ft)', { x: 2500, y: 1825 });

    await expect(page.getByTestId('no-issues')).toBeVisible();
  });

  test('ships the standard library on the presets that need it', async ({ page }) => {
    // A dishwasher door needs 1200mm; the range beside it is inside that.
    await drawRoom(page);
    await placePreset(page, 'Appliances — Dishwasher', { x: 2500, y: 300 });
    await placePreset(page, 'Appliances — Range', { x: 2500, y: 1000 });

    await expect(page.getByTestId('issue-list')).toContainText('dishwasher door');
  });
});

test.describe('the walkway probe', () => {
  /** Draw a route through the room and finish it with Enter. */
  async function probe(page: Page, points: { x: number; y: number }[]) {
    const stage = page.getByTestId('plan-stage');
    await selectTool(page, 'Walkway');
    for (const p of points) await clickAt(page, stage, p);
    await page.keyboard.press('Enter');
  }

  test('measures the narrowest point along a route', async ({ page }) => {
    await drawRoom(page);
    await probe(page, [
      { x: 500, y: 2000 },
      { x: 4500, y: 2000 },
    ]);

    // A clear 4m room: the gap is the room, wall face to wall face — 4000 less two
    // half-thicknesses of 114 is 3886mm, which reads as 12' 9".
    await expect(page.getByTestId('walkway-readout')).toContainText(`12' 9"`);
    await expect(page.getByTestId('walkway-warning')).toHaveCount(0);
  });

  test('warns when the route pinches below 30 inches', async ({ page }) => {
    await drawRoom(page);
    // A sofa 910 deep centred 700 off the south wall leaves 245mm behind it.
    await placePreset(page, 'Seating — Sofa (3-seat)', { x: 2500, y: 3243 });

    await probe(page, [
      { x: 1000, y: 3800 },
      { x: 4000, y: 3800 },
    ]);

    await expect(page.getByTestId('walkway-warning')).toBeVisible();
    await expect(page.getByTestId('walkway-warning')).toContainText('Narrower than');
  });

  test('re-answers when the furniture moves, because it stores the route not the number', async ({
    page,
  }) => {
    await drawRoom(page);
    await placePreset(page, 'Seating — Sofa (3-seat)', { x: 2500, y: 3243 });
    await probe(page, [
      { x: 1000, y: 3800 },
      { x: 4000, y: 3800 },
    ]);
    await expect(page.getByTestId('walkway-warning')).toBeVisible();

    // Drag the sofa off the route. The probe is derived from the document, so the
    // answer follows without redrawing anything.
    const stage = page.getByTestId('plan-stage');
    await page.getByRole('button', { name: 'Arrange furniture', exact: true }).click();
    await dragBetween(page, stage, { x: 2500, y: 3243 }, { x: 2500, y: 1500 });

    await expect(page.getByTestId('walkway-warning')).toHaveCount(0);
  });

  test('survives a tool change, unlike a measurement', async ({ page }) => {
    // It is a route you work against while moving furniture. Losing it every time
    // you pick up Select would make it useless for the one job it has.
    await drawRoom(page);
    await probe(page, [
      { x: 500, y: 2000 },
      { x: 4500, y: 2000 },
    ]);
    await expect(page.getByTestId('walkway-readout')).toBeVisible();

    await selectTool(page, 'Select');
    await expect(page.getByTestId('walkway-readout')).toBeVisible();
  });

  test('clears on request', async ({ page }) => {
    await drawRoom(page);
    await probe(page, [
      { x: 500, y: 2000 },
      { x: 4500, y: 2000 },
    ]);

    await page.getByTestId('clear-walkway').click();
    await expect(page.getByTestId('walkway-empty')).toBeVisible();
  });

  test('keeps nothing from a single click', async ({ page }) => {
    await drawRoom(page);
    await probe(page, [{ x: 500, y: 2000 }]);

    await expect(page.getByTestId('walkway-empty')).toBeVisible();
  });
});

test.describe('the validation panel', () => {
  test('heads each kind of check and counts the whole list', async ({ page }) => {
    await drawRoom(page);
    await placePreset(page, 'Storage — Dresser', { x: 2500, y: 300 });
    // An armchair is too deep to sit *on* the dresser, so it lands beside it — half
    // inside its footprint and squarely in the space its drawers need.
    await placePreset(page, 'Seating — Armchair', { x: 2500, y: 700 });

    // Two distinct problems with one cause, and the panel says both, under their
    // own headings.
    const issues = page.getByTestId('issue-list');
    await expect(issues).toContainText('Clearance');
    await expect(issues).toContainText('Overlaps');
    await expect(page.getByTestId('issue-summary')).toContainText('issues');
  });
});
