import { describe, expect, it } from 'vitest';
import { area, bounds, isCounterClockwise } from './polygon';
import {
  distanceToSegment,
  hitsWall,
  isDegenerate,
  projectOntoWall,
  wallAngleDeg,
  wallEndpoints,
  wallLength,
  wallMidpoint,
  wallOutline,
  type WallLine,
} from './wall';

const horizontal: WallLine = { a: { x: 0, y: 0 }, b: { x: 4000, y: 0 }, thicknessMm: 114 };

describe('wallOutline', () => {
  it('is a quad of length × thickness', () => {
    expect(area(wallOutline(horizontal))).toBeCloseTo(4000 * 114, 6);
  });

  it('straddles the centreline, half the thickness each side', () => {
    const b = bounds(wallOutline(horizontal));
    expect(b.minY).toBeCloseTo(-57, 6);
    expect(b.maxY).toBeCloseTo(57, 6);
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(4000, 6);
  });

  it('comes out counter-clockwise whichever way the wall was drawn', () => {
    // Drawing right-to-left must not produce an inverted polygon that reads as a
    // hole to the clipper.
    const reversed: WallLine = { a: { x: 4000, y: 0 }, b: { x: 0, y: 0 }, thicknessMm: 114 };
    expect(isCounterClockwise(wallOutline(horizontal))).toBe(true);
    expect(isCounterClockwise(wallOutline(reversed))).toBe(true);
  });

  it('keeps its area under rotation', () => {
    const diagonal: WallLine = {
      a: { x: 0, y: 0 },
      b: { x: 3000, y: 4000 },
      thicknessMm: 200,
    };
    expect(area(wallOutline(diagonal))).toBeCloseTo(5000 * 200, 6);
  });

  it('throws on a degenerate wall instead of emitting an empty shape', () => {
    // A zero-area polygon that renders as nothing is far harder to trace back than a
    // throw where the wall was created.
    const zero: WallLine = { a: { x: 10, y: 10 }, b: { x: 10, y: 10 }, thicknessMm: 114 };
    expect(isDegenerate(zero)).toBe(true);
    expect(() => wallOutline(zero)).toThrow(RangeError);
  });
});

describe('wall measurements', () => {
  it('reports length, angle and midpoint', () => {
    expect(wallLength(horizontal)).toBe(4000);
    expect(wallAngleDeg(horizontal)).toBe(0);
    expect(wallMidpoint(horizontal)).toEqual({ x: 2000, y: 0 });
  });

  it('measures angle downward as positive — document space is y-down', () => {
    expect(wallAngleDeg({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, thicknessMm: 1 })).toBe(90);
  });
});

describe('distanceToSegment', () => {
  it('measures perpendicular distance inside the span', () => {
    expect(distanceToSegment({ x: 2000, y: 300 }, horizontal.a, horizontal.b)).toBeCloseTo(300);
  });

  it('clamps to the endpoints beyond the span', () => {
    // Not the infinite line: a point past the end is measured to the end.
    expect(distanceToSegment({ x: 5000, y: 0 }, horizontal.a, horizontal.b)).toBeCloseTo(1000);
  });

  it('handles a zero-length segment', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5);
  });
});

describe('projectOntoWall', () => {
  it('gives the offset an opening would be stored at', () => {
    expect(projectOntoWall(horizontal, { x: 1200, y: 400 })).toBeCloseTo(1200);
  });

  it('clamps to the wall', () => {
    expect(projectOntoWall(horizontal, { x: -500, y: 0 })).toBe(0);
    expect(projectOntoWall(horizontal, { x: 9000, y: 0 })).toBeCloseTo(4000);
  });
});

describe('hitsWall', () => {
  it('accepts a click anywhere across the wall body', () => {
    expect(hitsWall(horizontal, { x: 2000, y: 50 }, 0)).toBe(true);
  });

  it('adds the tolerance on top of the half-thickness', () => {
    // A thin wall is otherwise much harder to click than a thick one.
    expect(hitsWall(horizontal, { x: 2000, y: 100 }, 0)).toBe(false);
    expect(hitsWall(horizontal, { x: 2000, y: 100 }, 50)).toBe(true);
  });

  it('rejects a point past the end', () => {
    expect(hitsWall(horizontal, { x: 4500, y: 0 }, 100)).toBe(false);
  });
});

describe('wallEndpoints', () => {
  it('collects every endpoint once, so a shared corner is one snap target', () => {
    const walls: WallLine[] = [
      { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 }, thicknessMm: 114 },
      { a: { x: 1000, y: 0 }, b: { x: 1000, y: 1000 }, thicknessMm: 114 },
    ];
    expect(wallEndpoints(walls)).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
    ]);
  });

  it('is empty for no walls', () => {
    expect(wallEndpoints([])).toEqual([]);
  });
});
