/**
 * What an opening's leaf does. See PLAN.md §4.4, §9.2 and §10.1.
 *
 * Phase 5 cut the hole; this is the door that lives in it. Five kinds of opening
 * behave in four different ways, and the difference is not decoration — it is the
 * whole reason the kinds exist:
 *
 * | kind     | leaf                         | what has to stay clear            |
 * |----------|------------------------------|-----------------------------------|
 * | `door`   | hinged, swings into a room   | the swept sector                  |
 * | `sliding`| slides across the wall face  | the wall it parks over, room-side |
 * | `pocket` | slides *into* the wall       | nothing in the room               |
 * | `cased`  | none                         | nothing                           |
 * | `window` | fixed glazing                | nothing                           |
 *
 * A pocket door needing no room-side clearance is the entire argument for fitting
 * one, so a model that drew it the same as a sliding door would be answering the
 * question wrong rather than approximately.
 *
 * ## One stored field, a kind-aware reading of it
 *
 * The document stores `Opening.swing` — `{ hinge, into, angleDeg }` — and nothing
 * else. Everything here reads it through `leafOf`, which returns a shape named for
 * the *leaf* rather than the swing, and which structurally omits what does not
 * apply: a sliding leaf has no `angleDeg` to read, a pocket leaf has no `face`. That
 * is what stops a sliding door from quietly acquiring a swing angle nobody set.
 *
 * The stored field is **kept across a kind change**. A door turned into a cased
 * opening and back is the door you had, hinged on the same side, rather than one
 * re-seeded from defaults. The cost is a `swing` sitting unread on a cased opening
 * in the file; the alternative is losing a choice the user made, silently.
 *
 * ## The hinge is on the face, not the centreline
 *
 * A door hangs in the jamb on the side it opens onto, so the pivot sits half a wall
 * thickness off the centreline. On a 114mm wall that is 57mm — invisible in a
 * drawing, and a systematic bias in every clearance answer if it is skipped.
 *
 * ## Clearance is tested against placements only
 *
 * PLAN.md §9.2 says "object volumes", and it means furniture. A door swinging back
 * to rest against the adjacent wall is how doors are hung, not a fault, and testing
 * the sweep against walls would fire on every door in a corner. Walls are what the
 * opening is *in*; they are not in its way.
 */

import type { Opening, OpeningKind, Wall } from './document';
import type { Span, Volume } from './geometry/collision';
import { ensureCounterClockwise, polygon, type Polygon } from './geometry/polygon';
import { add, normalize, perp, rotate, scale, sub, toRadians, type Vec2 } from './geometry/vec';
import { isDegenerate, wallLength } from './geometry/wall';
import { OPENING_KIND_LABELS, openingRange, openingSpan, rangesOverlap, type Range } from './openings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A door leaf is 35mm; a 1-3/8" interior slab is 35mm exactly. */
export const LEAF_THICKNESS_MM = 35;

/** How far a surface-mounted sliding leaf stands off the wall it runs across. */
export const SLIDE_STANDOFF_MM = 20;

/**
 * A door that opens less than this is a door that does not open; one that opens
 * more than 180° has gone through the wall.
 */
export const MIN_SWING_DEG = 15;
export const MAX_SWING_DEG = 180;

/**
 * How finely the swept sector is polygonised — roughly one vertex per 5°.
 *
 * Not a cosmetic setting. The sector is a *collision* polygon, and a chord cuts
 * inside the true arc: too few vertices and a narrow object sitting at the outer
 * edge of the sweep falls into the gap between chord and arc and is never reported.
 * At 5° the sagitta on an 813mm leaf is under 1mm.
 */
export const ARC_STEP_DEG = 5;

// ---------------------------------------------------------------------------
// The leaf
// ---------------------------------------------------------------------------

export type LeafStyle = 'hinged' | 'sliding' | 'pocket' | 'pane' | 'none';

export const LEAF_STYLE: Record<OpeningKind, LeafStyle> = {
  door: 'hinged',
  window: 'pane',
  cased: 'none',
  pocket: 'pocket',
  sliding: 'sliding',
};

/** The stored field, non-optional. */
export type Swing = NonNullable<Opening['swing']>;

export const DEFAULT_SWING: Swing = { hinge: 'a', into: 'front', angleDeg: 90 };

/**
 * The leaf, read for the kind the opening actually is.
 *
 * `pivot` is the end of the opening the leaf is fixed at — hinged there for a door,
 * parked there when open for a slider. `face` is the side of the wall it lies on:
 * `front` is the `perp(direction)` side, which is the wall's left as you look from
 * `a` toward `b`, and is what the 2D arc draws so nobody has to hold it in their head.
 */
export type Leaf =
  | { style: 'hinged'; pivot: 'a' | 'b'; face: 'front' | 'back'; angleDeg: number }
  | { style: 'sliding'; pivot: 'a' | 'b'; face: 'front' | 'back' }
  | { style: 'pocket'; pivot: 'a' | 'b' }
  | { style: 'pane' }
  | { style: 'none' };

export function clampSwingAngle(deg: number): number {
  if (!Number.isFinite(deg)) return DEFAULT_SWING.angleDeg;
  return Math.round(Math.max(MIN_SWING_DEG, Math.min(MAX_SWING_DEG, deg)));
}

export function leafOf(opening: Opening): Leaf {
  const swing = opening.swing ?? DEFAULT_SWING;
  switch (LEAF_STYLE[opening.kind]) {
    case 'hinged':
      return {
        style: 'hinged',
        pivot: swing.hinge,
        face: swing.into,
        angleDeg: clampSwingAngle(swing.angleDeg),
      };
    case 'sliding':
      return { style: 'sliding', pivot: swing.hinge, face: swing.into };
    case 'pocket':
      return { style: 'pocket', pivot: swing.hinge };
    case 'pane':
      return { style: 'pane' };
    case 'none':
      return { style: 'none' };
  }
}

export const LEAF_STYLE_LABELS: Record<LeafStyle, string> = {
  hinged: 'Hinged',
  sliding: 'Slides across the wall',
  pocket: 'Slides into the wall',
  pane: 'Fixed glazing',
  none: 'No leaf',
};

/** A leaf that is fixed at one end of the opening and moves. */
export type MovingLeaf = Extract<Leaf, { pivot: 'a' | 'b' }>;

/**
 * The leaf, when there is one to hang. Null for a cased opening or a window.
 *
 * The narrowing is the point: a caller that gets a `MovingLeaf` back can ask which
 * end it is fixed at without a cast, and still cannot read an angle off a slider.
 * This is what the properties panel offers its controls on.
 */
export function movingLeafOf(opening: Opening): MovingLeaf | null {
  const leaf = leafOf(opening);
  return leaf.style === 'pane' || leaf.style === 'none' ? null : leaf;
}

// ---------------------------------------------------------------------------
// The wall frame
// ---------------------------------------------------------------------------

type WallFrame = {
  dir: Vec2;
  /** The `front` side normal. */
  normal: Vec2;
  halfThickness: number;
  length: number;
};

function frameOf(wall: Wall): WallFrame | null {
  if (isDegenerate(wall)) return null;
  const dir = normalize(sub(wall.b, wall.a));
  return {
    dir,
    normal: perp(dir),
    halfThickness: wall.thicknessMm / 2,
    length: wallLength(wall),
  };
}

/** A point on the wall: `t` mm along the centreline, `offset` mm to the front side. */
function pointOn(wall: Wall, frame: WallFrame, t: number, offset: number): Vec2 {
  return {
    x: wall.a.x + frame.dir.x * t + frame.normal.x * offset,
    y: wall.a.y + frame.dir.y * t + frame.normal.y * offset,
  };
}

/** Along-wall coordinate of the leaf's fixed end. */
function pivotAt(opening: Opening, pivot: 'a' | 'b'): number {
  const range = openingRange(opening);
  return pivot === 'a' ? range.from : range.to;
}

function faceSign(face: 'front' | 'back'): number {
  return face === 'front' ? 1 : -1;
}

/**
 * Which way the leaf turns, as a sign on the rotation.
 *
 * The closed leaf points from its pivot toward the far jamb: `+dir` from the `a`
 * end, `−dir` from the `b` end. Opening it turns that vector onto the face normal,
 * and `rotate` is counter-clockwise, so reaching `+perp(dir)` from `+dir` is a
 * positive turn and every other combination flips one sign.
 */
function turnSign(pivot: 'a' | 'b', face: 'front' | 'back'): number {
  return (pivot === 'a' ? 1 : -1) * faceSign(face);
}

function closedDirection(frame: WallFrame, pivot: 'a' | 'b'): Vec2 {
  return pivot === 'a' ? frame.dir : scale(frame.dir, -1);
}

/** A rectangle `thickness` wide about the segment `from → to`. */
function slab(from: Vec2, to: Vec2, thickness: number): Polygon | null {
  const along = sub(to, from);
  if (along.x === 0 && along.y === 0) return null;
  const n = scale(perp(normalize(along)), thickness / 2);
  return ensureCounterClockwise(
    polygon([add(from, n), add(to, n), sub(to, n), sub(from, n)]),
  );
}

// ---------------------------------------------------------------------------
// Swept area
// ---------------------------------------------------------------------------

/**
 * The sector a hinged leaf sweeps, from closed to fully open, as a plan polygon.
 *
 * Null for every other style — a slider sweeps nothing. Drawn as the door symbol in
 * 2D (its boundary *is* the closed leaf, the arc, and the open leaf) and tested
 * against furniture in 3D. One polygon, two consumers, no second formula.
 */
export function swingSweep(wall: Wall, opening: Opening): Polygon | null {
  const leaf = leafOf(opening);
  if (leaf.style !== 'hinged') return null;
  const frame = frameOf(wall);
  if (!frame || opening.widthMm <= 0) return null;

  const hinge = pointOn(
    wall,
    frame,
    pivotAt(opening, leaf.pivot),
    frame.halfThickness * faceSign(leaf.face),
  );
  const base = closedDirection(frame, leaf.pivot);
  const sign = turnSign(leaf.pivot, leaf.face);
  const steps = Math.max(2, Math.ceil(leaf.angleDeg / ARC_STEP_DEG));

  const pts: Vec2[] = [hinge];
  for (let i = 0; i <= steps; i++) {
    const turned = rotate(base, sign * toRadians((leaf.angleDeg * i) / steps));
    pts.push(add(hinge, scale(turned, opening.widthMm)));
  }
  return ensureCounterClockwise(polygon(pts));
}

/** The leaf itself, where it comes to rest when open. Null when there is nothing to draw. */
export function leafPanel(wall: Wall, opening: Opening): Polygon | null {
  const leaf = leafOf(opening);
  const frame = frameOf(wall);
  if (!frame || opening.widthMm <= 0) return null;

  switch (leaf.style) {
    case 'hinged': {
      const hinge = pointOn(
        wall,
        frame,
        pivotAt(opening, leaf.pivot),
        frame.halfThickness * faceSign(leaf.face),
      );
      const turned = rotate(
        closedDirection(frame, leaf.pivot),
        turnSign(leaf.pivot, leaf.face) * toRadians(leaf.angleDeg),
      );
      return slab(hinge, add(hinge, scale(turned, opening.widthMm)), LEAF_THICKNESS_MM);
    }
    case 'sliding': {
      // Standing off the wall face by the runner gap, so it does not z-fight with
      // the wall it parks over.
      const run = parkRun(opening, leaf.pivot);
      const offset =
        (frame.halfThickness + SLIDE_STANDOFF_MM + LEAF_THICKNESS_MM / 2) * faceSign(leaf.face);
      return slab(
        pointOn(wall, frame, run.from, offset),
        pointOn(wall, frame, run.to, offset),
        LEAF_THICKNESS_MM,
      );
    }
    case 'pocket':
      // Inside the wall cavity. There is nothing to see, and drawing it would put a
      // slab inside a solid — `pocketFitReason` is how a pocket door is checked.
      return null;
    case 'pane':
      // Glazing, filling the opening in the plane of the wall.
      return slab(
        pointOn(wall, frame, openingRange(opening).from, 0),
        pointOn(wall, frame, openingRange(opening).to, 0),
        LEAF_THICKNESS_MM / 2,
      );
    case 'none':
      return null;
  }
}

/**
 * The stretch of wall a sliding or pocket leaf occupies when open, in mm from `a`.
 *
 * One leaf width beyond the jamb it parks at — which is why a sliding door needs as
 * much wall beside it as the door is wide, and why one placed too near a corner has
 * nowhere to go.
 */
export function parkRun(opening: Opening, pivot: 'a' | 'b'): Range {
  const range = openingRange(opening);
  return pivot === 'a'
    ? { from: range.from - opening.widthMm, to: range.from }
    : { from: range.to, to: range.to + opening.widthMm };
}

// ---------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------

/**
 * The volume this opening's leaf needs kept clear of furniture, or null when it
 * needs none.
 *
 * The vertical extent is the opening's own — a door blocks from its sill to its
 * head, so a rug under it is not in the way and a bookcase beside it is. That is the
 * same span/footprint pair every other collision in the application uses, which is
 * why this can be handed straight to `volumesCollide`.
 */
export function clearanceVolume(wall: Wall, opening: Opening): Volume | null {
  const leaf = leafOf(opening);
  const span: Span = openingSpan(opening);

  if (leaf.style === 'hinged') {
    const sweep = swingSweep(wall, opening);
    return sweep ? { outline: sweep, span } : null;
  }
  if (leaf.style === 'sliding') {
    const panel = leafPanel(wall, opening);
    return panel ? { outline: panel, span } : null;
  }
  // A pocket door parks inside the wall, a cased opening has no leaf, and a window
  // pane does not move. None of them can be obstructed by anything in the room.
  return null;
}

/**
 * Why a pocket door has nowhere to slide, or null when it has.
 *
 * The one check that makes a pocket door more than a rendering variant: the cavity
 * has to exist. It needs a full leaf width of wall beyond the jamb, and that stretch
 * has to be solid — another opening in it means the two share a cavity, which is a
 * wall that cannot be built.
 */
export function pocketFitReason(
  wall: Wall,
  opening: Opening,
  siblings: readonly Opening[],
): string | null {
  const leaf = leafOf(opening);
  if (leaf.style !== 'pocket') return null;

  const frame = frameOf(wall);
  if (!frame) return null;
  const run = parkRun(opening, leaf.pivot);
  const label = OPENING_KIND_LABELS[opening.kind];

  if (run.from < 0 || run.to > frame.length) {
    const short = Math.round(run.from < 0 ? -run.from : run.to - frame.length);
    return `${label} needs ${opening.widthMm}mm of wall to slide into and is ${short}mm short of it.`;
  }
  for (const other of siblings) {
    if (other.id === opening.id || other.wallId !== opening.wallId) continue;
    if (rangesOverlap(run, openingRange(other))) {
      return `${label} would slide into ${OPENING_KIND_LABELS[other.kind].toLowerCase()}.`;
    }
  }
  return null;
}
