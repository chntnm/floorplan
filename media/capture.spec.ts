import { expect, test, type Page } from '@playwright/test';
import { clickAt, dragBetween, selectTool } from '../e2e/coords';
import { clip, resetWork, still } from './shoot';
import { samplePlanPng } from './sample-plan';

/**
 * Every image in the README, drawn by driving the real application.
 *
 * Run with `pnpm media`. Generated rather than hand-taken because a screenshot of
 * a feature that has since changed is a lie the repository tells silently — this
 * way the pictures are re-derivable, and a capture that can no longer be driven
 * fails instead of quietly going stale.
 *
 * Gestures come from `e2e/coords.ts`, so the screen-to-document mapping is the one
 * the test suite depends on: **place all geometry before anything zooms, pans or
 * fits**, because Fit invalidates the mapping. Framing is always the last thing
 * that happens before a shutter.
 *
 * Each capture asserts the state it is photographing — the walker ends in the
 * bedroom, the clearance issue is listed — so a shot of the wrong thing fails
 * rather than being committed.
 */

test.beforeAll(() => resetWork());

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('plan-stage')).toBeVisible();
});

/** Both side panels scroll. A shot of one mid-scroll looks like a rendering bug. */
async function scrollPanels(page: Page) {
  await page.locator('.panel--left').evaluate((el) => el.scrollTo(0, 0));
  await page.locator('.panel--right').evaluate((el) => el.scrollTo(0, 0));
}

async function addPreset(page: Page, label: string) {
  await page.getByLabel('Add from the preset library').selectOption({ label });
  await expect(page.getByTestId('item-list')).toContainText(label.split(' — ')[1]!);
}

/** Add a preset and drop one at `at`, in document millimetres. */
async function place(page: Page, label: string, at: { x: number; y: number }) {
  const stage = page.getByTestId('plan-stage');
  await addPreset(page, label);
  await page.getByRole('button', { name: 'Place', exact: true }).last().click();
  await clickAt(page, stage, at);
  await page.keyboard.press('Escape');
}

async function nameRoom(page: Page, at: { x: number; y: number }, name: string) {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Select');
  await clickAt(page, stage, at);
  const field = page.getByTestId('room-properties').getByRole('textbox').first();
  await field.fill(name);
  await field.press('Enter');
}

/**
 * A 9m × 6m flat: a wall shell, a partition, four openings, and enough furniture
 * for the space view to be worth walking.
 *
 * Drawn as walls and then *detected* into rooms rather than traced with the Room
 * tool, because that is the path phase 8 exists for and it exercises the two
 * T-junctions where the partition meets the shell.
 *
 * The interior door sits on y = 3000 on purpose. The walker seeds at the centre of
 * the largest room facing east, so that line is the one along which a scripted
 * clip can hold one key and end up in the next room — and the layout keeps it
 * clear of everything but the rug, which is 10mm tall and meant to be walked over.
 */
async function apartment(page: Page) {
  const stage = page.getByTestId('plan-stage');

  await selectTool(page, 'Wall');
  await clickAt(page, stage, { x: 0, y: 0 });
  await clickAt(page, stage, { x: 9000, y: 0 });
  await clickAt(page, stage, { x: 9000, y: 6000 });
  await clickAt(page, stage, { x: 0, y: 6000 });
  await clickAt(page, stage, { x: 0, y: 0 });
  await expect(page.getByTestId('count-walls')).toContainText('4');

  await selectTool(page, 'Wall');
  await clickAt(page, stage, { x: 5400, y: 0 });
  await clickAt(page, stage, { x: 5400, y: 6000 });
  await page.keyboard.press('Enter');

  await page.getByTestId('detect-rooms').click();
  await expect(page.getByTestId('count-rooms')).toContainText('2');

  await nameRoom(page, { x: 2700, y: 3000 }, 'Living room');
  await nameRoom(page, { x: 7200, y: 3000 }, 'Bedroom');

  await selectTool(page, 'Opening');
  await clickAt(page, stage, { x: 2000, y: 0 }); // front door
  await clickAt(page, stage, { x: 5400, y: 3000 }); // through the partition
  await selectTool(page, 'Window');
  await clickAt(page, stage, { x: 3600, y: 6000 });
  await clickAt(page, stage, { x: 9000, y: 2200 });
  await expect(page.getByTestId('count-openings')).toContainText('4');

  // The rug goes down before the coffee table. A rug is 10mm and the table stands
  // 380mm clear underneath, so this is the case the vertical axis exists for — and
  // it only reads as that case if the rug is under something.
  await place(page, 'Other — Rug (5 x 8 ft)', { x: 2200, y: 3700 });
  await place(page, 'Tables — Coffee table', { x: 2200, y: 3700 });
  await place(page, 'Seating — Sofa (3-seat)', { x: 2200, y: 5600 });
  await place(page, 'Storage — TV stand', { x: 4400, y: 300 });
  await place(page, 'Storage — Bookcase', { x: 400, y: 1400 });
  await place(page, 'Tables — Dining table (6)', { x: 1800, y: 1400 });

  await place(page, 'Beds — Queen bed', { x: 7400, y: 1200 });
  await place(page, 'Beds — Nightstand', { x: 6200, y: 400 });
  await place(page, 'Storage — Wardrobe', { x: 8600, y: 4400 });
  await place(page, 'Other — Floor lamp', { x: 6000, y: 5200 });

  await expect(page.getByTestId('count-placements')).toContainText('10');
}

test('the plan editor, and the same document in 3D', async ({ page }) => {
  await apartment(page);

  await page.getByRole('button', { name: 'Edit floor plan', exact: true }).click();
  await selectTool(page, 'Select');
  await page.keyboard.press('Escape');
  // Nothing below here may use the fixed mapping again.
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(400);
  await scrollPanels(page);
  await still(page, 'plan');

  await page.getByRole('button', { name: 'Space', exact: true }).click();
  await expect(page.getByTestId('space-view')).toBeVisible();
  await page.waitForTimeout(2500);

  // Orbit frames the whole document, which puts a 9m flat in the middle third of
  // the canvas. Zoom in on it.
  const canvas = page.getByTestId('space-view');
  const box = (await canvas.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
  }
  // Orbit up a little: from the default elevation the near wall hides most of
  // what is behind it.
  await page.mouse.down();
  await page.mouse.move(centre.x, centre.y - 55, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await scrollPanels(page);
  await still(page, 'space');

});

/**
 * The walkthrough clip, captured at deviceScaleFactor 1.
 *
 * The stills are shot at 2 and downscaled, which is what keeps their text crisp.
 * A clip cannot afford it: the GIF is 900px wide either way, so the second pixel
 * is thrown away, and encoding it costs about 190ms a frame — over the walk
 * loop's own MAX_STEP_SECONDS, which makes the recording jerky. At 1 the frames
 * are cheap enough to be a walk.
 *
 * The apartment is therefore drawn twice, in two contexts. That is the price of
 * the density difference and it is only paid by this script.
 */
test.describe('walking through it', () => {
  test.use({ deviceScaleFactor: 1 });

  test('out of the living room and into the bedroom', async ({ page }) => {
    await apartment(page);

    await page.getByRole('button', { name: 'Space', exact: true }).click();
    await expect(page.getByTestId('space-view')).toBeVisible();
    await page.waitForTimeout(2500);

    const canvas = page.getByTestId('space-view');
    await page.getByTestId('camera-walk').click();
    await page.waitForTimeout(600);
    await expect(page.getByTestId('walker-room')).toHaveText('Living room');

    // The walker is seeded at the centre of the living room facing north. Look 90°
    // right — 409px at LOOK_SENSITIVITY — and the interior doorway is straight
    // ahead down the y = 3000 line.
    await clip(page, 'walk', canvas, [
      { hold: [], ms: 300 },
      { look: { dx: 409 }, steps: 12 },
      {
        hold: ['ArrowUp'],
        ms: 3000,
        // The point of the clip, asserted where it is true rather than at the end,
        // because the look-around that follows turns the walker back around.
        after: () => expect(page.getByTestId('walker-room')).toHaveText('Bedroom'),
      },
      { look: { dx: -240 }, steps: 8 },
    ]);
  });
});

test('a clearance zone the furniture is standing in', async ({ page }) => {
  const stage = page.getByTestId('plan-stage');
  await selectTool(page, 'Room');
  await dragBetween(page, stage, { x: 0, y: 0 }, { x: 3200, y: 2400 });

  // A dresser against the north wall needs 900mm in front of it for the drawers.
  // The bookcase is standing in it.
  await place(page, 'Storage — Dresser', { x: 1600, y: 300 });
  await place(page, 'Storage — Bookcase', { x: 1600, y: 1000 });
  await expect(page.getByTestId('issue-list')).toContainText('drawer pull');

  // Select the *dresser*, not the bookcase in its way: zones are drawn on the
  // selection only, and the dresser is the one that owns this zone. The hatched
  // rectangle is the evidence for the sentence in the panel.
  await clickAt(page, stage, { x: 1600, y: 300 });
  await expect(page.getByTestId('placement-properties')).toBeVisible();

  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator('.panel--left').evaluate((el) => el.scrollTo(0, 0));
  await page.getByTestId('issue-list').scrollIntoViewIfNeeded();
  await still(page, 'clearance');
});

test('the calibration gate, before a scale exists', async ({ page }) => {
  await page.getByTestId('import-input').setInputFiles({
    name: 'ground-floor.png',
    mimeType: 'image/png',
    buffer: await samplePlanPng(page),
  });
  await expect(page.getByTestId('calibration-gate')).toBeVisible();

  // An uncalibrated background is shown at a nominal 6m width, which at the
  // default zoom is a postage stamp. Import deliberately does not re-fit the
  // viewport, and Fit would not help anyway — the background is excluded from
  // `floorBounds` — so zoom on it by hand, the way you would.
  const stage = page.getByTestId('plan-stage');
  const box = (await stage.boundingBox())!;
  const onPlan = { x: box.x + 270, y: box.y + 340 };
  await page.mouse.move(onPlan.x, onPlan.y);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(400);
  await scrollPanels(page);
  await still(page, 'calibrate');
});

test('what a product page claimed, before it is believed', async ({ page }) => {
  // Tall enough that the confirmation form fits without scrolling — the whole
  // point of the shot is the evidence line above the fields and the fields below
  // it in one frame.
  await page.setViewportSize({ width: 1440, height: 1280 });

  // The endpoint is a serverless function and is not in the static build, so the
  // response is stubbed here the same way `e2e/product-url.spec.ts` stubs it, and
  // for the same reason. The dialog, the parse and the confidence flag are real.
  await page.evaluate(() => {
    window.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            url: 'https://shop.example.com/p/harlow-sofa',
            draft: {
              name: 'Harlow Sofa',
              widthMm: 2134,
              depthMm: 965,
              heightMm: 813,
              confidence: 'labelled',
              rawSnippet: 'Width: 84 in · Depth: 38 in · Height: 32 in',
              dimensionSource: 'json-ld',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
  });

  await page.getByTestId('add-from-url').click();
  await page.getByTestId('lookup-url-input').fill('https://shop.example.com/p/harlow-sofa');
  await page.getByTestId('lookup-go').click();
  await expect(page.getByTestId('lookup-confirm')).toBeVisible();

  // From the evidence line down to the last scraped dimension. The rest of the
  // form is the ordinary manual-entry form and says nothing about the lookup.
  const panel = (await page.locator('.panel--left').boundingBox())!;
  const top = (await page.getByTestId('lookup-confirm').boundingBox())!;
  const last = (await page.getByLabel('Height').boundingBox())!;
  await still(page, 'lookup', {
    x: panel.x,
    y: top.y - 2,
    width: panel.width,
    height: last.y + last.height + 34 - (top.y - 2),
  });
});
