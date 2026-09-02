/**
 * Plan tools, and what their drafts commit to. See PLAN.md §8.
 *
 * A *draft* is the in-progress gesture — the wall chain you are part way through, the
 * rectangle you are dragging out. It lives in editor state and is never written to
 * the document, so a drag that fires four hundred mousemoves still produces exactly
 * one undo step: the commit.
 *
 * Everything here is pure. `commitWallChain` and friends take a draft and return
 * entities; the store applies them inside a single recorded mutation.
 */

import {
  DEFAULT_CEILING_HEIGHT_MM,
  DEFAULT_WALL_HEIGHT_MM,
  DEFAULT_WALL_THICKNESS_MM,
  type Id,
  type Room,
  type Wall,
} from './document';
import { generatePolygon, type FootprintGenerator } from './geometry/generators';
import { area, ensureCounterClockwise, polygon, roundPolygon, translate } from './geometry/polygon';
import { isDegenerate } from './geometry/wall';
import type { Vec2 } from './geometry/vec';

export const PLAN_TOOLS = ['select', 'wall', 'room', 'shape', 'dimension'] as const;
export type PlanTool = (typeof PLAN_TOOLS)[number];

export const PLAN_TOOL_LABELS: Record<PlanTool, string> = {
  select: 'Select',
  wall: 'Wall',
  room: 'Room',
  shape: 'Shape',
  dimension: 'Measure',
};

/** Single-key shortcuts, matching the first letter where it is free. */
export const PLAN_TOOL_KEYS: Record<PlanTool, string> = {
  select: 'v',
  wall: 'w',
  room: 'r',
  shape: 's',
  dimension: 'd',
};

/**
 * Shapes the shape tool can draw, drag-sized by their bounding box.
 *
 * These are the same generators the furniture footprints use — "account for all
 * common shapes" is one list, not two.
 */
export const SHAPE_KINDS = [
  'rect',
  'rounded',
  'circle',
  'ellipse',
  'lshape',
  'ushape',
  'trapezoid',
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_KIND_LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  rounded: 'Rounded',
  circle: 'Circle',
  ellipse: 'Ellipse',
  lshape: 'L-shape',
  ushape: 'U-shape',
  trapezoid: 'Trapezoid',
};

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type Draft =
  /** Click-to-place chain; `cursor` is the rubber-band end, absent before first move. */
  | { tool: 'wall'; points: Vec2[]; cursor: Vec2 | null }
  | { tool: 'room'; start: Vec2; cursor: Vec2 }
  | { tool: 'shape'; kind: ShapeKind; start: Vec2; cursor: Vec2 }
  | { tool: 'dimension'; start: Vec2; cursor: Vec2 };

export type IdFactory = () => Id;

export function newId(): Id {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Wall chain
// ---------------------------------------------------------------------------

export type WallDefaults = {
  thicknessMm: number;
  heightMm: number;
};

export const DEFAULT_WALL_DEFAULTS: WallDefaults = {
  thicknessMm: DEFAULT_WALL_THICKNESS_MM,
  heightMm: DEFAULT_WALL_HEIGHT_MM,
};

/**
 * Turn a chain of clicked points into walls.
 *
 * Degenerate segments are dropped rather than stored: a double-click while drawing
 * produces a repeated point, and a zero-length wall has no outline, no angle and no
 * meaningful place to host an opening.
 */
export function commitWallChain(
  points: readonly Vec2[],
  defaults: WallDefaults = DEFAULT_WALL_DEFAULTS,
  makeId: IdFactory = newId,
): Wall[] {
  const walls: Wall[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = roundPoint(points[i]!);
    const b = roundPoint(points[i + 1]!);
    if (isDegenerate({ a, b, thicknessMm: defaults.thicknessMm })) continue;

    walls.push({
      id: makeId(),
      a,
      b,
      thicknessMm: defaults.thicknessMm,
      heightMm: defaults.heightMm,
      baseElevationMm: 0,
    });
  }
  return walls;
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

/** A dragged rectangle, normalized so width and depth are positive. */
export function rectFromDrag(start: Vec2, end: Vec2): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  depth: number;
} {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  return { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY };
}

/** Below this in either axis, a drag was a stray click, not a room. */
export const MIN_ROOM_SIDE_MM = 100;

/**
 * A rectangular room: the boundary *and* the four walls around it.
 *
 * Both, because a room boundary alone has nothing to extrude in the 3D view and
 * nothing to snap furniture against — drawing a room and finding the space still open
 * on every side would be the wrong surprise. The walls run on the boundary, so the
 * boundary is the centreline rectangle, not the inner face.
 *
 * Room *detection* from arbitrary wall loops is phase 8; this is the explicit path.
 */
export function commitRoomRect(
  start: Vec2,
  end: Vec2,
  options: {
    name: string;
    ceilingHeightMm?: number;
    walls?: WallDefaults;
    makeId?: IdFactory;
  },
): { room: Room; walls: Wall[] } | null {
  const r = rectFromDrag(start, end);
  if (r.width < MIN_ROOM_SIDE_MM || r.depth < MIN_ROOM_SIDE_MM) return null;

  const makeId = options.makeId ?? newId;
  const wallDefaults = options.walls ?? DEFAULT_WALL_DEFAULTS;

  const corners: Vec2[] = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ].map(roundPoint);

  const boundary = ensureCounterClockwise(polygon(corners));
  const room: Room = {
    id: makeId(),
    name: options.name,
    boundary,
    ceilingHeightMm: options.ceilingHeightMm ?? DEFAULT_CEILING_HEIGHT_MM,
    areaMm2: Math.round(area(boundary)),
  };

  const walls = commitWallChain([...corners, corners[0]!], wallDefaults, makeId);
  return { room, walls };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * The generator for a shape drag-sized to a bounding box.
 *
 * Returns the generator rather than the polygon so the caller can preview and commit
 * from the same source, and so a future "make this circle 900mm" edit has parameters
 * to work with.
 */
export function shapeGenerator(kind: ShapeKind, width: number, depth: number): FootprintGenerator {
  const w = Math.max(1, width);
  const d = Math.max(1, depth);

  switch (kind) {
    case 'rect':
      return { kind: 'rect', w, d };
    case 'rounded':
      return { kind: 'rect', w, d, cornerRadius: Math.min(w, d) / 6 };
    case 'circle':
      return { kind: 'circle', r: Math.min(w, d) / 2 };
    case 'ellipse':
      return { kind: 'ellipse', rx: w / 2, ry: d / 2 };
    case 'lshape':
      return { kind: 'lshape', w, d, cutW: w / 2, cutD: d / 2, corner: 'ne' };
    case 'ushape':
      return { kind: 'ushape', w, d, armW: Math.max(1, Math.min(w / 3, d / 2)), openSide: 'n' };
    case 'trapezoid':
      return { kind: 'trapezoid', wTop: w / 2, wBottom: w, d };
  }
}

/** The shape's boundary, positioned in the dragged box. */
export function shapeBoundary(kind: ShapeKind, start: Vec2, end: Vec2) {
  const r = rectFromDrag(start, end);
  const gen = shapeGenerator(kind, r.width, r.depth);
  const centre = { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
  return roundPolygon(translate(generatePolygon(gen), centre));
}

/**
 * A non-rectangular room: boundary only, no walls.
 *
 * A tessellated circle would otherwise become 64 walls, each with its own id, angle
 * and opening space — a mess to select, save and extrude. Draw the curved boundary,
 * then run the wall tool along the straight parts you actually want built.
 */
export function commitShapeRoom(
  kind: ShapeKind,
  start: Vec2,
  end: Vec2,
  options: { name: string; ceilingHeightMm?: number; makeId?: IdFactory },
): Room | null {
  const r = rectFromDrag(start, end);
  if (r.width < MIN_ROOM_SIDE_MM || r.depth < MIN_ROOM_SIDE_MM) return null;

  const boundary = ensureCounterClockwise(shapeBoundary(kind, start, end));
  return {
    id: (options.makeId ?? newId)(),
    name: options.name,
    boundary,
    ceilingHeightMm: options.ceilingHeightMm ?? DEFAULT_CEILING_HEIGHT_MM,
    areaMm2: Math.round(area(boundary)),
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Round to integer millimetres — at the commit boundary only.
 *
 * Rounding during a drag makes the geometry jitter against the cursor, because a
 * pointer moving one screen pixel at low zoom crosses many millimetres at once.
 * Drafts stay in floats; the document is always integers.
 */
export function roundPoint(p: Vec2): Vec2 {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
