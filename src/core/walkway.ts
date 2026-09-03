/**
 * The walkway width probe. See PLAN.md §9.3.
 *
 * You draw a path through the space and it tells you the narrowest point along it.
 * That answers the question people actually have — "can I get from the door to the
 * couch?" — and it is the second half of the clearance story: zones ask whether a
 * drawer opens, this asks whether a person fits.
 *
 * **Walls are obstructions here**, unlike in `clearance.ts`. That is the division of
 * labour: a chair pushed against a wall is fine, and a 500mm gap between that chair
 * and the table is not. Walls arrive already split around their openings, so a
 * doorway is a gap you can walk through rather than a wall you cannot — no "is this
 * a door" check, the same property phase 5 relied on for traversal.
 *
 * ## Measured against a body, not at a height
 *
 * PLAN §9.3 specifies a single probe height, 900mm — "hip height, where you actually
 * squeeze past furniture, not floor level where a sofa base is narrower than its
 * arms". The floor half of that is right and the fix is not: **a standard sofa back
 * is 840mm**, so a ray at 900 passes straight over PLAN's own example and reports a
 * clear walkway through the middle of the couch. A dining table at 760 and a dresser
 * at 810 go the same way. Any single height is either low enough to catch table legs
 * or high enough to miss the furniture.
 *
 * So the probe asks what traversal already asks: is anything solid inside the
 * interval a person's body occupies? That is `[STEP_OVER_MM, STAND_HEIGHT_MM]` —
 * `[200, 1800]` — imported from `walk.ts` rather than restated, so there is one
 * definition of "what a body takes up" in the application. A rug is stepped over, a
 * sofa arm at 600 and a sofa back at 840 both obstruct, and a shelf at 1900 does not.
 * The band is still configurable; it is a band rather than a plane.
 *
 * ## What the sampling can miss
 *
 * The path is sampled at its vertices and every `WALKWAY_SAMPLE_MM` along each
 * segment, and each sample casts one ray to each side. So the answer is the narrowest
 * gap **at a sample**, not the true infimum: a table leg 40mm wide sitting between two
 * samples is stepped over, and a gap that pinches diagonally is measured square to
 * the path rather than at its true narrowest. Vertices are always sampled because a
 * path turns where the room pinches, which is where the narrowest point usually is.
 * Stated rather than implied — this is a probe, not a medial-axis analysis, and PLAN
 * §9.3 puts the full navmesh explicitly out of scope.
 *
 * Pure — no DOM, no store.
 */

import type { Floor, SpaceDocument } from './document';
import { findItem } from './document';
import { containsPoint } from './geometry/polygon';
import { spansOverlap, type Span, type Volume } from './geometry/collision';
import { STAND_HEIGHT_MM, STEP_OVER_MM } from './walk';
import { cross, distance, normalize, perp, scale, sub, type Vec2 } from './geometry/vec';
import { segmentOutline, wallSegments } from './openings';
import { MountCycleError, placementVolume } from './placement';

/**
 * What a person's body occupies, taken from the walker rather than restated.
 *
 * The same interval that decides whether the walker fits through a doorway decides
 * whether a gap on the plan is passable, which is the point: the two answers should
 * never disagree.
 */
export const WALKWAY_BAND: Span = { bottom: STEP_OVER_MM, top: STAND_HEIGHT_MM };

/** 30 inches — the usual minimum for a main circulation route. */
export const WALKWAY_MIN_MM = 762;

/** Distance between samples along the path. See the module comment. */
export const WALKWAY_SAMPLE_MM = 100;

/** How far a ray looks before calling the space open. 4m is wider than any corridor. */
export const WALKWAY_MAX_REACH_MM = 4000;

export type WalkwayOptions = {
  /** The vertical slice a body takes up. Defaults to `WALKWAY_BAND`. */
  band?: Span;
  sampleMm?: number;
  maxReachMm?: number;
};

export type WalkwayProbe = {
  /** The narrowest gap found, in mm. Capped at twice the reach when nothing is near. */
  widthMm: number;
  /** The sample it was measured at. */
  at: Vec2;
  /** Where the two rays landed, for drawing the measurement. */
  left: Vec2;
  right: Vec2;
  /** The path runs through something solid here — width is 0 and so is the advice. */
  blocked: boolean;
};

// ---------------------------------------------------------------------------
// What is in the way
// ---------------------------------------------------------------------------

/**
 * Everything solid within the body band: walls split around their openings, plus any
 * placement whose solid span reaches into it.
 *
 * A window with a 914 sill is solid across the band and a doorway is not, which is
 * exactly right and needed no special case — the lintel starts at 2032, above a
 * standing body, the same property traversal relies on.
 */
export function walkwayObstructions(
  doc: SpaceDocument,
  floor: Floor,
  band: Span = WALKWAY_BAND,
): Volume[] {
  const out: Volume[] = [];

  for (const wall of floor.walls) {
    for (const segment of wallSegments(wall, floor.openings)) {
      if (!spansOverlap(band, { bottom: segment.bottom, top: segment.top })) continue;
      try {
        out.push({
          outline: segmentOutline(wall, segment),
          span: { bottom: segment.bottom, top: segment.top },
        });
      } catch {
        // Degenerate wall — the validation panel's problem, not the probe's.
      }
    }
  }

  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item) continue;
    try {
      const volume = placementVolume(doc, placement, item);
      if (!spansOverlap(band, volume.span)) continue;
      out.push(volume);
    } catch (err) {
      if (err instanceof MountCycleError) continue;
      throw err;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

/**
 * Distance from `from` along `dir` to the nearest obstruction edge, or `maxMm`.
 *
 * Returns the *first* crossing rather than testing containment, so a ray that starts
 * in open space and leaves the room through a doorway reports the far jamb rather
 * than the wall behind it.
 */
function castRay(
  from: Vec2,
  dir: Vec2,
  obstructions: readonly Volume[],
  maxMm: number,
): number {
  let nearest = maxMm;

  for (const obstruction of obstructions) {
    const pts = obstruction.outline.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const edge = sub(b, a);
      const denom = cross(dir, edge);
      if (denom === 0) continue; // parallel

      const ap = sub(a, from);
      const t = cross(ap, edge) / denom;
      const s = cross(ap, dir) / denom;
      if (t > 0 && t < nearest && s >= 0 && s <= 1) nearest = t;
    }
  }

  return nearest;
}

function isInside(point: Vec2, obstructions: readonly Volume[]): boolean {
  return obstructions.some((o) => containsPoint(o.outline, point));
}

/** The sample points along a path: every vertex, and every `step` mm between them. */
export function samplePath(path: readonly Vec2[], step: number): { at: Vec2; dir: Vec2 }[] {
  const samples: { at: Vec2; dir: Vec2 }[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const length = distance(a, b);
    if (length === 0) continue;

    const dir = normalize(sub(b, a));
    const count = Math.max(1, Math.ceil(length / step));
    // `<= count` so the segment's far end is always sampled — a path turns where the
    // room pinches, and skipping the vertex would skip the answer.
    for (let k = 0; k <= count; k++) {
      const t = Math.min(k * step, length);
      samples.push({ at: { x: a.x + dir.x * t, y: a.y + dir.y * t }, dir });
    }
  }

  return samples;
}

/**
 * The narrowest gap across the path, measured square to it at each sample.
 *
 * **Assumes every obstruction is already in the band you care about.** Nothing here
 * consults spans; `walkwayObstructions` is what filters by height, and passing it an
 * unfiltered list would measure gaps against rugs and ceiling pendants.
 *
 * Null for a path with no length — there is nothing to be narrow.
 */
export function narrowestGap(
  path: readonly Vec2[],
  obstructions: readonly Volume[],
  options: WalkwayOptions = {},
): WalkwayProbe | null {
  const step = options.sampleMm ?? WALKWAY_SAMPLE_MM;
  const reach = options.maxReachMm ?? WALKWAY_MAX_REACH_MM;
  const samples = samplePath(path, step);
  if (samples.length === 0) return null;

  let best: WalkwayProbe | null = null;

  for (const { at, dir } of samples) {
    const n = perp(dir);

    if (isInside(at, obstructions)) {
      // Standing in a wall. Nothing further along can be narrower than this, but keep
      // the first one found so the reported point is where the path first fails.
      const blocked: WalkwayProbe = { widthMm: 0, at, left: at, right: at, blocked: true };
      return blocked;
    }

    const leftMm = castRay(at, n, obstructions, reach);
    const rightMm = castRay(at, scale(n, -1), obstructions, reach);
    const widthMm = leftMm + rightMm;
    if (best && widthMm >= best.widthMm) continue;

    best = {
      widthMm,
      at,
      left: { x: at.x + n.x * leftMm, y: at.y + n.y * leftMm },
      right: { x: at.x - n.x * rightMm, y: at.y - n.y * rightMm },
      blocked: false,
    };
  }

  return best;
}

/** Whether a probe is worth warning about. */
export function isTooNarrow(probe: WalkwayProbe, minMm: number = WALKWAY_MIN_MM): boolean {
  return probe.widthMm < minMm;
}
