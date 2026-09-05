import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The 3D canvas, once the renderer has taken its size.
 *
 * Clicking "the middle of the canvas" is two measurements, and both of them start out
 * wrong. A `<canvas>` with no width or height attributes lays out at 300 x 150 until
 * something sizes it, so a bounding box taken on sight describes a rectangle in the
 * corner of the cell rather than the canvas the user sees. And React Three Fiber keeps
 * its *own* record of that size, taken from a ResizeObserver a frame or two later,
 * which is what it divides a pointer offset by to get normalised device coordinates —
 * so a click that is dead centre of the element is off the edge of the frustum until
 * the renderer has caught up, and hits nothing at all.
 *
 * Both were live in `floors.spec.ts` and `space.spec.ts`, and between them they made a
 * raycast test fail about half the time on this machine. Neither is a product bug: the
 * scene, the camera and the click handling are deterministic — eight runs of the
 * failing test produced eight byte-identical canvas screenshots. Only the arithmetic
 * that turned "the middle" into a screen pixel was done against the wrong numbers.
 *
 * The gate is the drawing buffer. `gl.setSize` writes `canvas.width` from the size
 * React Three Fiber has measured, so a buffer at least as wide as the element is proof
 * that the observer has fired and the raycaster is dividing by the right number. It is
 * `>=` rather than `===` because the buffer is multiplied by the device pixel ratio.
 */
export async function spaceCanvas(page: Page): Promise<Locator> {
  const canvas = page.locator('.space__canvas canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      async () =>
        canvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          return c.clientWidth > 0 && c.width >= c.clientWidth;
        }),
      { message: 'the 3D renderer never took the size of its canvas' },
    )
    .toBe(true);
  return canvas;
}

/**
 * Click the middle of the 3D view.
 *
 * Every 3D selection test wants this and none of them wants to own the measurement,
 * which is how the same mistake ended up in three places.
 */
export async function clickSpaceCentre(page: Page): Promise<void> {
  const canvas = await spaceCanvas(page);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
