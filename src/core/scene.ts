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
import { openingSpan, segmentOutline, wallSegments } from './openings';
import { leafOf, leafPanel } from './swing';
import { MountCycleError, placementSpan, worldOutline } from './placement';

/**
 * What a click in the 3D view resolves to, mirroring the editor's selection shape.
 *
 * `opening` is here because a door leaf is a thing you can point at. It is
 * **structure**, not furniture — whoever consumes this has to gate it the way it
 * gates walls, or the layer toggle stops meaning anything in 3D.
 */
export type SceneRef = { kind: 'wall' | 'placement' | 'opening'; id: Id };

/**
 * A solid box: a plan polygon extruded between two elevations.
 *
 * Walls arrive already split around their openings, so a doorway is simply an absence
 * of solid rather than a hole anything has to subtract.
 */
export type SceneSolid = {
  /** Unique within the scene. A wall contributes several, suffixed by index. */
  id: string;
  /** Which floor it came from. In a stacked scene, only the active floor's solids take clicks. */
  floorId: Id;
  ref: SceneRef;
  outline: Polygon;
  span: Span;
  color: string;
  /** True when the walker's body must not pass through it. */
  blocking: boolean;
  /** 1 for everything solid; less for glazing. */
  opacity: number;
};

/** A horizontal slab — a room's floor or its ceiling. */
export type SceneSlab = {
  id: string;
  floorId: Id;
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
export const LEAF_COLOR = '#c9b79c';
export const GLAZING_COLOR = '#bcd8e6';
export const GLAZING_OPACITY = 0.35;
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
        floorId: floor.id,
        ref: { kind: 'wall', id: wall.id },
        outline,
        span: { bottom: segment.bottom, top: segment.top },
        color: WALL_COLOR,
        blocking: true,
        opacity: 1,
      });
    });
  }

  // Leaves. A door is drawn where it comes to rest when open, a window is glazed,
  // and a pocket door contributes nothing because its leaf is inside the wall.
  const wallsById = new Map(floor.walls.map((w) => [w.id, w]));
  for (const opening of floor.openings) {
    const wall = wallsById.get(opening.wallId);
    if (!wall) continue;
    const panel = leafPanel(wall, opening);
    if (!panel) continue;

    const glazing = leafOf(opening).style === 'pane';
    solids.push({
      id: `${opening.id}:leaf`,
      floorId: floor.id,
      ref: { kind: 'opening', id: opening.id },
      outline: panel,
      span: openingSpan(opening),
      color: glazing ? GLAZING_COLOR : LEAF_COLOR,
      // Glass stops you; a door standing open does not. At an ordinary window the
      // sill wall below already blocks, so this only decides the case that should
      // decide differently — full-height glazing, which you cannot walk through.
      // A door leaf is drawn open, and treating it as solid would narrow a doorway
      // by however far it happens to have been swung.
      blocking: glazing,
      opacity: glazing ? GLAZING_OPACITY : 1,
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
      floorId: floor.id,
      ref: { kind: 'placement', id: placement.id },
      outline: worldOutline(placement, item),
      span: clamped,
      color: placement.overrides?.color ?? item.color ?? DEFAULT_PLACEMENT_COLOR,
      blocking: true,
      opacity: 1,
    });
  }

  for (const room of floor.rooms) {
    slabs.push({
      id: `${room.id}:floor`,
      floorId: floor.id,
      kind: 'floor',
      roomId: room.id,
      boundary: room.boundary,
      elevationMm: 0,
      color: room.floorColor ?? FLOOR_COLOR,
    });
    slabs.push({
      id: `${room.id}:ceiling`,
      floorId: floor.id,
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

/**
 * Opacity for a floor that is not the one being edited.
 *
 * Enough to read as structure, little enough to see the active floor through. Every
 * floor drawn opaque is a building with a roof on it, which answers no question.
 */
export const OTHER_FLOOR_OPACITY = 0.22;

/**
 * Several floors stacked at their real elevations, for the space view.
 *
 * Each floor is built by `buildScene` in its own frame and then shifted by its
 * elevation relative to the active floor's datum — so the active floor keeps the
 * coordinates everything else in the application uses, and the storeys above and
 * below arrive where they belong without a second geometry path.
 *
 * **Display only.** The walker is fed `blockersOf(buildScene(doc, activeFloor))` and
 * always has been; feeding it this would make traversal depend on a view setting, and
 * would have you colliding with the walls of a floor you are only looking at. Floors
 * default to `elevationMm: 0`, so before an elevation is set that collision would be
 * with invisible walls in the same band as your own.
 *
 * Non-active floors lose their ceilings — the slab of the floor above is the ceiling,
 * and a lid over every storey would hide the stack that is the point of the view.
 */
export function buildStack(
  doc: SpaceDocument,
  floors: readonly Floor[],
  activeFloorId: Id,
): SceneModel {
  const active = floors.find((f) => f.id === activeFloorId) ?? floors[0];
  const datum = active?.elevationMm ?? 0;

  const solids: SceneSolid[] = [];
  const slabs: SceneSlab[] = [];
  let ceilingHeightMm = 0;

  for (const floor of floors) {
    const scene = buildScene(doc, floor);
    const dz = floor.elevationMm - datum;
    const isActive = floor.id === activeFloorId;

    for (const solid of scene.solids) {
      solids.push({
        ...solid,
        id: `${floor.id}/${solid.id}`,
        span: { bottom: solid.span.bottom + dz, top: solid.span.top + dz },
        opacity: isActive ? solid.opacity : Math.min(solid.opacity, OTHER_FLOOR_OPACITY),
      });
    }

    for (const slab of scene.slabs) {
      if (!isActive && slab.kind === 'ceiling') continue;
      slabs.push({ ...slab, id: `${floor.id}/${slab.id}`, elevationMm: slab.elevationMm + dz });
    }

    ceilingHeightMm = Math.max(ceilingHeightMm, dz + scene.ceilingHeightMm);
  }

  return {
    solids,
    slabs,
    // Framed across every floor shown, or the camera fits one storey and clips the rest.
    bounds: sceneBounds(solids, floors.flatMap((f) => f.rooms)),
    ceilingHeightMm: Math.max(ceilingHeightMm, 1),
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
