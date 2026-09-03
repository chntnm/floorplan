import { describe, expect, it } from 'vitest';
import {
  OPENING_DEFAULTS,
  OpeningError,
  clampOffset,
  createOpening,
  openingCentre,
  openingFitReason,
  openingRange,
  openingSpan,
  segmentArea,
  segmentOutline,
  wallSegments,
} from './openings';
import { area } from './geometry/polygon';
import type { Opening, Wall } from './document';

/** A 5m wall running east from the origin, 2438 high, 114 thick. */
const WALL: Wall = {
  id: 'w1',
  a: { x: 0, y: 0 },
  b: { x: 5000, y: 0 },
  thicknessMm: 114,
  heightMm: 2438,
  baseElevationMm: 0,
};

function opening(over: Partial<Opening> = {}): Opening {
  return {
    id: 'o1',
    wallId: 'w1',
    offsetMm: 1000,
    widthMm: 813,
    heightMm: 2032,
    sillMm: 0,
    kind: 'door',
    ...over,
  };
}

describe('creating an opening', () => {
  it('centres it on the clicked point', () => {
    const o = createOpening({ id: 'o', wall: WALL, kind: 'door', centreMm: 2500 });
    expect(o.offsetMm).toBe(2094); // 2500 − 813/2, rounded up from 2093.5
    expect(openingCentre(WALL, o)).toEqual({ x: 2500.5, y: 0 });
  });

  it('slides it along rather than refusing, when the click is near an end', () => {
    // "Put a door here" near the corner means the nearest place it fits, which is
    // what a person would do by hand anyway.
    const o = createOpening({ id: 'o', wall: WALL, kind: 'door', centreMm: 50 });
    expect(o.offsetMm).toBe(0);

    const far = createOpening({ id: 'o', wall: WALL, kind: 'door', centreMm: 4990 });
    expect(openingRange(far).to).toBe(5000);
  });

  it('refuses a wall that physically cannot hold the opening', () => {
    // Shrinking the patio door to fit would produce a door nobody asked for.
    const stub: Wall = { ...WALL, b: { x: 900, y: 0 } };
    expect(() => createOpening({ id: 'o', wall: stub, kind: 'sliding', centreMm: 450 })).toThrow(
      OpeningError,
    );
  });

  it('uses real published sizes, not friendly metric ones', () => {
    // A 32" x 80" door is 813 x 2032. Rounding it makes every door in a traced US
    // plan subtly wrong.
    expect(OPENING_DEFAULTS.door).toEqual({ widthMm: 813, heightMm: 2032, sillMm: 0 });
    expect(OPENING_DEFAULTS.window.sillMm).toBe(914);
  });

  it('measures the sill from the floor, not from the wall base', () => {
    expect(openingSpan(opening({ sillMm: 914, heightMm: 1219 }))).toEqual({
      bottom: 914,
      top: 2133,
    });
  });
});

describe('clampOffset', () => {
  it('gives up and returns 0 when the opening is wider than the wall', () => {
    expect(clampOffset(500, 2000, 1000)).toBe(0);
  });
});

describe('wallSegments', () => {
  it('returns exactly one segment for a wall with no openings', () => {
    expect(wallSegments(WALL, [])).toEqual([
      { from: 0, to: 5000, bottom: 0, top: 2438 },
    ]);
  });

  it('leaves a flank, a lintel and a flank around a door', () => {
    // The door has no sill wall, so there is no box below it — which is what makes
    // the doorway passable without traversal knowing what a door is.
    const segments = wallSegments(WALL, [opening()]);
    expect(segments).toEqual([
      { from: 0, to: 1000, bottom: 0, top: 2438 },
      { from: 1000, to: 1813, bottom: 2032, top: 2438 },
      { from: 1813, to: 5000, bottom: 0, top: 2438 },
    ]);
  });

  it('leaves a sill wall below a window as well as a lintel above it', () => {
    const segments = wallSegments(WALL, [
      opening({ kind: 'window', sillMm: 914, heightMm: 1219 }),
    ]);
    expect(segments).toHaveLength(4);
    expect(segments[1]).toEqual({ from: 1000, to: 1813, bottom: 0, top: 914 });
    expect(segments[2]).toEqual({ from: 1000, to: 1813, bottom: 2133, top: 2438 });
  });

  it('keeps the jamb between two adjacent openings', () => {
    // Two doors 100mm apart are two doors, not one 1726mm gap.
    const segments = wallSegments(WALL, [
      opening({ id: 'a', offsetMm: 1000 }),
      opening({ id: 'b', offsetMm: 1913 }),
    ]);
    const jamb = segments.find((s) => s.from === 1813 && s.to === 1913);
    expect(jamb).toEqual({ from: 1813, to: 1913, bottom: 0, top: 2438 });
  });

  it('emits no leading segment for an opening flush with the start of the wall', () => {
    // A zero-width box would extrude to nothing and collide with everything.
    const segments = wallSegments(WALL, [opening({ offsetMm: 0 })]);
    expect(segments.every((s) => s.to > s.from)).toBe(true);
    expect(segments[0]).toEqual({ from: 0, to: 813, bottom: 2032, top: 2438 });
  });

  it('merges overlapping openings instead of inventing a jamb between them', () => {
    const segments = wallSegments(WALL, [
      opening({ id: 'a', offsetMm: 1000, widthMm: 1000 }),
      opening({ id: 'b', offsetMm: 1500, widthMm: 1000 }),
    ]);
    expect(segments).toEqual([
      { from: 0, to: 1000, bottom: 0, top: 2438 },
      { from: 1000, to: 2500, bottom: 2032, top: 2438 },
      { from: 2500, to: 5000, bottom: 0, top: 2438 },
    ]);
  });

  it('conserves face area: solid = wall minus the openings', () => {
    // The invariant that catches an off-by-one anywhere in the split.
    const gap = opening({ kind: 'window', sillMm: 914, heightMm: 1219 });
    const segments = wallSegments(WALL, [gap]);
    const wallFace = 5000 * 2438;
    const hole = gap.widthMm * gap.heightMm;
    expect(segmentArea(segments)).toBe(wallFace - hole);
  });

  it('drops an opening that a shortened wall has left hanging off the end', () => {
    // Validation reports it; the geometry just does not build a door in mid-air.
    const short: Wall = { ...WALL, b: { x: 900, y: 0 } };
    expect(wallSegments(short, [opening({ offsetMm: 1000 })])).toEqual([
      { from: 0, to: 900, bottom: 0, top: 2438 },
    ]);
  });

  it('clips an opening taller than its wall rather than removing more than there is', () => {
    const segments = wallSegments(WALL, [opening({ heightMm: 4000 })]);
    expect(segmentArea(segments)).toBe(5000 * 2438 - 813 * 2438);
  });

  it('folds a raised wall base into absolute elevations', () => {
    const platform: Wall = { ...WALL, baseElevationMm: 300, heightMm: 1000 };
    expect(wallSegments(platform, [])).toEqual([
      { from: 0, to: 5000, bottom: 300, top: 1300 },
    ]);
  });
});

describe('segmentOutline', () => {
  it('is the slice of the wall quad the segment runs over', () => {
    const [segment] = wallSegments(WALL, [opening()]);
    const poly = segmentOutline(WALL, segment!);
    expect(area(poly)).toBeCloseTo(1000 * 114, 6);
  });

  it('follows a diagonal wall', () => {
    const diagonal: Wall = { ...WALL, b: { x: 3000, y: 4000 } }; // 5000 long
    const poly = segmentOutline(diagonal, { from: 0, to: 5000, bottom: 0, top: 2438 });
    expect(area(poly)).toBeCloseTo(5000 * 114, 4);
  });
});

describe('openingFitReason', () => {
  it('is silent when the opening fits', () => {
    expect(openingFitReason(WALL, opening())).toBeNull();
  });

  it('reports an opening that runs past the end of its wall', () => {
    const short: Wall = { ...WALL, b: { x: 1500, y: 0 } };
    expect(openingFitReason(short, opening())).toContain('past the end');
  });

  it('reports an opening taller than its wall', () => {
    expect(openingFitReason(WALL, opening({ heightMm: 3000 }))).toContain('taller');
  });
});
