/**
 * Item clearance zones. See PLAN.md §9.3.
 *
 * A dresser is not just the box it occupies. It needs 900mm in front of it or the
 * drawers do not open; a dining chair needs a metre behind it or nobody can get up;
 * an oven door needs 1200mm or it fouls the island. None of that is visible in a
 * footprint, and all of it is the difference between a plan that works and one that
 * looks fine on paper.
 *
 * A zone is declared on the **catalog item**, not the placement, because it is a
 * property of the thing: every dresser you own needs its drawers to open. It is
 * attached to a footprint edge and travels with the placement — rotate the dresser
 * and its drawer clearance rotates too, which falls out of putting the zone through
 * `toWorld`, the same transform the outline goes through.
 *
 * ## Three decisions worth stating
 *
 * **Zones are rectangles off the local bounding box**, not offsets from the true
 * outline. PLAN §9.3 says "attached to a footprint edge", and a bounding-box edge is
 * the only edge a circular table has. An offset curve for a round item would be more
 * faithful and would answer no question anyone is asking.
 *
 * **Walls are not obstructions.** This is the same rule phase 6 settled for door
 * swings, and for the same reason: wall snap seats an item's back edge *on the wall
 * face*, so a back zone tested against walls would fire on every chair pushed against
 * one — the default outcome of using the snap, not a corner case. The question "is
 * there room to get past this" is a different question, and the walkway probe is
 * what answers it, with walls very much included. Two checks, as PLAN describes.
 *
 * **The threshold lives on the intruder, not on the zone.** A rug in front of a
 * dresser is not a blocked drawer, but the fix is *not* to lift the zone's floor —
 * that would exempt a band of space and hide a 90mm shoe rack sitting in it. What
 * makes the rug irrelevant is that you step over it. So the zone runs from the floor
 * and anything whose solid top is below `CLEARANCE_STEP_OVER_MM` is skipped: the same
 * shape of rule as `voidBelowMm` and the walker's `STEP_OVER_MM`, and a property of
 * the object rather than of the space.
 *
 * Pure — no DOM, no store.
 */

import type {
  CatalogItem,
  ClearanceZone,
  Floor,
  Id,
  Placement,
  SpaceDocument,
} from './document';
import { findItem } from './document';
import { intersectionArea, spansOverlap, type Span, type Volume } from './geometry/collision';
import { footprintBounds } from './geometry/footprint';
import { polygon, type Polygon } from './geometry/polygon';
import { MountCycleError, effectiveHeight, placementVolume, resolveElevation, toWorld } from './placement';

export const ZONE_EDGES = ['front', 'back', 'left', 'right'] as const;
export type ZoneEdge = (typeof ZONE_EDGES)[number];

/**
 * How a zone reads in a sentence. "in front of the Dresser", "behind the Chair".
 *
 * Local **+y is the front**, because wall snap seats the footprint's back edge on
 * local −y against the wall — so the front is the side facing into the room.
 */
export const EDGE_LABELS: Record<ZoneEdge, string> = {
  front: 'in front of',
  back: 'behind',
  left: 'to the left of',
  right: 'to the right of',
};

/**
 * What a stride clears, and therefore what cannot block a drawer.
 *
 * A rug, a threshold, a floor cable. Deliberately lower than the walker's 200mm:
 * reaching past something to open a drawer is not the same as walking over it, and
 * a 150mm box in front of a dresser is genuinely in the way.
 */
export const CLEARANCE_STEP_OVER_MM = 100;

/** Below this a zone is not describing anything. */
export const MIN_ZONE_DEPTH_MM = 1;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The zone as a plan polygon in document space.
 *
 * Built in the item's local frame off its bounding box, then put through the very
 * transform the outline uses — so a rotated, flipped item's zones are rotated and
 * flipped identically, by construction rather than by two formulas agreeing.
 */
export function zoneOutline(
  placement: Placement,
  item: CatalogItem,
  zone: ClearanceZone,
): Polygon | null {
  if (!Number.isFinite(zone.depthMm) || zone.depthMm < MIN_ZONE_DEPTH_MM) return null;
  const b = footprintBounds(item.footprint);
  const d = zone.depthMm;

  const rect = (minX: number, minY: number, maxX: number, maxY: number): Polygon =>
    polygon([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]);

  const local =
    zone.edge === 'front'
      ? rect(b.minX, b.maxY, b.maxX, b.maxY + d)
      : zone.edge === 'back'
        ? rect(b.minX, b.minY - d, b.maxX, b.minY)
        : zone.edge === 'left'
          ? rect(b.minX - d, b.minY, b.minX, b.maxY)
          : rect(b.maxX, b.minY, b.maxX + d, b.maxY);

  return toWorld(placement, local);
}

/**
 * The zone's vertical extent, from the floor the item stands on.
 *
 * `heightMm` omitted means the full height of the host: a wardrobe's doors need the
 * whole wardrobe's worth of space. Given, it is what the zone actually cares about —
 * a drawer pull at 810mm is indifferent to a wall shelf hanging at 1500.
 */
export function zoneSpan(
  doc: SpaceDocument,
  placement: Placement,
  item: CatalogItem,
  zone: ClearanceZone,
): Span {
  const bottom = resolveElevation(doc, placement);
  return { bottom, top: bottom + (zone.heightMm ?? effectiveHeight(placement, item)) };
}

export function zoneVolume(
  doc: SpaceDocument,
  placement: Placement,
  item: CatalogItem,
  zone: ClearanceZone,
): Volume | null {
  const outline = zoneOutline(placement, item, zone);
  if (!outline) return null;
  return { outline, span: zoneSpan(doc, placement, item, zone) };
}

/** Every zone on a floor, already in document space. Used by the plan overlay too. */
export function floorZones(
  doc: SpaceDocument,
  floor: Floor,
): { placement: Placement; item: CatalogItem; zone: ClearanceZone; volume: Volume }[] {
  const out: { placement: Placement; item: CatalogItem; zone: ClearanceZone; volume: Volume }[] = [];

  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item?.clearances) continue;

    for (const zone of item.clearances) {
      let volume: Volume | null;
      try {
        volume = zoneVolume(doc, placement, item, zone);
      } catch (err) {
        // A broken mount has no position to hang a zone off. Validation reports the
        // mount; a zone for it would be an assertion about a place that is not real.
        if (err instanceof MountCycleError) continue;
        throw err;
      }
      if (volume) out.push({ placement, item, zone, volume });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/**
 * Everything a placement is stacked on, however many items deep.
 *
 * Walked rather than looked up one level: a tray on a lamp on a dresser is still on
 * the dresser. A cycle terminates the walk instead of hanging — `placementVolume`
 * has already thrown `MountCycleError` for those, so this only guards the traversal.
 */
function hostsAbove(byId: Map<Id, Placement>, placement: Placement): Set<Id> {
  const hosts = new Set<Id>();
  let current = placement;
  while (current.mount.kind === 'surface') {
    const hostId = current.mount.hostId;
    if (hosts.has(hostId)) break;
    hosts.add(hostId);
    const next = byId.get(hostId);
    if (!next) break;
    current = next;
  }
  return hosts;
}

export type ZoneViolation = {
  /** The item whose clearance is compromised. */
  placementId: Id;
  /** What is standing in it. */
  intruderId: Id;
  zone: ClearanceZone;
  /** How much of the zone footprint is taken, in mm² — sorted worst-first. */
  overlapMm2: number;
};

/**
 * Everything standing in a clearance zone it should not be.
 *
 * Three things are skipped. The host itself, because a zone starts at its own
 * bounding-box edge. Anything a stride clears, for the reason in the module comment.
 * And **anything stacked on the host**, at any depth: a lamp on the dresser rides on
 * the dresser and cannot be in the way of it opening, whatever its footprint does.
 *
 * That last one is not theoretical. A zone runs from the floor to `heightMm`, and the
 * default `heightMm` is the host's own height — which is also the elevation a
 * surface-mounted child resolves to, so the two spans meet exactly and `spansOverlap`
 * is strict enough to stay quiet. Give a zone the explicit height the field exists for
 * ("a drawer pull at 810mm is indifferent to a shelf at 1500") and the coincidence
 * disappears: the lamp on the dresser starts reporting that it blocks the dresser.
 *
 * Everything else is a plain volume-vs-volume test: footprints overlap in plan *and*
 * solid spans overlap.
 */
export function findClearanceViolations(doc: SpaceDocument, floor: Floor): ZoneViolation[] {
  const zones = floorZones(doc, floor);
  if (zones.length === 0) return [];

  const byId = new Map(floor.placements.map((p) => [p.id, p]));
  const obstacles: { id: Id; volume: Volume; ridesOn: Set<Id> }[] = [];
  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item) continue;
    try {
      const volume = placementVolume(doc, placement, item);
      // What you step over cannot block a drawer.
      if (volume.span.top < CLEARANCE_STEP_OVER_MM) continue;
      obstacles.push({ id: placement.id, volume, ridesOn: hostsAbove(byId, placement) });
    } catch (err) {
      if (err instanceof MountCycleError) continue;
      throw err;
    }
  }

  const violations: ZoneViolation[] = [];
  for (const { placement, zone, volume } of zones) {
    for (const obstacle of obstacles) {
      if (obstacle.id === placement.id) continue;
      if (obstacle.ridesOn.has(placement.id)) continue;
      if (!spansOverlap(volume.span, obstacle.volume.span)) continue;

      const overlapMm2 = intersectionArea(volume.outline, obstacle.volume.outline);
      if (overlapMm2 <= 0) continue;

      violations.push({
        placementId: placement.id,
        intruderId: obstacle.id,
        zone,
        overlapMm2,
      });
    }
  }

  return violations.sort((a, b) => b.overlapMm2 - a.overlapMm2);
}
