import { describe, expect, it } from 'vitest';
import {
  area,
  bounds,
  centroid,
  containsPoint,
  depth,
  ensureCounterClockwise,
  isConvex,
  isCounterClockwise,
  perimeter,
  polygon,
  rotatePolygon,
  signedArea,
  translate,
  width,
} from './polygon';
import { toRadians } from './vec';

// "Counter-clockwise" here means positive signed area, the mathematical
// definition — not visual appearance. Document space is y-down, so a
// positively-wound ring reads as clockwise on screen. Every generator is
// normalized to this convention, so nothing downstream has to care.
const square = polygon([
  { x: -500, y: -500 },
  { x: 500, y: -500 },
  { x: 500, y: 500 },
  { x: -500, y: 500 },
]);

describe('polygon construction', () => {
  it('rejects rings with fewer than 3 points', () => {
    expect(() => polygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(RangeError);
  });
});

describe('area', () => {
  it('computes a known square', () => {
    expect(area(square)).toBe(1_000_000); // 1m × 1m
  });

  it('is invariant under translation', () => {
    expect(area(translate(square, { x: 12_345, y: -6_789 }))).toBeCloseTo(1_000_000, 6);
  });

  it('is invariant under rotation — the property that matters most', () => {
    for (const deg of [1, 15, 30, 45, 90, 137, 180, 271, 359]) {
      expect(area(rotatePolygon(square, toRadians(deg)))).toBeCloseTo(1_000_000, 4);
    }
  });

  it('gives a positive signed area for counter-clockwise rings', () => {
    expect(signedArea(square)).toBeGreaterThan(0);
    expect(isCounterClockwise(square)).toBe(true);
  });

  it('gives a negative signed area for clockwise rings', () => {
    const cw = polygon([...square.pts].reverse());
    expect(signedArea(cw)).toBeLessThan(0);
    expect(isCounterClockwise(cw)).toBe(false);
  });
});

describe('ensureCounterClockwise', () => {
  it('leaves a CCW ring untouched', () => {
    expect(ensureCounterClockwise(square)).toBe(square);
  });

  it('reverses a CW ring', () => {
    const cw = polygon([...square.pts].reverse());
    expect(isCounterClockwise(ensureCounterClockwise(cw))).toBe(true);
  });
});

describe('centroid', () => {
  it('finds the centre of a centred square', () => {
    const c = centroid(square);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
  });

  it('tracks translation', () => {
    const c = centroid(translate(square, { x: 300, y: -700 }));
    expect(c.x).toBeCloseTo(300, 6);
    expect(c.y).toBeCloseTo(-700, 6);
  });

  it('handles an L-shape, whose centroid is not its bounding-box centre', () => {
    const l = polygon([
      { x: 0, y: 0 },
      { x: 0, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 0 },
    ]);
    // Two rects: 100×200 at (50,100) area 20000, and 100×100 at (150,50) area 10000.
    // Area-weighted: (20000·50 + 10000·150) / 30000 = 250/3 on both axes.
    const c = centroid(l);
    expect(c.x).toBeCloseTo(250 / 3, 4);
    expect(c.y).toBeCloseTo(250 / 3, 4);
  });
});

describe('bounds', () => {
  it('measures width and depth', () => {
    expect(width(square)).toBe(1000);
    expect(depth(square)).toBe(1000);
    expect(bounds(square)).toEqual({ minX: -500, minY: -500, maxX: 500, maxY: 500 });
  });

  it('grows when a square is rotated 45°', () => {
    const rotated = rotatePolygon(square, toRadians(45));
    expect(width(rotated)).toBeCloseTo(1000 * Math.SQRT2, 4);
  });
});

describe('rotation', () => {
  it('returns to the original after four 90° turns', () => {
    let poly = square;
    for (let i = 0; i < 4; i++) poly = rotatePolygon(poly, toRadians(90));
    for (let i = 0; i < square.pts.length; i++) {
      expect(poly.pts[i]!.x).toBeCloseTo(square.pts[i]!.x, 6);
      expect(poly.pts[i]!.y).toBeCloseTo(square.pts[i]!.y, 6);
    }
  });

  it('rotates about an explicit pivot', () => {
    const p = polygon([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]);
    const r = rotatePolygon(p, toRadians(90), { x: 0, y: 0 });
    expect(r.pts[0]!.x).toBeCloseTo(0, 6);
    expect(r.pts[0]!.y).toBeCloseTo(0, 6);
    expect(r.pts[1]!.x).toBeCloseTo(-100, 6);
    expect(r.pts[1]!.y).toBeCloseTo(0, 6);
  });
});

describe('containsPoint', () => {
  it('detects inside and outside', () => {
    expect(containsPoint(square, { x: 0, y: 0 })).toBe(true);
    expect(containsPoint(square, { x: 499, y: 499 })).toBe(true);
    expect(containsPoint(square, { x: 501, y: 0 })).toBe(false);
    expect(containsPoint(square, { x: 0, y: -900 })).toBe(false);
  });

  it('respects concavity — the notch of an L is outside', () => {
    const l = polygon([
      { x: 0, y: 0 },
      { x: 0, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 0 },
    ]);
    expect(containsPoint(l, { x: 50, y: 50 })).toBe(true);
    expect(containsPoint(l, { x: 150, y: 150 })).toBe(false);
  });
});

describe('perimeter and convexity', () => {
  it('measures the perimeter of a square', () => {
    expect(perimeter(square)).toBe(4000);
  });

  it('classifies convex and concave rings', () => {
    expect(isConvex(square)).toBe(true);
    const l = polygon([
      { x: 0, y: 0 },
      { x: 0, y: 200 },
      { x: 100, y: 200 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 0 },
    ]);
    expect(isConvex(l)).toBe(false);
  });
});
