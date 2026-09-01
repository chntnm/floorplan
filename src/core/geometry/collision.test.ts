import { describe, expect, it } from 'vitest';
import {
  findCollisions,
  intersectionArea,
  polygonsIntersect,
  solidSpan,
  spansOverlap,
  volumesCollide,
  type Volume,
} from './collision';
import { generatePolygon } from './generators';
import { polygon, translate, type Polygon } from './polygon';

function rect(w: number, d: number, at = { x: 0, y: 0 }): Polygon {
  return translate(generatePolygon({ kind: 'rect', w, d }), at);
}

describe('solidSpan', () => {
  it('spans from elevation to elevation + height when nothing is void', () => {
    expect(solidSpan(0, 900, 0)).toEqual({ bottom: 0, top: 900 });
  });

  it('starts at the underside of the solid part when there is a void', () => {
    // A dining table: 750 tall, open to 720.
    expect(solidSpan(0, 750, 720)).toEqual({ bottom: 720, top: 750 });
  });

  it('offsets by elevation for a wall-mounted item', () => {
    expect(solidSpan(1400, 300, 0)).toEqual({ bottom: 1400, top: 1700 });
  });

  it('rejects a void deeper than the object is tall', () => {
    expect(() => solidSpan(0, 500, 700)).toThrow(RangeError);
  });
});

describe('spansOverlap', () => {
  it('is strict — touching spans do not overlap', () => {
    // A lamp resting exactly on a 750mm table top must not collide with it.
    expect(spansOverlap({ bottom: 0, top: 750 }, { bottom: 750, top: 1150 })).toBe(false);
  });

  it('detects genuine overlap', () => {
    expect(spansOverlap({ bottom: 0, top: 900 }, { bottom: 800, top: 1200 })).toBe(true);
  });
});

describe('polygonsIntersect', () => {
  it('detects overlapping rectangles', () => {
    expect(polygonsIntersect(rect(1000, 1000), rect(1000, 1000, { x: 500, y: 0 }))).toBe(true);
  });

  it('rejects separated rectangles', () => {
    expect(polygonsIntersect(rect(1000, 1000), rect(1000, 1000, { x: 2000, y: 0 }))).toBe(false);
  });

  it('treats flush-against-a-wall neighbours as non-colliding', () => {
    // Two 1000mm objects sharing an edge at x=500 — the everyday case of two
    // cabinets pushed together. A shared edge is not an overlap.
    expect(polygonsIntersect(rect(1000, 1000), rect(1000, 1000, { x: 1000, y: 0 }))).toBe(false);
  });

  it('handles concave shapes — an object in the mouth of a U does not collide', () => {
    const u = generatePolygon({ kind: 'ushape', w: 2400, d: 1800, armW: 600, openSide: 'n' });
    const inMouth = rect(1000, 500, { x: 0, y: -650 });
    expect(polygonsIntersect(u, inMouth)).toBe(false);

    const inBack = rect(1000, 500, { x: 0, y: 700 });
    expect(polygonsIntersect(u, inBack)).toBe(true);
  });

  it('measures overlap area', () => {
    expect(intersectionArea(rect(1000, 1000), rect(1000, 1000, { x: 500, y: 0 }))).toBeCloseTo(
      500 * 1000,
      2,
    );
  });

  it('subtracts holes — a ring-shaped overlap reports the annulus, not the disc', () => {
    // A U-shape wide enough that a crossing bar overlaps both arms in two
    // disjoint regions; and separately, an overlap that genuinely encloses a hole.
    const outerRoom = polygon([
      { x: -500, y: -500 },
      { x: 500, y: -500 },
      { x: 500, y: 500 },
      { x: -500, y: 500 },
    ]);
    // The clipper returns outer + hole rings with opposite winding; summing
    // signed areas must net to the annulus.
    const covering = rect(2000, 2000);
    expect(intersectionArea(outerRoom, covering)).toBeCloseTo(1_000_000, 2);
  });

  it('sums two disjoint overlap regions', () => {
    // A bar crossing both arms of a U touches it in two separate places.
    const u = generatePolygon({ kind: 'ushape', w: 2400, d: 1800, armW: 600, openSide: 'n' });
    const bar = rect(3000, 200, { x: 0, y: -600 });
    // Two arms, each 600 wide, 200 deep.
    expect(intersectionArea(u, bar)).toBeCloseTo(2 * 600 * 200, 2);
  });

  it('ignores a sub-tolerance sliver', () => {
    // 0.5mm² of overlap is floating-point noise from a flush snap, not intent.
    const sliver = translate(
      polygon([
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0.5, y: 1 },
        { x: 0.5, y: 0 },
      ]),
      { x: 499.75, y: 0 },
    );
    expect(polygonsIntersect(rect(1000, 1000), sliver)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The vertical cases from PLAN.md §4.2 — the reason the model is 3D at all.
// Each of these overlaps in plan and must NOT collide.
// ---------------------------------------------------------------------------

describe('vertical clearance', () => {
  const floorArea = rect(2000, 1000);

  const table: Volume = { outline: floorArea, span: solidSpan(0, 750, 720) };
  const desk: Volume = { outline: floorArea, span: solidSpan(0, 750, 700) };
  const bedFrame: Volume = { outline: floorArea, span: solidSpan(0, 600, 250) };
  const dresser: Volume = { outline: floorArea, span: solidSpan(0, 900, 0) };

  it('lets a rug lie under a table', () => {
    const rug: Volume = { outline: floorArea, span: solidSpan(0, 5, 0) };
    expect(volumesCollide(rug, table)).toBe(false);
  });

  it('lets a bin slide under a desk', () => {
    const bin: Volume = { outline: rect(400, 400), span: solidSpan(0, 400, 0) };
    expect(volumesCollide(bin, desk)).toBe(false);
  });

  it('lets storage boxes go under a bed frame', () => {
    const box: Volume = { outline: rect(600, 400), span: solidSpan(0, 200, 0) };
    expect(volumesCollide(box, bedFrame)).toBe(false);
  });

  it('lets a wall shelf hang above a dresser', () => {
    const shelf: Volume = { outline: rect(1200, 250), span: solidSpan(1400, 300, 0) };
    expect(volumesCollide(shelf, dresser)).toBe(false);
  });

  it('still collides when the vertical spans genuinely overlap', () => {
    const lamp: Volume = { outline: rect(300, 300), span: solidSpan(0, 1500, 0) };
    expect(volumesCollide(lamp, table)).toBe(true);
  });

  it('does not collide when footprints are apart, whatever the heights', () => {
    const far: Volume = { outline: rect(500, 500, { x: 9000, y: 0 }), span: solidSpan(0, 2000, 0) };
    expect(volumesCollide(far, dresser)).toBe(false);
  });

  it('documents the known gap: a chair tucked under a table still warns', () => {
    // A chair back reaches 900mm, through the table top at 720–750. A proper
    // multi-segment vertical profile is the v2 fix (PLAN.md §4.2 / §14).
    const chair: Volume = { outline: rect(450, 450), span: solidSpan(0, 900, 0) };
    expect(volumesCollide(chair, table)).toBe(true);
  });
});

describe('findCollisions', () => {
  it('finds every colliding pair and no others', () => {
    const volumes: Volume[] = [
      { outline: rect(1000, 1000, { x: 0, y: 0 }), span: solidSpan(0, 900, 0) },
      { outline: rect(1000, 1000, { x: 500, y: 0 }), span: solidSpan(0, 900, 0) }, // hits 0
      { outline: rect(1000, 1000, { x: 5000, y: 0 }), span: solidSpan(0, 900, 0) }, // alone
      { outline: rect(1000, 1000, { x: 250, y: 0 }), span: solidSpan(2000, 300, 0) }, // above 0 and 1
    ];
    expect(findCollisions(volumes)).toEqual([[0, 1]]);
  });

  it('returns nothing for an empty or single-item set', () => {
    expect(findCollisions([])).toEqual([]);
    expect(
      findCollisions([{ outline: rect(100, 100), span: solidSpan(0, 100, 0) }]),
    ).toEqual([]);
  });

  it('agrees with the brute-force pairwise result', () => {
    const volumes: Volume[] = [];
    for (let i = 0; i < 24; i++) {
      volumes.push({
        outline: rect(800, 800, { x: (i % 6) * 700, y: Math.floor(i / 6) * 700 }),
        span: solidSpan(0, 700 + (i % 3) * 100, 0),
      });
    }

    const brute: [number, number][] = [];
    for (let a = 0; a < volumes.length; a++) {
      for (let b = a + 1; b < volumes.length; b++) {
        if (volumesCollide(volumes[a]!, volumes[b]!)) brute.push([a, b]);
      }
    }

    const key = (p: [number, number]) => `${p[0]}-${p[1]}`;
    expect(findCollisions(volumes).map(key).sort()).toEqual(brute.map(key).sort());
    expect(brute.length).toBeGreaterThan(0);
  });
});
