/**
 * The 512px plan render that rides in the `.space` container. See PLAN.md §5.
 *
 * Split in two on purpose, and the seam is the point: everything that decides *what*
 * the picture contains and *where* each shape lands is here, pure and tested; the
 * `ctx.fill()` calls that turn those numbers into pixels live in `ui/thumbnail.ts`.
 *
 * ## Why not `stage.toDataURL()`
 *
 * Konva can hand back a raster of exactly what is on screen, and it is the wrong
 * source. It couples saving to the plan view being mounted — there is no stage at all
 * in 3D mode, and saving from there would silently produce a file with no thumbnail —
 * and it captures the current pan and zoom, so the picture is whatever corner of the
 * plan you happened to be looking at rather than the plan.
 *
 * ## The active floor, and nothing under it
 *
 * One floor, the one you are editing, framed on its own extent. The ghost underlay is
 * excluded for the same reason it is excluded from `floorBounds`: it is not this
 * floor's content, and letting it into the frame would make a small upstairs render
 * at the scale of the storey below it.
 *
 * An empty floor gets **no thumbnail** rather than a blank square. A 512px field of
 * background colour in every file is not information, and `writeSpace` already treats
 * the entry as optional.
 */

import type { Bounds, Polygon } from './geometry/polygon';
import { bounds } from './geometry/polygon';
import type { Vec2 } from './geometry/vec';
import { wallOutline } from './geometry/wall';
import { worldOutline } from './placement';
import { findItem, type Floor, type SpaceDocument } from './document';

export const THUMBNAIL_PX = 512;
export const THUMBNAIL_PADDING_PX = 16;

/** Document millimetres to thumbnail pixels: `p * scale + {x,y}`. */
export type ThumbnailFit = {
  scale: number;
  x: number;
  y: number;
  size: number;
};

/**
 * Frame a document extent in a square of `size` pixels.
 *
 * Uniform scale and centred, so a long thin apartment keeps its proportions instead
 * of being stretched to fill the square. A degenerate extent — a single wall, which
 * has zero height in one axis — would divide by zero, so each side is floored at 1mm;
 * the result is a legible line rather than an exception at save time.
 */
export function thumbnailFit(
  box: Bounds,
  size = THUMBNAIL_PX,
  paddingPx = THUMBNAIL_PADDING_PX,
): ThumbnailFit {
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const avail = Math.max(1, size - paddingPx * 2);
  const scale = Math.min(avail / w, avail / h);

  return {
    scale,
    x: (size - w * scale) / 2 - box.minX * scale,
    y: (size - h * scale) / 2 - box.minY * scale,
    size,
  };
}

function project(fit: ThumbnailFit, poly: Polygon): Vec2[] {
  return poly.pts.map((p) => ({ x: p.x * fit.scale + fit.x, y: p.y * fit.scale + fit.y }));
}

/** Every ring the thumbnail draws, already in pixels, in painting order. */
export type ThumbnailShapes = {
  rooms: Vec2[][];
  walls: Vec2[][];
  placements: Vec2[][];
};

/**
 * The extent a thumbnail of this floor would be framed on.
 *
 * Deliberately not `store.floorBounds`: that is the zoom-to-fit extent and covers
 * rooms and walls only. A plan whose furniture sticks past its walls — an island of
 * placements with no structure yet, which is exactly what an inventory-first document
 * looks like — would otherwise render with the furniture cropped off or, with no walls
 * at all, produce no thumbnail while plainly having content.
 */
export function thumbnailBounds(doc: SpaceDocument, floor: Floor): Bounds | null {
  const boxes: Bounds[] = [];

  for (const room of floor.rooms) boxes.push(bounds(room.boundary));
  for (const wall of floor.walls) {
    try {
      boxes.push(bounds(wallOutline(wall)));
    } catch {
      // A degenerate wall has no extent to contribute and must not stop a save.
    }
  }
  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item) continue;
    try {
      boxes.push(bounds(worldOutline(placement, item)));
    } catch {
      // Same: a placement we cannot outline is skipped, not thrown over.
    }
  }

  const first = boxes[0];
  if (!first) return null;

  return boxes.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX),
    minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX),
    maxY: Math.max(acc.maxY, b.maxY),
  }));
}

export function thumbnailShapes(
  doc: SpaceDocument,
  floor: Floor,
  fit: ThumbnailFit,
): ThumbnailShapes {
  const rooms: Vec2[][] = [];
  const walls: Vec2[][] = [];
  const placements: Vec2[][] = [];

  for (const room of floor.rooms) rooms.push(project(fit, room.boundary));

  for (const wall of floor.walls) {
    try {
      walls.push(project(fit, wallOutline(wall)));
    } catch {
      // Degenerate — nothing to draw.
    }
  }

  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item) continue;
    try {
      placements.push(project(fit, worldOutline(placement, item)));
    } catch {
      // Same.
    }
  }

  return { rooms, walls, placements };
}
