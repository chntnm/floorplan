/**
 * Snapping. See PLAN.md §9.1.
 *
 * Pure functions over document millimetres — no Konva, no store. The caller converts
 * a pixel tolerance to millimetres through the viewport and passes the candidate
 * points; what comes back is a point plus the hints the draft layer draws as guides.
 *
 * Precedence, strongest first:
 *
 *   1. **Existing points** — an endpoint you are clearly aiming at wins outright.
 *      Closing a wall chain on its own start has to be exact, not nearly exact.
 *   2. **Angle constraint** — with an anchor, the cursor projects onto the nearest
 *      15° ray, and the distance along that ray then snaps to the grid so wall
 *      lengths come out round.
 *   3. **Grid**.
 *
 * Holding Alt suppresses all of it (`suppressed`), which is the escape hatch for the
 * one time in ten you genuinely mean 1847mm.
 */

import { distance, type Vec2 } from './geometry/vec';

export type SnapHint =
  /** Landed on an existing vertex — draw a marker there. */
  | { kind: 'point'; at: Vec2 }
  /** Constrained to a ray from the anchor — draw the ray. */
  | { kind: 'angle'; from: Vec2; degrees: number }
  | { kind: 'grid'; stepMm: number };

export type SnapResult = {
  point: Vec2;
  hints: SnapHint[];
};

export type SnapContext = {
  gridMm: number;
  gridEnabled: boolean;
  /** Vertices worth snapping to: wall ends, room corners. */
  points: readonly Vec2[];
  /** Snap radius in document mm — normally `pxToMm(viewport, 10)`. */
  toleranceMm: number;
  /** The previous point of a chain, when one exists. Enables the angle constraint. */
  anchor?: Vec2;
  /** Rotation step in degrees; 0 disables the angle constraint. */
  angleStepDeg: number;
  /** Alt held. */
  suppressed: boolean;
};

export const DEFAULT_ANGLE_STEP_DEG = 15;
export const DEFAULT_SNAP_TOLERANCE_PX = 10;

export function snapToGrid(p: Vec2, gridMm: number): Vec2 {
  if (!(gridMm > 0)) return p;
  return {
    x: Math.round(p.x / gridMm) * gridMm,
    y: Math.round(p.y / gridMm) * gridMm,
  };
}

/** The nearest candidate within `toleranceMm`, or null. */
export function nearestPoint(
  p: Vec2,
  candidates: readonly Vec2[],
  toleranceMm: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = toleranceMm;
  for (const c of candidates) {
    const d = distance(p, c);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Round an angle in degrees to the nearest multiple of `stepDeg`. */
export function snapAngle(degrees: number, stepDeg: number): number {
  if (!(stepDeg > 0)) return degrees;
  return Math.round(degrees / stepDeg) * stepDeg;
}

/**
 * Project `p` onto the nearest ray of `stepDeg` from `anchor`, keeping the distance
 * the cursor is at (optionally rounded to `roundLengthTo`).
 */
export function constrainToAngle(
  anchor: Vec2,
  p: Vec2,
  stepDeg: number,
  roundLengthTo = 0,
): { point: Vec2; degrees: number } {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const rawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const degrees = snapAngle(rawDeg, stepDeg);

  let len = Math.hypot(dx, dy);
  if (roundLengthTo > 0) len = Math.round(len / roundLengthTo) * roundLengthTo;

  const rad = (degrees * Math.PI) / 180;
  return {
    point: { x: anchor.x + len * Math.cos(rad), y: anchor.y + len * Math.sin(rad) },
    degrees,
  };
}

export function snapPoint(raw: Vec2, ctx: SnapContext): SnapResult {
  if (ctx.suppressed) return { point: raw, hints: [] };

  const hit = nearestPoint(raw, ctx.points, ctx.toleranceMm);
  if (hit) return { point: hit, hints: [{ kind: 'point', at: hit }] };

  if (ctx.anchor && ctx.angleStepDeg > 0) {
    const { point, degrees } = constrainToAngle(
      ctx.anchor,
      raw,
      ctx.angleStepDeg,
      ctx.gridEnabled ? ctx.gridMm : 0,
    );
    return { point, hints: [{ kind: 'angle', from: ctx.anchor, degrees }] };
  }

  if (ctx.gridEnabled) {
    return {
      point: snapToGrid(raw, ctx.gridMm),
      hints: [{ kind: 'grid', stepMm: ctx.gridMm }],
    };
  }

  return { point: raw, hints: [] };
}
