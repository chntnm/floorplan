/**
 * Collision. See PLAN.md §9.2.
 *
 * Two objects collide only if their footprints overlap in plan **and** their solid
 * vertical spans overlap:
 *
 *     collides(A, B) = polygonsIntersect(outline(A), outline(B))
 *                   && intervalsOverlap(solidSpan(A), solidSpan(B))
 *
 * The vertical half is what lets a rug sit under a table, a bin slide under a desk,
 * and a wall shelf hang above a dresser without any of them registering as a clash.
 */

import polygonClipping from 'polygon-clipping';
import { bounds, boundsOverlap, containsPoint, polygon, signedArea, type Polygon } from './polygon';
import { distanceToSegment, type Vec2 } from './vec';

/** A closed vertical interval in millimetres above the floor datum. */
export type Span = { bottom: number; top: number };

/**
 * The solid part of an object's vertical extent.
 *
 * `voidBelowMm` is the open air beneath — a dining table's apron is ~720mm, a desk's
 * ~700mm, a bed frame's ~250mm, a dresser's 0. Without it a table would be treated as
 * a solid block from the floor up and every rug beneath one would read as a collision.
 */
export function solidSpan(
  elevationMm: number,
  heightMm: number,
  voidBelowMm = 0,
): Span {
  const bottom = elevationMm + voidBelowMm;
  const top = elevationMm + heightMm;
  if (top < bottom) {
    throw new RangeError(
      `solidSpan: voidBelowMm ${voidBelowMm} exceeds heightMm ${heightMm}`,
    );
  }
  return { bottom, top };
}

/**
 * Strict overlap — spans that merely touch (a lamp resting exactly on a table top)
 * do not collide. This is what makes surface mounting work without a fudge factor.
 */
export function spansOverlap(a: Span, b: Span): boolean {
  return a.bottom < b.top && b.bottom < a.top;
}

type Ring = [number, number][];

function toRing(poly: Polygon): Ring {
  const ring: Ring = poly.pts.map((p) => [p.x, p.y]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

/**
 * Area of the overlap between two polygons, in mm².
 *
 * Broad phase on bounding boxes first — the vast majority of pairs in a real room
 * are separated, and that check is two comparisons instead of a clipping pass.
 */
export function intersectionArea(a: Polygon, b: Polygon): number {
  if (!boundsOverlap(bounds(a), bounds(b))) return 0;

  const result = polygonClipping.intersection([toRing(a)], [toRing(b)]);

  // polygon-clipping returns a MultiPolygon whose rings carry their orientation in
  // the sign of their area: outer rings positive, holes negative. Summing signed
  // areas therefore gives the net area directly, without assuming outer-ring-first
  // ordering. (Verified: a square annulus yields +1,000,000 and −160,000.)
  let total = 0;
  for (const poly of result) {
    for (const ring of poly) {
      // A ring repeats its first point; drop it, and skip degenerate rings.
      const pts = ring.slice(0, -1).map(([x, y]) => ({ x, y }));
      if (pts.length < 3) continue;
      total += signedArea(polygon(pts));
    }
  }
  return total;
}

/**
 * Whether two polygons overlap by more than a negligible area.
 *
 * The tolerance matters: two objects snapped flush against the same wall share an
 * edge, and floating-point clipping can report a sliver of overlap along it. 1 mm²
 * is far below anything a user could have meant.
 */
export const OVERLAP_TOLERANCE_MM2 = 1;

export function polygonsIntersect(a: Polygon, b: Polygon): boolean {
  return intersectionArea(a, b) > OVERLAP_TOLERANCE_MM2;
}

/**
 * Whether a circle overlaps a polygon.
 *
 * Inside counts, which is what makes this usable for a walker: a body that has
 * somehow ended up inside a wall must read as colliding, not as clear because no
 * edge is within its radius.
 */
export function circleIntersects(poly: Polygon, centre: Vec2, radius: number): boolean {
  const b = bounds(poly);
  if (
    centre.x + radius < b.minX ||
    centre.x - radius > b.maxX ||
    centre.y + radius < b.minY ||
    centre.y - radius > b.maxY
  ) {
    return false;
  }
  if (containsPoint(poly, centre)) return true;

  const pts = poly.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    if (distanceToSegment(centre, a, c) <= radius) return true;
  }
  return false;
}

export type Volume = {
  outline: Polygon;
  span: Span;
};

/** The full 3D test. */
export function volumesCollide(a: Volume, b: Volume): boolean {
  return spansOverlap(a.span, b.span) && polygonsIntersect(a.outline, b.outline);
}

/**
 * All colliding pairs in a set, as indices into the input.
 *
 * Sorts by bounding box on x and sweeps, so separated objects are rejected without a
 * clipping pass. Adequate to the target of ~500 placements; a grid index is the next
 * step if that ceiling moves.
 */
export function findCollisions(volumes: Volume[]): [number, number][] {
  const order = volumes
    .map((v, i) => ({ i, b: bounds(v.outline) }))
    .sort((p, q) => p.b.minX - q.b.minX);

  const pairs: [number, number][] = [];
  for (let a = 0; a < order.length; a++) {
    const A = order[a]!;
    for (let b = a + 1; b < order.length; b++) {
      const B = order[b]!;
      // Sorted by minX: once B starts past A's right edge, so does everything after.
      if (B.b.minX >= A.b.maxX) break;
      if (volumesCollide(volumes[A.i]!, volumes[B.i]!)) {
        pairs.push(A.i < B.i ? [A.i, B.i] : [B.i, A.i]);
      }
    }
  }
  return pairs;
}
