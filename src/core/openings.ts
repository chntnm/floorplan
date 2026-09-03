/**
 * Openings, and the wall geometry they leave behind. See PLAN.md §4.4 and §10.1.
 *
 * An opening is stored against a wall as an offset along its centreline, a width, a
 * height and a sill — not as a hole polygon. That is what a plan actually records,
 * and it is what keeps a door attached to its wall when the wall is dragged.
 *
 * **`wallSegments` is the load-bearing function in this file**, and the reason phase
 * 5 does not need a CSG library. An opening cuts a wall in *elevation*, not in plan:
 * a doorway removes a rectangle from the wall's face, leaving the wall on either side
 * of it, a lintel above it, and — for a window — a sill below it. Those pieces are
 * all boxes. So instead of subtracting geometry, the wall is *split* into the boxes
 * that remain:
 *
 *     ┌──────────────────────────────────────┐
 *     │            │   lintel    │           │   ← above the opening
 *     │   flank    ├─────────────┤   flank   │
 *     │            │   (gap)     │           │
 *     │            │             │           │
 *     └──────────────────────────────────────┘
 *
 * The same list then serves three consumers: the 3D view extrudes it, the walker
 * collides against it, and the validation panel measures it. A doorway is passable
 * because the only solid above it — the lintel — starts at 2032mm, which is above the
 * walker's head. No special case, no "is this a door" check anywhere in traversal.
 */

import type { Opening, OpeningKind, Wall } from './document';
import type { Span } from './geometry/collision';
import { ensureCounterClockwise, polygon, type Polygon } from './geometry/polygon';
import { normalize, perp, sub, type Vec2 } from './geometry/vec';
import { isDegenerate, wallLength } from './geometry/wall';

export const OPENING_KINDS: readonly OpeningKind[] = [
  'door',
  'window',
  'cased',
  'pocket',
  'sliding',
] as const;

export const OPENING_KIND_LABELS: Record<OpeningKind, string> = {
  door: 'Door',
  window: 'Window',
  cased: 'Cased opening',
  pocket: 'Pocket door',
  sliding: 'Sliding door',
};

export type OpeningDefaults = {
  widthMm: number;
  heightMm: number;
  sillMm: number;
};

/**
 * Standard North American sizes, in the units they were actually specified in.
 *
 * A 32" × 80" door is 813 × 2032mm, not "about 800 × 2000" — the same reasoning as
 * the preset library, where a queen bed is 1524 × 2032 because it is 60" × 80".
 * Rounding these to friendly metric numbers would mean every door in a traced US
 * plan is subtly the wrong size.
 */
export const OPENING_DEFAULTS: Record<OpeningKind, OpeningDefaults> = {
  door: { widthMm: 813, heightMm: 2032, sillMm: 0 }, // 32" × 80"
  window: { widthMm: 914, heightMm: 1219, sillMm: 914 }, // 36" × 48", sill 36"
  cased: { widthMm: 914, heightMm: 2032, sillMm: 0 }, // 36" × 80"
  pocket: { widthMm: 813, heightMm: 2032, sillMm: 0 },
  sliding: { widthMm: 1829, heightMm: 2032, sillMm: 0 }, // 6'0" patio
};

/** Narrower than this and it is not an opening anyone could pass through or fit. */
export const MIN_OPENING_WIDTH_MM = 50;
export const MIN_OPENING_HEIGHT_MM = 50;

export class OpeningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningError';
  }
}

// ---------------------------------------------------------------------------
// Along-wall ranges
// ---------------------------------------------------------------------------

/** A span along a wall's centreline, in mm from `wall.a`. */
export type Range = { from: number; to: number };

/**
 * The opening's extent along the wall.
 *
 * `offsetMm` is the **leading edge**, measured from `wall.a` — the definition in
 * `Opening`'s own comment, and what the plan layer already draws.
 */
export function openingRange(opening: Opening): Range {
  return { from: opening.offsetMm, to: opening.offsetMm + opening.widthMm };
}

/**
 * The opening's vertical extent.
 *
 * `sillMm` is measured from the **floor datum**, not from the wall's own base — the
 * same reference `Placement.elevation` uses, so every height in the document is
 * comparable without knowing which entity it came from. A window at 914mm is 914mm
 * off the floor whether or not the wall it is in starts on a platform.
 */
export function openingSpan(opening: Opening): Span {
  return { bottom: opening.sillMm, top: opening.sillMm + opening.heightMm };
}

export function rangesOverlap(a: Range, b: Range): boolean {
  return a.from < b.to && b.from < a.to;
}

/**
 * The offset that centres an opening of `widthMm` on `centreMm`, clamped so the whole
 * opening stays on the wall.
 *
 * Clamping rather than refusing: clicking near the end of a wall means "put a door
 * here", and sliding it along until it fits is what a person would do anyway. An
 * opening wider than the wall is a different problem and is reported by validation.
 */
export function clampOffset(centreMm: number, widthMm: number, wallLengthMm: number): number {
  const max = wallLengthMm - widthMm;
  if (max <= 0) return 0;
  return Math.round(Math.max(0, Math.min(max, centreMm - widthMm / 2)));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build an opening centred on a point along a wall.
 *
 * Throws when the wall physically cannot hold it — a 1829mm patio door will not go in
 * a 900mm wall, and silently shrinking it would produce a door nobody asked for.
 */
export function createOpening(params: {
  id: string;
  wall: Wall;
  kind: OpeningKind;
  centreMm: number;
  size?: Partial<OpeningDefaults>;
}): Opening {
  const base = OPENING_DEFAULTS[params.kind];
  const widthMm = Math.round(params.size?.widthMm ?? base.widthMm);
  const heightMm = Math.round(params.size?.heightMm ?? base.heightMm);
  const sillMm = Math.round(params.size?.sillMm ?? base.sillMm);

  if (isDegenerate(params.wall)) {
    throw new OpeningError('That wall is too short to hold an opening.');
  }
  const length = wallLength(params.wall);
  if (widthMm > length) {
    throw new OpeningError(
      `A ${OPENING_KIND_LABELS[params.kind].toLowerCase()} is ${widthMm}mm wide and this wall is ` +
        `only ${Math.round(length)}mm long.`,
    );
  }
  if (widthMm < MIN_OPENING_WIDTH_MM || heightMm < MIN_OPENING_HEIGHT_MM) {
    throw new OpeningError('An opening needs to be at least 50mm in each direction.');
  }

  return {
    id: params.id,
    wallId: params.wall.id,
    offsetMm: clampOffset(params.centreMm, widthMm, length),
    widthMm,
    heightMm,
    sillMm,
    kind: params.kind,
  };
}

// ---------------------------------------------------------------------------
// The wall that remains
// ---------------------------------------------------------------------------

/**
 * A solid box of wall: a run along the centreline and a vertical span.
 *
 * Elevations are absolute above the floor datum, so `baseElevationMm` is already
 * folded in and nothing downstream has to remember to add it.
 */
export type WallSegment = {
  /** mm from `wall.a` along the centreline. */
  from: number;
  to: number;
  /** mm above the floor datum. */
  bottom: number;
  top: number;
};

export function segmentIsEmpty(segment: WallSegment): boolean {
  return segment.to - segment.from <= 0 || segment.top - segment.bottom <= 0;
}

/**
 * Split a wall into the solid boxes left once its openings are removed.
 *
 * Openings are clamped to the wall and processed left to right. Two that overlap are
 * treated as one merged gap taking the *lower* sill and the *higher* head, because
 * that is the void a builder would actually be left with — overlapping openings are
 * reported separately by validation, and the geometry should not also pretend a jamb
 * exists between them.
 *
 * Returns segments in order along the wall. A wall with no openings returns exactly
 * one segment; the total area of the returned segments always equals the wall's face
 * area minus the area of the (clamped, merged) openings, which is the invariant the
 * tests hold this to.
 */
export function wallSegments(wall: Wall, openings: readonly Opening[]): WallSegment[] {
  const length = wallLength(wall);
  const base = wall.baseElevationMm;
  const top = base + wall.heightMm;
  if (length <= 0 || wall.heightMm <= 0) return [];

  // Clamp to the wall, drop anything that has fallen entirely off the end — a wall
  // dragged shorter leaves openings hanging past `b`, which validation reports and
  // the geometry simply does not build.
  const gaps = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => {
      const r = openingRange(o);
      const s = openingSpan(o);
      return {
        from: Math.max(0, Math.min(length, r.from)),
        to: Math.max(0, Math.min(length, r.to)),
        // Clipped to the wall vertically as well as along its length: an opening
        // taller than its wall removes what wall there is, not more.
        bottom: Math.max(base, s.bottom),
        top: Math.min(top, s.top),
      };
    })
    .filter((g) => g.to - g.from > 0 && g.top - g.bottom > 0)
    .sort((p, q) => p.from - q.from);

  // Merge overlaps so the walk below never sees a gap starting before the cursor.
  const merged: typeof gaps = [];
  for (const gap of gaps) {
    const last = merged[merged.length - 1];
    if (last && gap.from < last.to) {
      last.to = Math.max(last.to, gap.to);
      last.bottom = Math.min(last.bottom, gap.bottom);
      last.top = Math.max(last.top, gap.top);
    } else {
      merged.push({ ...gap });
    }
  }

  const segments: WallSegment[] = [];
  const push = (segment: WallSegment) => {
    if (!segmentIsEmpty(segment)) segments.push(segment);
  };

  let cursor = 0;
  for (const gap of merged) {
    push({ from: cursor, to: gap.from, bottom: base, top });
    // Below the opening (a window's sill wall) and above it (the lintel). Either can
    // be empty — a door has no sill wall, and an opening running to the ceiling has
    // no lintel — which `push` drops rather than emitting a zero-height box.
    push({ from: gap.from, to: gap.to, bottom: base, top: gap.bottom });
    push({ from: gap.from, to: gap.to, bottom: gap.top, top });
    cursor = gap.to;
  }
  push({ from: cursor, to: length, bottom: base, top });

  return segments;
}

/** Total solid face area of a wall, in mm² — the invariant `wallSegments` preserves. */
export function segmentArea(segments: readonly WallSegment[]): number {
  let total = 0;
  for (const s of segments) total += (s.to - s.from) * (s.top - s.bottom);
  return total;
}

/**
 * A segment as a plan polygon, `thicknessMm` wide about the wall's centreline.
 *
 * The same quad `wallOutline` produces, restricted to the segment's run — so a
 * segment and the wall it came from are flush by construction rather than by
 * agreeing on a formula in two places.
 */
export function segmentOutline(wall: Wall, segment: WallSegment): Polygon {
  const dir = normalize(sub(wall.b, wall.a));
  const half = wall.thicknessMm / 2;
  const n = perp(dir);

  const at = (t: number, side: number): Vec2 => ({
    x: wall.a.x + dir.x * t + n.x * half * side,
    y: wall.a.y + dir.y * t + n.y * half * side,
  });

  return ensureCounterClockwise(
    polygon([
      at(segment.from, 1),
      at(segment.to, 1),
      at(segment.to, -1),
      at(segment.from, -1),
    ]),
  );
}

/** The point on the wall centreline at the middle of an opening. */
export function openingCentre(wall: Wall, opening: Opening): Vec2 {
  const dir = normalize(sub(wall.b, wall.a));
  const t = opening.offsetMm + opening.widthMm / 2;
  return { x: wall.a.x + dir.x * t, y: wall.a.y + dir.y * t };
}

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------

/**
 * Why an opening does not fit its wall, or null when it does.
 *
 * Reported rather than corrected. Dragging a wall shorter is the usual cause, and
 * silently sliding somebody's front door along the wall to make it fit would be a
 * worse surprise than being told the door no longer fits.
 */
export function openingFitReason(wall: Wall, opening: Opening): string | null {
  const length = wallLength(wall);
  const range = openingRange(opening);
  const label = OPENING_KIND_LABELS[opening.kind];

  if (range.from < 0 || range.to > length) {
    return `${label} runs past the end of its wall — the wall is ${Math.round(length)}mm long.`;
  }
  if (opening.sillMm + opening.heightMm > wall.baseElevationMm + wall.heightMm) {
    return `${label} is taller than the wall it is in.`;
  }
  return null;
}
