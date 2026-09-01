/**
 * Deriving world geometry from placements. See PLAN.md §4.2 and §9.2.
 *
 * Two rules govern this file:
 *
 *  1. **Rotation is never baked into stored vertices.** Footprints stay in local
 *     coordinates; world geometry is derived per query. Baking accumulates error
 *     across repeated rotations and makes "reset rotation" impossible.
 *
 *  2. **Elevation is derived for surface and ceiling mounts.** `Placement.elevation`
 *     is authoritative only for `floor` and `wall`; everything else must go through
 *     `resolveElevation`.
 */

import { solidSpan, type Span, type Volume } from './geometry/collision';
import { containsPoint, roundPolygon, rotatePolygon, translate, type Polygon } from './geometry/polygon';
import { toRadians } from './geometry/vec';
import {
  findFloor,
  findItem,
  type CatalogItem,
  type Floor,
  type Id,
  type Placement,
  type Room,
  type SpaceDocument,
} from './document';

/** The footprint in document space: mirrored, rotated, then translated. */
export function worldOutline(placement: Placement, item: CatalogItem): Polygon {
  let poly = item.footprint.outline;

  if (placement.flipped) {
    poly = { ...poly, pts: poly.pts.map((p) => ({ x: -p.x, y: p.y })).reverse() };
  }
  if (placement.rotation !== 0) {
    poly = rotatePolygon(poly, toRadians(placement.rotation));
  }
  return roundPolygon(translate(poly, placement.position));
}

/** The effective height of a placement, honouring any per-placement override. */
export function effectiveHeight(placement: Placement, item: CatalogItem): number {
  return placement.overrides?.heightMm ?? item.heightMm;
}

/** The top surface of a placement — what a surface-mounted child sits on. */
export function surfaceHeight(placement: Placement, item: CatalogItem): number {
  return item.surfaceHeightMm ?? effectiveHeight(placement, item);
}

export class MountCycleError extends Error {
  constructor(public readonly chain: Id[]) {
    super(`placement: surface-mount cycle ${chain.join(' → ')}`);
    this.name = 'MountCycleError';
  }
}

/**
 * The base of a placement above its floor's datum.
 *
 * `floor` is 0, `wall` uses the stored elevation, `surface` stacks on its host, and
 * `ceiling` hangs below the ceiling of whichever room the placement is in.
 *
 * Cycles (A on B on A) throw rather than recursing forever — a corrupt document
 * should fail loudly at the model layer, not blow the stack inside a renderer.
 */
export function resolveElevation(
  doc: SpaceDocument,
  placement: Placement,
  seen: Id[] = [],
): number {
  if (seen.includes(placement.id)) throw new MountCycleError([...seen, placement.id]);

  switch (placement.mount.kind) {
    case 'floor':
      return 0;

    case 'wall':
      return placement.elevation;

    case 'surface': {
      const hostId = placement.mount.hostId;
      const floor = findFloor(doc, placement.floorId);
      const host = floor?.placements.find((p) => p.id === hostId);
      const hostItem = host ? findItem(doc, host.itemId) : undefined;
      // A dangling host reference degrades to the floor rather than throwing —
      // a deleted host should not make the document unopenable.
      if (!host || !hostItem) return 0;
      return (
        resolveElevation(doc, host, [...seen, placement.id]) +
        surfaceHeight(host, hostItem)
      );
    }

    case 'ceiling': {
      const item = findItem(doc, placement.itemId);
      const ceiling = ceilingHeightAt(doc, placement);
      const height = item ? effectiveHeight(placement, item) : 0;
      return ceiling - placement.mount.drop - height;
    }
  }
}

/**
 * Which room a placement sits in, by point-in-polygon on its centre.
 *
 * Resolved at query time rather than stored. A stored `roomId` needs reassignment
 * every time a placement is dragged across a boundary, and a stale one silently
 * produces the wrong headroom answer.
 */
export function roomAt(floor: Floor, position: { x: number; y: number }): Room | undefined {
  return floor.rooms.find((r) => containsPoint(r.boundary, position));
}

export function roomOf(doc: SpaceDocument, placement: Placement): Room | undefined {
  const floor = findFloor(doc, placement.floorId);
  return floor ? roomAt(floor, placement.position) : undefined;
}

/** Ceiling height above a placement, falling back to the floor default. */
export function ceilingHeightAt(doc: SpaceDocument, placement: Placement): number {
  const floor = findFloor(doc, placement.floorId);
  if (!floor) return 0;
  return roomAt(floor, placement.position)?.ceilingHeightMm ?? floor.defaultCeilingHeightMm;
}

/** The solid vertical extent of a placement, honouring `voidBelowMm`. */
export function placementSpan(
  doc: SpaceDocument,
  placement: Placement,
  item: CatalogItem,
): Span {
  return solidSpan(
    resolveElevation(doc, placement),
    effectiveHeight(placement, item),
    item.voidBelowMm,
  );
}

/** Footprint plus vertical span — everything collision needs. */
export function placementVolume(
  doc: SpaceDocument,
  placement: Placement,
  item: CatalogItem,
): Volume {
  return {
    outline: worldOutline(placement, item),
    span: placementSpan(doc, placement, item),
  };
}

/** True when a placement's top breaks through the ceiling above it. */
export function exceedsHeadroom(
  doc: SpaceDocument,
  placement: Placement,
  item: CatalogItem,
): boolean {
  return placementSpan(doc, placement, item).top > ceilingHeightAt(doc, placement);
}
