/**
 * The 3D scene, derived from the document. See PLAN.md §10.1.
 *
 * There is no separate scene graph to keep in sync — everything here is computed from
 * the same entities the plan view draws and the collision engine tests. A placement's
 * `outline` is the polygon `worldOutline` already produces; a wall's boxes are the
 * ones `wallSegments` already produces for openings. One primitive, three consumers.
 *
 * **This module knows nothing about three.js.** It emits document millimetres and
 * Z-up spans; the renderer converts at its boundary through `docToThree`, and the
 * walker consumes the same output without any renderer being involved at all. That
 * separation is what makes traversal testable in a plain unit test, and what keeps
 * the walk loop alive when WebGL is not.
 */

import { findItem, type Floor, type Id, type Room, type SpaceDocument } from './document';
import type { Span, Volume } from './geometry/collision';
import { bounds, type Bounds, type Polygon } from './geometry/polygon';
import { wallOutline } from './geometry/wall';
import { segmentOutline, wallSegments } from './openings';
import { MountCycleError, placementSpan, worldOutline } from './placement';

/** What a click in the 3D view resolves to, mirroring the editor's selection shape. */
export type SceneRef = { kind: 'wall' | 'placement'; id: Id };

/**
 * A solid box: a plan polygon extruded between two elevations.
 *
 * Walls arrive already split around their openings, so a doorway is simply an absence
 * of solid rather than a hole anything has to subtract.
 */
export type SceneSolid = {
  /** Unique within the scene. A wall contributes several, suffixed by index. */
  id: string;
  ref: SceneRef;
  outline: Polygon;
  span: Span;
  color: string;
  /** True when the walker's body must not pass through it. */
  blocking: boolean;
};

/** A horizontal slab — a room's floor or its ceiling. */
export type SceneSlab = {
  id: string;
  kind: 'floor' | 'ceiling';
  roomId: Id;
  boundary: Polygon;
  elevationMm: number;
  color: string;
};

export type SceneModel = {
  solids: SceneSolid[];
  slabs: SceneSlab[];
  /** Extent of everything, for framing a camera. Null when the floor is empty. */
  bounds: Bounds | null;
  /** Tallest ceiling on the floor — how high a fly camera needs to clear. */
  ceilingHeightMm: number;
};

export const WALL_COLOR = '#d9d4cc';
export const FLOOR_COLOR = '#efe9df';
export const CEILING_COLOR = '#f6f3ee';
export const DEFAULT_PLACEMENT_COLOR = '#8ba7c4';

/**
 * Everything a renderer or a walker needs, for one floor.
 *
 * A placement whose item is missing, or whose mount is a cycle, contributes nothing
 * rather than throwing: the validation panel is where a broken document is reported,
 * and a renderer that dies on one bad entity takes the whole view with it.
 */
export function buildScene(doc: SpaceDocument, floor: Floor): SceneModel {
  const solids: SceneSolid[] = [];
  const slabs: SceneSlab[] = [];

  for (const wall of floor.walls) {
    const segments = wallSegments(wall, floor.openings);
    segments.forEach((segment, i) => {
      let outline: Polygon;
      try {
        outline = segmentOutline(wall, segment);
      } catch {
        return; // degenerate wall — the validation panel's problem, not the renderer's
      }
      solids.push({
        id: `${wall.id}:${i}`,
        ref: { kind: 'wall', id: wall.id },
        outline,
        span: { bottom: segment.bottom, top: segment.top },
        color: WALL_COLOR,
        blocking: true,
      });
    });
  }

  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item) continue;

    let span: Span;
    try {
      span = placementSpan(doc, placement, item);
    } catch (err) {
      if (err instanceof MountCycleError) continue;
      throw err;
    }
    // A ceiling mount resolves to `ceiling − drop − height`, which goes negative for
    // a tall enough item — the pendant reaches the floor and keeps going. Clamp to
    // the floor datum rather than skipping it: the thing really is in the room and
    // should be seen and collided with, and validation is what says it is wrong.
    // Geometry below the slab would be invisible and still block the walker.
    const clamped = { bottom: Math.max(0, span.bottom), top: span.top };
    if (clamped.top <= clamped.bottom) continue;

    solids.push({
      id: placement.id,
      ref: { kind: 'placement', id: placement.id },
      outline: worldOutline(placement, item),
      span: clamped,
      color: placement.overrides?.color ?? item.color ?? DEFAULT_PLACEMENT_COLOR,
      blocking: true,
    });
  }

  for (const room of floor.rooms) {
    slabs.push({
      id: `${room.id}:floor`,
      kind: 'floor',
      roomId: room.id,
      boundary: room.boundary,
      elevationMm: 0,
      color: room.floorColor ?? FLOOR_COLOR,
    });
    slabs.push({
      id: `${room.id}:ceiling`,
      kind: 'ceiling',
      roomId: room.id,
      boundary: room.boundary,
      elevationMm: room.ceilingHeightMm,
      color: CEILING_COLOR,
    });
  }

  return {
    solids,
    slabs,
    bounds: sceneBounds(solids, floor.rooms),
    ceilingHeightMm: floor.rooms.reduce(
      (h, r) => Math.max(h, r.ceilingHeightMm),
      floor.defaultCeilingHeightMm,
    ),
  };
}

function sceneBounds(solids: readonly SceneSolid[], rooms: readonly Room[]): Bounds | null {
  const boxes: Bounds[] = [];
  for (const solid of solids) boxes.push(bounds(solid.outline));
  for (const room of rooms) boxes.push(bounds(room.boundary));
  if (boxes.length === 0) return null;

  return boxes.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX),
    minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX),
    maxY: Math.max(acc.maxY, b.maxY),
  }));
}

/** The scene's solids as collision volumes — exactly what the walker tests against. */
export function blockersOf(scene: SceneModel): Volume[] {
  return scene.solids
    .filter((s) => s.blocking)
    .map((s) => ({ outline: s.outline, span: s.span }));
}

/**
 * A sensible place to stand when walk mode is entered without a saved position.
 *
 * The centre of the largest room, or the centre of everything drawn when no room has
 * been traced. Not the origin: a plan traced from an imported raster can sit anywhere,
 * and dropping the walker at 0,0 would routinely start them outside the building.
 */
export function defaultStandpoint(floor: Floor, scene: SceneModel): { x: number; y: number } {
  const largest = floor.rooms.reduce<Room | null>(
    (best, room) => (!best || room.areaMm2 > best.areaMm2 ? room : best),
    null,
  );
  const box = largest ? bounds(largest.boundary) : scene.bounds;
  if (!box) return { x: 0, y: 0 };
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

/**
 * A wall's full outline, ignoring its openings.
 *
 * Only used for framing and for the plan-side hit test; the 3D view always draws the
 * split segments, or doorways would be walled up again.
 */
export function fullWallOutline(floor: Floor, wallId: Id): Polygon | null {
  const wall = floor.walls.find((w) => w.id === wallId);
  if (!wall) return null;
  try {
    return wallOutline(wall);
  } catch {
    return null;
  }
}
