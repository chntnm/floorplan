/**
 * The 2D viewport transform. See PLAN.md §8.
 *
 * The Konva stage itself is left at identity and every point is converted here
 * instead. That costs a pass over the geometry on each pan, which is nothing at plan
 * scale, and buys three things worth more: stroke widths, text sizes and hit
 * tolerances are all plainly in screen pixels; the screen↔document mapping is one
 * pure function that unit tests and Playwright coordinates can both rely on; and
 * there is exactly one place where a sign or an offset can be wrong.
 *
 * Document space is millimetres, y-down — the same handedness as the screen, so the
 * transform is a uniform scale plus a translation with no flip.
 */

import type { Bounds } from './geometry/polygon';
import type { Vec2 } from './geometry/vec';

/** `scale` is screen pixels per document millimetre. `x`/`y` place document (0,0). */
export type Viewport = {
  scale: number;
  x: number;
  y: number;
};

export type Size = { width: number; height: number };

/** 1mm ≈ 2px — closer than you can usefully work. */
export const MAX_SCALE = 2;
/** 1000mm ≈ 2px — a 500m span, past any residential plan. */
export const MIN_SCALE = 0.002;

/**
 * A fresh document opens here, always.
 *
 * Deliberately not fit-to-content: an empty document has no content to fit, so
 * fitting would pick an arbitrary scale and the screen coordinates an end-to-end
 * test clicks would stop meaning the same document millimetres from run to run.
 *
 * At 0.05, one metre is 50 screen pixels and a 12m apartment spans 600.
 */
export const DEFAULT_SCALE = 0.05;
export const DEFAULT_ORIGIN_PX: Vec2 = { x: 120, y: 100 };

export const DEFAULT_VIEWPORT: Viewport = {
  scale: DEFAULT_SCALE,
  x: DEFAULT_ORIGIN_PX.x,
  y: DEFAULT_ORIGIN_PX.y,
};

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function docToScreen(vp: Viewport, p: Vec2): Vec2 {
  return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

export function screenToDoc(vp: Viewport, p: Vec2): Vec2 {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

/** Convert a screen-pixel tolerance into document millimetres at the current zoom. */
export function pxToMm(vp: Viewport, px: number): number {
  return px / vp.scale;
}

export function mmToPx(vp: Viewport, lengthMm: number): number {
  return lengthMm * vp.scale;
}

/** Flatten a polygon ring to the `[x, y, x, y, …]` array Konva's `Line` expects. */
export function flattenToScreen(vp: Viewport, pts: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (const p of pts) {
    out.push(p.x * vp.scale + vp.x, p.y * vp.scale + vp.y);
  }
  return out;
}

export function panBy(vp: Viewport, dxPx: number, dyPx: number): Viewport {
  return { scale: vp.scale, x: vp.x + dxPx, y: vp.y + dyPx };
}

/**
 * Zoom about a fixed screen point — the document point under the cursor stays under
 * the cursor. Clamping happens before the offset is solved, so a zoom that hits the
 * limit holds the anchor instead of drifting.
 */
export function zoomAt(vp: Viewport, anchorPx: Vec2, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  if (scale === vp.scale) return vp;

  const docPoint = screenToDoc(vp, anchorPx);
  return {
    scale,
    x: anchorPx.x - docPoint.x * scale,
    y: anchorPx.y - docPoint.y * scale,
  };
}

/** The document rectangle currently visible in a viewport of `size` pixels. */
export function visibleBounds(vp: Viewport, size: Size): Bounds {
  const topLeft = screenToDoc(vp, { x: 0, y: 0 });
  const bottomRight = screenToDoc(vp, { x: size.width, y: size.height });
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

/** Frame `bounds` in a viewport of `size` pixels, with a pixel margin. */
export function fitBounds(bounds: Bounds, size: Size, paddingPx = 48): Viewport {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  const availW = Math.max(1, size.width - paddingPx * 2);
  const availH = Math.max(1, size.height - paddingPx * 2);

  // A degenerate extent (one wall, a single point) has no scale to derive.
  const scale = clampScale(w > 0 && h > 0 ? Math.min(availW / w, availH / h) : DEFAULT_SCALE);

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    x: size.width / 2 - cx * scale,
    y: size.height / 2 - cy * scale,
  };
}

// ---------------------------------------------------------------------------
// Adaptive grid
// ---------------------------------------------------------------------------

/**
 * Multipliers on the document's base grid. Drawing a 25mm grid across a whole plan
 * would be tens of thousands of lines, so the step coarsens as you zoom out and the
 * visible line count stays roughly constant.
 */
const GRID_LADDER = [1, 2, 4, 10, 20, 40, 100, 200, 400, 1000, 2000] as const;

/** The finest ladder step whose on-screen spacing is at least `minPx`. */
export function gridStepMm(vp: Viewport, baseMm: number, minPx = 8): number {
  for (const mult of GRID_LADDER) {
    if (baseMm * mult * vp.scale >= minPx) return baseMm * mult;
  }
  return baseMm * GRID_LADDER[GRID_LADDER.length - 1]!;
}

/** Document-space x and y coordinates for grid lines across the visible rect. */
export function gridLines(
  vp: Viewport,
  size: Size,
  stepMm: number,
): { xs: number[]; ys: number[] } {
  const view = visibleBounds(vp, size);
  const xs: number[] = [];
  const ys: number[] = [];

  // A pathological step would otherwise spin here; bail rather than hang the frame.
  if (!(stepMm > 0)) return { xs, ys };

  const firstX = Math.ceil(view.minX / stepMm) * stepMm;
  for (let x = firstX; x <= view.maxX; x += stepMm) xs.push(x);

  const firstY = Math.ceil(view.minY / stepMm) * stepMm;
  for (let y = firstY; y <= view.maxY; y += stepMm) ys.push(y);

  return { xs, ys };
}
