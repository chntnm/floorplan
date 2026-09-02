/**
 * Wall geometry.
 *
 * A wall is stored as a centreline plus a thickness — that is what a plan actually
 * is, and it keeps openings addressable as an offset along the line. The drawn
 * quadrilateral is derived here.
 *
 * **Joins are butt joins, not mitres.** Two walls meeting at a corner each end square
 * at their own centreline endpoint, leaving a small notch on the outside of the
 * corner and a small overlap on the inside. Proper mitring means solving junction
 * graphs, T-intersections and three-way meets — a large piece of work that buys
 * appearance, not correctness. The centrelines are exact, lengths and areas are
 * exact, and the 3D extrusion in phase 5 reads the same centrelines.
 */

import { polygon, ensureCounterClockwise, type Polygon } from './polygon';
import { distance, normalize, perp, sub, type Vec2 } from './vec';

export type WallLine = {
  a: Vec2;
  b: Vec2;
  thicknessMm: number;
};

/** Walls shorter than this are degenerate — a double-click, not an intent. */
export const MIN_WALL_LENGTH_MM = 1;

export function wallLength(wall: WallLine): number {
  return distance(wall.a, wall.b);
}

export function isDegenerate(wall: WallLine): boolean {
  return wallLength(wall) < MIN_WALL_LENGTH_MM;
}

/** Angle of the centreline in degrees, measured from +x. */
export function wallAngleDeg(wall: WallLine): number {
  return (Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x) * 180) / Math.PI;
}

export function wallMidpoint(wall: WallLine): Vec2 {
  return { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
}

/**
 * The wall as a closed quad, `thicknessMm` wide about its centreline.
 *
 * Throws on a degenerate wall rather than emitting a zero-area polygon: a caller that
 * has one has a bug upstream, and a silent empty shape is far harder to find than a
 * throw at the point it was created.
 */
export function wallOutline(wall: WallLine): Polygon {
  if (isDegenerate(wall)) {
    throw new RangeError(
      `wallOutline: wall is degenerate (length ${wallLength(wall).toFixed(3)}mm)`,
    );
  }
  const dir = normalize(sub(wall.b, wall.a));
  const half = wall.thicknessMm / 2;
  const n = { x: perp(dir).x * half, y: perp(dir).y * half };

  return ensureCounterClockwise(
    polygon([
      { x: wall.a.x + n.x, y: wall.a.y + n.y },
      { x: wall.b.x + n.x, y: wall.b.y + n.y },
      { x: wall.b.x - n.x, y: wall.b.y - n.y },
      { x: wall.a.x - n.x, y: wall.a.y - n.y },
    ]),
  );
}

/** Perpendicular distance from a point to a segment (not the infinite line). */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * How far along the centreline a point falls, in mm from `a`, clamped to the wall.
 * This is the coordinate `Opening.offsetMm` is expressed in.
 */
export function projectOntoWall(wall: WallLine, p: Vec2): number {
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;

  const t = ((p.x - wall.a.x) * dx + (p.y - wall.a.y) * dy) / lenSq;
  return Math.max(0, Math.min(1, t)) * Math.sqrt(lenSq);
}

/**
 * Whether a point is within `toleranceMm` of the wall's *body*.
 *
 * The tolerance is added to the half-thickness rather than used alone, so a thick
 * wall is as easy to click anywhere across its width as a thin one is on its line.
 */
export function hitsWall(wall: WallLine, p: Vec2, toleranceMm: number): boolean {
  return distanceToSegment(p, wall.a, wall.b) <= wall.thicknessMm / 2 + toleranceMm;
}

/**
 * The wall whose body is under a point, nearest first.
 *
 * Nearest rather than first-match: walls overlap at every corner (joins are butt
 * joins, so there is a small overlap on the inside of each), and clicking a corner
 * should address the wall you are pointing at rather than whichever was drawn first.
 */
export function nearestWall<T extends WallLine>(
  walls: readonly T[],
  p: Vec2,
  toleranceMm: number,
): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const wall of walls) {
    if (isDegenerate(wall)) continue;
    const d = distanceToSegment(p, wall.a, wall.b);
    if (d <= wall.thicknessMm / 2 + toleranceMm && d < bestDistance) {
      best = wall;
      bestDistance = d;
    }
  }
  return best;
}

/** Every distinct endpoint across a set of walls — the candidate set for snapping. */
export function wallEndpoints(walls: readonly WallLine[]): Vec2[] {
  const seen = new Set<string>();
  const out: Vec2[] = [];
  for (const wall of walls) {
    for (const p of [wall.a, wall.b]) {
      const key = `${p.x},${p.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}
