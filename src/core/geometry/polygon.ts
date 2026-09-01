/**
 * The one geometry primitive. See PLAN.md §4.1.
 *
 * Every shape in the application — room boundaries, furniture footprints, clearance
 * zones — is a closed polygon. Rect, circle, L, U and the rest are *generators* that
 * emit one of these; they are not separate classes with separate renderers.
 *
 * Convention: `pts` is a closed ring in counter-clockwise order, and the first point
 * is **not** repeated at the end.
 */

import { add, cross, rotate, sub, type Vec2 } from './vec';

export type ArcSegment = {
  /** The arc replaces the straight edge that starts at `pts[afterIndex]`. */
  afterIndex: number;
  /** tan(θ/4) where θ is the included angle. 0 is a straight line. */
  bulge: number;
};

export type Polygon = {
  pts: Vec2[];
  /**
   * Curved edges, retained so the 2D view can stroke a true arc and the 3D view can
   * build a real cylinder. Phase 1 tessellates curves in the generators, so every
   * algorithm below consumes `pts` alone.
   */
  arcs?: ArcSegment[];
};

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function polygon(pts: Vec2[]): Polygon {
  if (pts.length < 3) {
    throw new RangeError(`polygon: needs at least 3 points, got ${pts.length}`);
  }
  return { pts };
}

/**
 * Signed area via the shoelace formula. Positive when the ring is counter-clockwise.
 * The sign is what `isCounterClockwise` and `ensureCounterClockwise` are built on.
 */
export function signedArea(poly: Polygon): number {
  const { pts } = poly;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += cross(a, b);
  }
  return sum / 2;
}

/** Unsigned area in mm². Invariant under rotation and translation. */
export function area(poly: Polygon): number {
  return Math.abs(signedArea(poly));
}

export function isCounterClockwise(poly: Polygon): boolean {
  return signedArea(poly) > 0;
}

/** Return the polygon wound counter-clockwise, reversing only if needed. */
export function ensureCounterClockwise(poly: Polygon): Polygon {
  return isCounterClockwise(poly) ? poly : { ...poly, pts: [...poly.pts].reverse() };
}

/** Area-weighted centroid. Falls back to the vertex mean for degenerate rings. */
export function centroid(poly: Polygon): Vec2 {
  const { pts } = poly;
  const a2 = signedArea(poly) * 2;

  if (a2 === 0) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / pts.length, y: sy / pts.length };
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const w = cross(p, q);
    cx += (p.x + q.x) * w;
    cy += (p.y + q.y) * w;
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

export function bounds(poly: Polygon): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly.pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

export function width(poly: Polygon): number {
  const b = bounds(poly);
  return b.maxX - b.minX;
}

export function depth(poly: Polygon): number {
  const b = bounds(poly);
  return b.maxY - b.minY;
}

export function translate(poly: Polygon, offset: Vec2): Polygon {
  return { ...poly, pts: poly.pts.map((p) => add(p, offset)) };
}

/** Rotate about `pivot` (default: the origin of the polygon's own local space). */
export function rotatePolygon(poly: Polygon, radians: number, pivot?: Vec2): Polygon {
  const o = pivot ?? { x: 0, y: 0 };
  return { ...poly, pts: poly.pts.map((p) => add(rotate(sub(p, o), radians), o)) };
}

/**
 * Even-odd ray cast. Points exactly on an edge are not guaranteed either way —
 * callers that care about boundaries should use a tolerance band instead.
 */
export function containsPoint(poly: Polygon, point: Vec2): boolean {
  const { pts } = poly;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    const straddles = a.y > point.y !== b.y > point.y;
    if (straddles) {
      const t = (b.x - a.x) * (point.y - a.y);
      const u = (b.y - a.y) || Number.EPSILON;
      if (point.x < a.x + t / u) inside = !inside;
    }
  }
  return inside;
}

/** Perimeter length in mm. */
export function perimeter(poly: Polygon): number {
  const { pts } = poly;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    total += Math.hypot(
      pts[(i + 1) % pts.length]!.x - pts[i]!.x,
      pts[(i + 1) % pts.length]!.y - pts[i]!.y,
    );
  }
  return total;
}

/** True when every interior angle is convex — lets callers pick a cheaper path. */
export function isConvex(poly: Polygon): boolean {
  const { pts } = poly;
  if (pts.length < 4) return true;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const z = cross(sub(b, a), sub(c, b));
    if (z !== 0) {
      const s = Math.sign(z);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/** Round every vertex to the integer-millimetre grid. */
export function roundPolygon(poly: Polygon): Polygon {
  return { ...poly, pts: poly.pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) };
}
