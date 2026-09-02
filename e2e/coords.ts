import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The screen-to-document contract every canvas spec depends on.
 *
 * These specs click screen pixels and assert document millimetres, which only works
 * because a fresh document opens at a fixed viewport (see `DEFAULT_VIEWPORT`): scale
 * 0.05 px/mm, document origin at 120,100 inside the stage. Keep the two in step.
 *
 * One screen pixel is 20mm at that scale, so a half-pixel of rounding is 10mm — under
 * half the 25mm snap grid, which is what makes the coordinates in the specs land
 * exactly.
 *
 * The mapping holds for a fresh page only. Opening a file calls `zoomToFit`, and
 * anything that zooms, pans or fits invalidates it — do not click document
 * coordinates after one of those without re-deriving the transform. Importing a plan
 * deliberately does *not* re-fit, so the mapping survives an import.
 *
 * It lives here rather than in one spec because two files need it: when
 * `DEFAULT_SCALE` or `DEFAULT_ORIGIN_PX` moves, a second copy would go stale and fail
 * in a way that looks exactly like a product bug.
 */
export const SCALE = 0.05;
export const ORIGIN = { x: 120, y: 100 };

export async function docToPage(stage: Locator, mm: { x: number; y: number }) {
  const box = await stage.boundingBox();
  if (!box) throw new Error('plan stage has no bounding box');
  return {
    x: box.x + ORIGIN.x + mm.x * SCALE,
    y: box.y + ORIGIN.y + mm.y * SCALE,
  };
}

export async function clickAt(page: Page, stage: Locator, mm: { x: number; y: number }) {
  const p = await docToPage(stage, mm);
  await page.mouse.click(p.x, p.y);
}

/**
 * Pick a tool and wait for it to be current.
 *
 * A canvas click sent immediately after the button click can arrive before React has
 * committed the render that arms the tool — Playwright waits for the DOM click, not
 * for the frame after it. Asserting the pressed state gates on that render without a
 * sleep.
 */
export async function selectTool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

export async function dragBetween(
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
