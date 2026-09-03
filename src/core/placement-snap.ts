/**
 * Snapping for placements. See PLAN.md §9.1.
 *
 * Three snaps, in strict precedence:
 *
 *   1. **Surface** — dragged over something whose `canHostSurface` is true, the mount
 *      converts to `surface` and the item seats exactly on top. Dragging off returns
 *      it to the floor. The flag is what stops a lamp carried across the room from
 *      mounting itself to every sofa it passes over.
 *   2. **Wall** — within tolerance of a wall, the item rotates to match the wall and
 *      translates so its *back edge* is flush against the wall's near face. Not its
 *      centre: a sofa centred on a wall is half inside it.
 *   3. **Grid**.
 *
 * Alt suppresses all of it, the same escape hatch the drawing tools have.
 *
 * **The back of an item is its local −y edge** — at rotation 0 the back faces "north",
 * which is how furniture is drawn and how the footprint generators are oriented. Every
 * offset here is measured from the footprint's local origin to that edge, so a shape
 * that is not symmetric about its origin still sits flush.
 *
 * Pure — no DOM, no store.
 */

import type { Id, Mount, Wall } from './document';
import type { Footprint } from './geometry/footprint';
import { bounds, containsPoint, type Polygon } from './geometry/polygon';
import { add, dot, normalize, perp, scale, sub, toDegrees, type Vec2 } from './geometry/vec';
import { snapToGrid } from './snapping';

/** Rotation snaps to this increment unless suppressed. */
export const ROTATION_STEP_DEG = 15;

export type SnapHost = {
  id: Id;
  outline: Polygon;
  canHostSurface: boolean;
};

export type PlacementSnapHint =
  | { kind: 'wall'; wallId: Id }
  | { kind: 'surface'; hostId: Id }
  | { kind: 'grid' };

export type PlacementSnapContext = {
  walls: readonly Wall[];
  /** Existing placements, nearest-first is not required; the last match wins. */
  hosts: readonly SnapHost[];
  footprint: Footprint;
  gridMm: number;
  gridEnabled: boolean;
  /** Snap radius in document mm — normally `pxToMm(viewport, 10)`. */
  toleranceMm: number;
  /** Alt held. */
  suppressed: boolean;
};

export type PlacementSnapResult = {
  position: Vec2;
  rotation: number;
  mount: Mount;
  hints: PlacementSnapHint[];
};

/**
 * Distance from the footprint's local origin to its back edge.
 *
 * `bounds().minY` is negative for a footprint straddling its origin, so this is the
 * half-depth for a centred shape and the true offset for one that is not.
 */
export function backOffset(footprint: Footprint): number {
  return -bounds(footprint.outline).minY;
}

/**
 * Where an item must sit, and how it must be turned, to stand flush against a wall.
 *
 * Returns `null` when the item is not beside this wall at all — past either end, or
 * further than `toleranceMm` from the face. A negative gap (the item overlapping the
 * wall) still snaps: pulling it out is exactly what the user wants.
 */
export function snapToWall(
  raw: Vec2,
  wall: Wall,
  footprint: Footprint,
  toleranceMm: number,
): { position: Vec2; rotation: number; gap: number } | null {
  const along = sub(wall.b, wall.a);
  const length = Math.hypot(along.x, along.y);
  if (length === 0) return null;

  const d = normalize(along);
  const n = perp(d);
  const rel = sub(raw, wall.a);

  // Past either end is beside the wall's *extension*, not the wall.
  const t = dot(rel, d);
  if (t < -toleranceMm || t > length + toleranceMm) return null;

  const offset = dot(rel, n);
  const side = offset >= 0 ? 1 : -1;
  // Unit vector pointing from the item toward the wall.
  const toWall = scale(n, -side);

  const half = wall.thicknessMm / 2;
  const back = backOffset(footprint);
  const gap = Math.abs(offset) - half - back;
  if (gap > toleranceMm) return null;

  // The item's local −y must end up pointing at the wall. rotate((0,-1), θ) is
  // (sin θ, −cos θ), so θ = atan2(toWall.x, −toWall.y).
  const rotation = toDegrees(Math.atan2(toWall.x, -toWall.y));

  const projection = add(wall.a, scale(d, Math.max(0, Math.min(length, t))));
  const position = sub(projection, scale(toWall, half + back));

  return { position, rotation, gap };
}

/** The host a point lands on, or undefined. Later hosts win — they render on top. */
export function hostAt(point: Vec2, hosts: readonly SnapHost[]): SnapHost | undefined {
  let found: SnapHost | undefined;
  for (const host of hosts) {
    if (host.canHostSurface && containsPoint(host.outline, point)) found = host;
  }
  return found;
}

/**
 * Resolve a dragged position into where the placement actually goes.
 *
 * `rotation` is the item's current rotation and is returned unchanged unless a wall
 * snap overrides it — turning an item because it drifted near a wall is expected;
 * turning it for any other reason is not.
 */
export function snapPlacement(
  raw: Vec2,
  rotation: number,
  ctx: PlacementSnapContext,
): PlacementSnapResult {
  if (ctx.suppressed) {
    return { position: raw, rotation, mount: { kind: 'floor' }, hints: [] };
  }

  const host = hostAt(raw, ctx.hosts);
  if (host) {
    // Deliberately no wall snap here: something already standing on a table is not
    // also standing against a wall, and rotating it to a wall it happens to be near
    // would spin it out from under the user's cursor.
    return {
      position: ctx.gridEnabled ? snapToGrid(raw, ctx.gridMm) : raw,
      rotation,
      mount: { kind: 'surface', hostId: host.id },
      hints: [{ kind: 'surface', hostId: host.id }],
    };
  }

  let best: { wall: Wall; snap: NonNullable<ReturnType<typeof snapToWall>> } | null = null;
  for (const wall of ctx.walls) {
    const snap = snapToWall(raw, wall, ctx.footprint, ctx.toleranceMm);
    if (!snap) continue;
    if (!best || Math.abs(snap.gap) < Math.abs(best.snap.gap)) best = { wall, snap };
  }

  if (best) {
    return {
      position: best.snap.position,
      rotation: best.snap.rotation,
      mount: { kind: 'floor' },
      hints: [{ kind: 'wall', wallId: best.wall.id }],
    };
  }

  if (ctx.gridEnabled) {
    return {
      position: snapToGrid(raw, ctx.gridMm),
      rotation,
      mount: { kind: 'floor' },
      hints: [{ kind: 'grid' }],
    };
  }

  return { position: raw, rotation, mount: { kind: 'floor' }, hints: [] };
}

/** Round a rotation onto the 15° ladder, or leave it alone when suppressed. */
export function snapRotation(degrees: number, suppressed: boolean): number {
  if (suppressed) return degrees;
  return Math.round(degrees / ROTATION_STEP_DEG) * ROTATION_STEP_DEG;
}
