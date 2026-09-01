/**
 * A footprint pairs a parametric generator with its emitted polygon.
 *
 * The generator keeps shapes editable; the cached `outline` is the single thing that
 * snapping, collision, clearance, area and 3D extrusion all consume (PLAN.md §4.1).
 */

import { generatePolygon, type FootprintGenerator } from './generators';
import { bounds, depth, roundPolygon, width, type Polygon } from './polygon';

export type Footprint = {
  generator: FootprintGenerator;
  /** Derived from `generator`, rounded to integer mm. Never edited directly. */
  outline: Polygon;
};

export function makeFootprint(generator: FootprintGenerator): Footprint {
  return { generator, outline: roundPolygon(generatePolygon(generator)) };
}

/** Extent along local x at rotation 0. */
export function footprintWidth(footprint: Footprint): number {
  return width(footprint.outline);
}

/** Extent along local y at rotation 0. */
export function footprintDepth(footprint: Footprint): number {
  return depth(footprint.outline);
}

export function footprintBounds(footprint: Footprint) {
  return bounds(footprint.outline);
}

/** A plain rectangle, by far the most common case. */
export function rectFootprint(w: number, d: number): Footprint {
  return makeFootprint({ kind: 'rect', w, d });
}
