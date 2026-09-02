/** 2D vector helpers. All coordinates are millimetres (integer at rest). */

export type Vec2 = { x: number; y: number };

export const ORIGIN: Vec2 = Object.freeze({ x: 0, y: 0 });

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (z component of the 3D cross). Sign gives orientation. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

/** Rotate 90° counter-clockwise. */
export function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

export function rotate(a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export function rotateAround(a: Vec2, pivot: Vec2, radians: number): Vec2 {
  return add(rotate(sub(a, pivot), radians), pivot);
}

export function equals(a: Vec2, b: Vec2, tolerance = 0): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

/**
 * Perpendicular distance from a point to a **segment**, not to the infinite line.
 *
 * Lives here rather than in `wall.ts` because walls are not the only thing measured
 * against: the walker's capsule is tested against every polygon edge in the scene,
 * and that must not have to import a wall to do it.
 */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Normalize an angle in degrees to [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const d = degrees % 360;
  return d < 0 ? d + 360 : d;
}
