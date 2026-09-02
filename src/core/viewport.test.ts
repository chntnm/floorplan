import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCALE,
  DEFAULT_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  docToScreen,
  fitBounds,
  flattenToScreen,
  gridLines,
  gridStepMm,
  mmToPx,
  panBy,
  pxToMm,
  screenToDoc,
  visibleBounds,
  zoomAt,
  type Viewport,
} from './viewport';

const vp: Viewport = { scale: 0.05, x: 120, y: 100 };

describe('docToScreen / screenToDoc', () => {
  it('places the document origin at the viewport offset', () => {
    expect(docToScreen(vp, { x: 0, y: 0 })).toEqual({ x: 120, y: 100 });
  });

  it('scales millimetres to pixels without flipping y', () => {
    // Document space is y-down, like the screen — a wall running "down" the plan
    // must not appear running up it.
    expect(docToScreen(vp, { x: 1000, y: 2000 })).toEqual({ x: 170, y: 200 });
  });

  it('round-trips', () => {
    const p = { x: 3456.25, y: -789.5 };
    const back = screenToDoc(vp, docToScreen(vp, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('round-trips at both scale limits', () => {
    for (const scale of [MIN_SCALE, MAX_SCALE]) {
      const v = { scale, x: 40, y: 40 };
      const p = { x: 12345, y: 6789 };
      const back = screenToDoc(v, docToScreen(v, p));
      expect(back.x).toBeCloseTo(p.x, 3);
      expect(back.y).toBeCloseTo(p.y, 3);
    }
  });

  it('flattens a ring for Konva in one pass', () => {
    expect(
      flattenToScreen(vp, [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ]),
    ).toEqual([120, 100, 170, 100]);
  });
});

describe('the default viewport', () => {
  it('is a fixed scale and offset, not fit-to-content', () => {
    // An end-to-end test clicks screen pixels and asserts document millimetres. If a
    // fresh document fitted its (empty) content, that mapping would change per run.
    expect(DEFAULT_VIEWPORT.scale).toBe(DEFAULT_SCALE);
    expect(screenToDoc(DEFAULT_VIEWPORT, { x: 120, y: 100 })).toEqual({ x: 0, y: 0 });
  });

  it('puts one metre at fifty pixels', () => {
    expect(mmToPx(DEFAULT_VIEWPORT, 1000)).toBe(50);
    expect(pxToMm(DEFAULT_VIEWPORT, 50)).toBe(1000);
  });
});

describe('zoomAt', () => {
  it('keeps the document point under the cursor fixed', () => {
    const anchor = { x: 400, y: 300 };
    const before = screenToDoc(vp, anchor);
    const after = screenToDoc(zoomAt(vp, anchor, 1.5), anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps and then holds the anchor rather than drifting', () => {
    const anchor = { x: 400, y: 300 };
    const zoomed = zoomAt({ scale: MAX_SCALE, x: 0, y: 0 }, anchor, 4);
    expect(zoomed.scale).toBe(MAX_SCALE);
    // Refusing the zoom must not move the view sideways.
    expect(zoomed).toEqual({ scale: MAX_SCALE, x: 0, y: 0 });
  });

  it('clamps in both directions', () => {
    expect(clampScale(1e6)).toBe(MAX_SCALE);
    expect(clampScale(1e-9)).toBe(MIN_SCALE);
  });
});

describe('panBy', () => {
  it('translates in pixels and leaves the scale alone', () => {
    expect(panBy(vp, 25, -10)).toEqual({ scale: 0.05, x: 145, y: 90 });
  });
});

describe('visibleBounds', () => {
  it('reports the document rectangle on screen', () => {
    const b = visibleBounds(vp, { width: 800, height: 600 });
    expect(b.minX).toBeCloseTo(-2400);
    expect(b.minY).toBeCloseTo(-2000);
    expect(b.maxX).toBeCloseTo(13600);
    expect(b.maxY).toBeCloseTo(10000);
  });
});

describe('fitBounds', () => {
  it('centres the extent in the viewport', () => {
    const box = { minX: 0, minY: 0, maxX: 10000, maxY: 8000 };
    const size = { width: 900, height: 700 };
    const fitted = fitBounds(box, size, 50);

    const centre = docToScreen(fitted, { x: 5000, y: 4000 });
    expect(centre.x).toBeCloseTo(450, 6);
    expect(centre.y).toBeCloseTo(350, 6);
  });

  it('fits the constraining axis with room for the padding', () => {
    // Wide and short: width is the binding constraint.
    const box = { minX: 0, minY: 0, maxX: 20000, maxY: 1000 };
    const fitted = fitBounds(box, { width: 800, height: 800 }, 40);
    expect(mmToPx(fitted, 20000)).toBeLessThanOrEqual(800 - 80 + 1e-9);
  });

  it('falls back to the default scale for a degenerate extent', () => {
    // A single wall drawn along one axis has zero height; there is no scale to derive.
    const fitted = fitBounds({ minX: 0, minY: 500, maxX: 5000, maxY: 500 }, {
      width: 800,
      height: 600,
    });
    expect(fitted.scale).toBe(DEFAULT_SCALE);
  });
});

describe('adaptive grid', () => {
  it('uses the base step when it is comfortably visible', () => {
    expect(gridStepMm({ scale: 1, x: 0, y: 0 }, 25, 10)).toBe(25);
  });

  it('coarsens as the view zooms out', () => {
    const far = gridStepMm({ scale: 0.005, x: 0, y: 0 }, 25, 10);
    const near = gridStepMm({ scale: 0.5, x: 0, y: 0 }, 25, 10);
    expect(far).toBeGreaterThan(near);
    expect(far * 0.005).toBeGreaterThanOrEqual(10);
  });

  it('keeps the visible line count bounded at any zoom', () => {
    // The point of the ladder: at 25mm fixed step a zoomed-out plan would be tens of
    // thousands of lines. Sweeping the whole scale range must never exceed a few
    // hundred in either axis.
    const size = { width: 1600, height: 1200 };
    for (let scale = MIN_SCALE; scale <= MAX_SCALE; scale *= 1.7) {
      const v = { scale, x: 0, y: 0 };
      const { xs, ys } = gridLines(v, size, gridStepMm(v, 25, 10));
      expect(xs.length).toBeLessThan(300);
      expect(ys.length).toBeLessThan(300);
    }
  });

  it('emits lines only across the visible rect, aligned to the step', () => {
    const { xs, ys } = gridLines(vp, { width: 800, height: 600 }, 1000);
    expect(xs[0]).toBe(-2000);
    expect(xs.every((x) => x % 1000 === 0)).toBe(true);
    expect(ys.every((y) => y % 1000 === 0)).toBe(true);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(13600);
  });

  it('returns nothing rather than looping forever on a zero step', () => {
    expect(gridLines(vp, { width: 800, height: 600 }, 0)).toEqual({ xs: [], ys: [] });
  });
});
