import { describe, expect, it } from 'vitest';
import { generatePolygon, type FootprintGenerator } from './generators';
import { area, bounds, containsPoint, isCounterClockwise, isConvex, width, depth } from './polygon';

const ALL: FootprintGenerator[] = [
  { kind: 'rect', w: 1800, d: 900 },
  { kind: 'rect', w: 1800, d: 900, cornerRadius: 120 },
  { kind: 'circle', r: 600 },
  { kind: 'ellipse', rx: 900, ry: 500 },
  { kind: 'lshape', w: 2400, d: 2000, cutW: 900, cutD: 800, corner: 'ne' },
  { kind: 'ushape', w: 2400, d: 1800, armW: 600, openSide: 'n' },
  { kind: 'trapezoid', wTop: 800, wBottom: 1600, d: 900 },
  {
    kind: 'poly',
    pts: [
      { x: -100, y: -100 },
      { x: -100, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: -100 },
    ],
  },
];

describe('every generator', () => {
  it('emits a counter-clockwise ring with positive area', () => {
    for (const gen of ALL) {
      const poly = generatePolygon(gen);
      expect(isCounterClockwise(poly), gen.kind).toBe(true);
      expect(area(poly), gen.kind).toBeGreaterThan(0);
      expect(poly.pts.length, gen.kind).toBeGreaterThanOrEqual(3);
    }
  });

  it('centres the shape on its local origin', () => {
    for (const gen of ALL) {
      const b = bounds(generatePolygon(gen));
      // U-shapes and L-shapes are centred on their bounding box, not their centroid.
      expect(Math.abs(b.minX + b.maxX), gen.kind).toBeLessThan(1);
      expect(Math.abs(b.minY + b.maxY), gen.kind).toBeLessThan(1);
    }
  });

  it('produces only finite coordinates', () => {
    for (const gen of ALL) {
      for (const p of generatePolygon(gen).pts) {
        expect(Number.isFinite(p.x), gen.kind).toBe(true);
        expect(Number.isFinite(p.y), gen.kind).toBe(true);
      }
    }
  });
});

describe('rect', () => {
  it('has exactly the requested extents and area', () => {
    const poly = generatePolygon({ kind: 'rect', w: 1800, d: 900 });
    expect(width(poly)).toBe(1800);
    expect(depth(poly)).toBe(900);
    expect(area(poly)).toBe(1_620_000);
    expect(poly.pts).toHaveLength(4);
  });

  it('rejects non-positive dimensions', () => {
    expect(() => generatePolygon({ kind: 'rect', w: 0, d: 900 })).toThrow(RangeError);
    expect(() => generatePolygon({ kind: 'rect', w: -1, d: 900 })).toThrow(RangeError);
  });
});

describe('rounded rect', () => {
  it('keeps the outer extents but loses area at the corners', () => {
    const sharp = generatePolygon({ kind: 'rect', w: 1000, d: 1000 });
    const round = generatePolygon({ kind: 'rect', w: 1000, d: 1000, cornerRadius: 200 });
    expect(width(round)).toBeCloseTo(1000, 6);
    expect(depth(round)).toBeCloseTo(1000, 6);
    expect(area(round)).toBeLessThan(area(sharp));
    // Four corners each lose r² - πr²/4. The arcs are inscribed, so the real
    // loss is slightly larger than analytic — allow the tessellation deficit.
    const lost = 4 * (200 * 200 - (Math.PI * 200 * 200) / 4);
    const actual = area(sharp) - area(round);
    expect(actual).toBeGreaterThanOrEqual(lost);
    expect(actual / lost).toBeLessThan(1.02);
  });

  it('clamps the radius to half the shortest side', () => {
    const poly = generatePolygon({ kind: 'rect', w: 400, d: 400, cornerRadius: 9999 });
    // Fully clamped, this is a circle of r=200 — inscribed, so just under exact.
    const exact = Math.PI * 200 * 200;
    expect(area(poly)).toBeLessThan(exact);
    expect(area(poly) / exact).toBeGreaterThan(0.998);
  });
});

describe('circle and ellipse', () => {
  it('approximates area to within tessellation error', () => {
    const poly = generatePolygon({ kind: 'circle', r: 600 });
    const exact = Math.PI * 600 * 600;
    // 64 segments inscribe the circle, so the polygon is slightly smaller.
    expect(area(poly)).toBeLessThan(exact);
    expect(area(poly) / exact).toBeGreaterThan(0.998);
  });

  it('gives an ellipse the right extents', () => {
    const poly = generatePolygon({ kind: 'ellipse', rx: 900, ry: 500 });
    expect(width(poly)).toBeCloseTo(1800, 6);
    expect(depth(poly)).toBeCloseTo(1000, 6);
  });
});

describe('lshape', () => {
  it('removes exactly the cut area from each corner variant', () => {
    for (const corner of ['nw', 'ne', 'se', 'sw'] as const) {
      const poly = generatePolygon({
        kind: 'lshape',
        w: 2400,
        d: 2000,
        cutW: 900,
        cutD: 800,
        corner,
      });
      expect(area(poly), corner).toBeCloseTo(2400 * 2000 - 900 * 800, 6);
      expect(isConvex(poly), corner).toBe(false);
      expect(width(poly), corner).toBeCloseTo(2400, 6);
      expect(depth(poly), corner).toBeCloseTo(2000, 6);
    }
  });

  it('puts the bite in the named corner', () => {
    const ne = generatePolygon({
      kind: 'lshape',
      w: 2000,
      d: 2000,
      cutW: 500,
      cutD: 500,
      corner: 'ne',
    });
    // North-east in a y-down plan frame is +x, -y.
    expect(containsPoint(ne, { x: 900, y: -900 })).toBe(false);
    expect(containsPoint(ne, { x: -900, y: -900 })).toBe(true);
  });

  it('rejects a cut at least as large as the body', () => {
    expect(() =>
      generatePolygon({ kind: 'lshape', w: 1000, d: 1000, cutW: 1000, cutD: 500, corner: 'ne' }),
    ).toThrow(RangeError);
  });
});

describe('ushape', () => {
  it('has the right area for every orientation', () => {
    const w = 2400;
    const d = 1800;
    const armW = 600;
    const expected = w * d - (w - 2 * armW) * (d - armW);
    for (const openSide of ['n', 'e', 's', 'w'] as const) {
      const poly = generatePolygon({ kind: 'ushape', w, d, armW, openSide });
      expect(area(poly), openSide).toBeCloseTo(expected, 6);
    }
  });

  it('leaves the mouth empty on the named side', () => {
    const openNorth = generatePolygon({
      kind: 'ushape',
      w: 2400,
      d: 1800,
      armW: 600,
      openSide: 'n',
    });
    // North is -y: the mouth is open there, the back is solid at +y.
    expect(containsPoint(openNorth, { x: 0, y: -600 })).toBe(false);
    expect(containsPoint(openNorth, { x: 0, y: 750 })).toBe(true);
  });

  it('rejects arms too thick for the body', () => {
    expect(() =>
      generatePolygon({ kind: 'ushape', w: 1000, d: 1000, armW: 500, openSide: 'n' }),
    ).toThrow(RangeError);
  });
});

describe('trapezoid', () => {
  it('uses the mean-width area formula', () => {
    const poly = generatePolygon({ kind: 'trapezoid', wTop: 800, wBottom: 1600, d: 900 });
    expect(area(poly)).toBeCloseTo(((800 + 1600) / 2) * 900, 6);
    expect(width(poly)).toBeCloseTo(1600, 6);
  });
});
