/**
 * Shape generators. See PLAN.md §4.1.
 *
 * Each generator emits a `Polygon` centred on its own local origin. The generator is
 * retained on the footprint so shapes stay parametrically editable ("make this circle
 * 900mm"); the emitted polygon is what every algorithm downstream consumes.
 */

import { polygon, ensureCounterClockwise, type Polygon } from './polygon';
import type { Vec2 } from './vec';

export type Corner = 'nw' | 'ne' | 'se' | 'sw';
export type Side = 'n' | 'e' | 's' | 'w';

export type FootprintGenerator =
  | { kind: 'rect'; w: number; d: number; cornerRadius?: number }
  | { kind: 'circle'; r: number }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'lshape'; w: number; d: number; cutW: number; cutD: number; corner: Corner }
  | { kind: 'ushape'; w: number; d: number; armW: number; openSide: Side }
  | { kind: 'trapezoid'; wTop: number; wBottom: number; d: number }
  | { kind: 'poly'; pts: Vec2[] };

/** Segments used to tessellate a full circle. 64 keeps a 2m circle under 1mm of chord error. */
export const CIRCLE_SEGMENTS = 64;

function requirePositive(name: string, ...values: number[]): void {
  for (const v of values) {
    if (!(v > 0) || !Number.isFinite(v)) {
      throw new RangeError(`generator: ${name} must be a positive finite number, got ${v}`);
    }
  }
}

function rect(w: number, d: number): Polygon {
  requirePositive('rect w/d', w, d);
  const hw = w / 2;
  const hd = d / 2;
  // Winding here is arbitrary — `generatePolygon` normalizes every generator's
  // output through `ensureCounterClockwise`, which is defined by signed area.
  return polygon([
    { x: -hw, y: -hd },
    { x: -hw, y: hd },
    { x: hw, y: hd },
    { x: hw, y: -hd },
  ]);
}

function roundedRect(w: number, d: number, radius: number): Polygon {
  requirePositive('roundedRect w/d', w, d);
  const r = Math.min(radius, w / 2, d / 2);
  if (r <= 0) return rect(w, d);

  const hw = w / 2;
  const hd = d / 2;
  const perCorner = Math.max(2, Math.round(CIRCLE_SEGMENTS / 4));
  const pts: Vec2[] = [];

  // Each corner arc sweeps a quarter turn *forward*, so it connects the edge it
  // starts on to the next edge. Sweeping backward folds the corner inward and
  // produces a shape with roughly half the intended area.
  const corners: { c: Vec2; start: number }[] = [
    { c: { x: hw - r, y: hd - r }, start: 0 },
    { c: { x: -hw + r, y: hd - r }, start: Math.PI / 2 },
    { c: { x: -hw + r, y: -hd + r }, start: Math.PI },
    { c: { x: hw - r, y: -hd + r }, start: (3 * Math.PI) / 2 },
  ];

  for (const { c, start } of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = start + (i / perCorner) * (Math.PI / 2);
      pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
  }
  return ensureCounterClockwise(polygon(pts));
}

function ellipse(rx: number, ry: number): Polygon {
  requirePositive('ellipse rx/ry', rx, ry);
  const pts: Vec2[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
  }
  return ensureCounterClockwise(polygon(pts));
}

/**
 * A rectangle with one corner bitten out — sectional sofas, corner desks, L-kitchens.
 * `corner` names which corner is removed.
 */
function lshape(w: number, d: number, cutW: number, cutD: number, corner: Corner): Polygon {
  requirePositive('lshape w/d', w, d);
  requirePositive('lshape cutW/cutD', cutW, cutD);
  if (cutW >= w || cutD >= d) {
    throw new RangeError(`lshape: cut (${cutW}×${cutD}) must be smaller than body (${w}×${d})`);
  }

  const hw = w / 2;
  const hd = d / 2;
  // Full rectangle counter-clockwise from the north-west, then splice the bite in.
  const nw = { x: -hw, y: -hd };
  const sw = { x: -hw, y: hd };
  const se = { x: hw, y: hd };
  const ne = { x: hw, y: -hd };

  switch (corner) {
    case 'nw':
      return polygon([
        { x: -hw + cutW, y: -hd },
        { x: -hw + cutW, y: -hd + cutD },
        { x: -hw, y: -hd + cutD },
        sw,
        se,
        ne,
      ]);
    case 'sw':
      return polygon([
        nw,
        { x: -hw, y: hd - cutD },
        { x: -hw + cutW, y: hd - cutD },
        { x: -hw + cutW, y: hd },
        se,
        ne,
      ]);
    case 'se':
      return polygon([
        nw,
        sw,
        { x: hw - cutW, y: hd },
        { x: hw - cutW, y: hd - cutD },
        { x: hw, y: hd - cutD },
        ne,
      ]);
    case 'ne':
      return polygon([
        nw,
        sw,
        se,
        { x: hw, y: -hd + cutD },
        { x: hw - cutW, y: -hd + cutD },
        { x: hw - cutW, y: -hd },
      ]);
  }
}

/**
 * A three-sided shape — U-shaped desks, sectionals with two returns, galley layouts.
 * `armW` is the thickness of each arm and the back; `openSide` is the missing side.
 */
function ushape(w: number, d: number, armW: number, openSide: Side): Polygon {
  requirePositive('ushape w/d', w, d);
  requirePositive('ushape armW', armW);
  if (armW * 2 >= w || armW >= d) {
    throw new RangeError(`ushape: armW ${armW} too large for body ${w}×${d}`);
  }

  const hw = w / 2;
  const hd = d / 2;

  // Built opening north, then rotated into place — one construction, four orientations.
  const openNorth: Vec2[] = [
    { x: -hw, y: -hd },
    { x: -hw, y: hd },
    { x: hw, y: hd },
    { x: hw, y: -hd },
    { x: hw - armW, y: -hd },
    { x: hw - armW, y: hd - armW },
    { x: -hw + armW, y: hd - armW },
    { x: -hw + armW, y: -hd },
  ];

  const quarterTurns: Record<Side, number> = { n: 0, w: 1, s: 2, e: 3 };
  const turns = quarterTurns[openSide];
  let pts = openNorth;
  for (let i = 0; i < turns; i++) {
    pts = pts.map((p) => ({ x: -p.y, y: p.x }));
  }
  return ensureCounterClockwise(polygon(pts));
}

function trapezoid(wTop: number, wBottom: number, d: number): Polygon {
  requirePositive('trapezoid d', d);
  if (wTop <= 0 && wBottom <= 0) {
    throw new RangeError('trapezoid: at least one of wTop/wBottom must be positive');
  }
  const hd = d / 2;
  const ht = wTop / 2;
  const hb = wBottom / 2;
  return ensureCounterClockwise(
    polygon([
      { x: -ht, y: -hd },
      { x: -hb, y: hd },
      { x: hb, y: hd },
      { x: ht, y: -hd },
    ]),
  );
}

/** Build the polygon for a generator. Always counter-clockwise, centred on local origin. */
export function generatePolygon(gen: FootprintGenerator): Polygon {
  switch (gen.kind) {
    case 'rect':
      return gen.cornerRadius && gen.cornerRadius > 0
        ? roundedRect(gen.w, gen.d, gen.cornerRadius)
        : ensureCounterClockwise(rect(gen.w, gen.d));
    case 'circle':
      return ellipse(gen.r, gen.r);
    case 'ellipse':
      return ellipse(gen.rx, gen.ry);
    case 'lshape':
      return ensureCounterClockwise(lshape(gen.w, gen.d, gen.cutW, gen.cutD, gen.corner));
    case 'ushape':
      return ushape(gen.w, gen.d, gen.armW, gen.openSide);
    case 'trapezoid':
      return trapezoid(gen.wTop, gen.wBottom, gen.d);
    case 'poly':
      return ensureCounterClockwise(polygon(gen.pts));
  }
}
