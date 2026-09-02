import { describe, expect, it } from 'vitest';
import {
  constrainToAngle,
  nearestPoint,
  snapAngle,
  snapPoint,
  snapToGrid,
  type SnapContext,
} from './snapping';

function ctx(over: Partial<SnapContext> = {}): SnapContext {
  return {
    gridMm: 25,
    gridEnabled: true,
    points: [],
    toleranceMm: 200,
    angleStepDeg: 15,
    suppressed: false,
    ...over,
  };
}

describe('snapToGrid', () => {
  it('rounds to the nearest multiple', () => {
    expect(snapToGrid({ x: 1237, y: -18 }, 25)).toEqual({ x: 1225, y: -25 });
  });

  it('is a no-op for a zero or negative grid', () => {
    expect(snapToGrid({ x: 1237, y: -18 }, 0)).toEqual({ x: 1237, y: -18 });
  });
});

describe('nearestPoint', () => {
  const candidates = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
  ];

  it('finds a candidate inside the tolerance', () => {
    expect(nearestPoint({ x: 960, y: 30 }, candidates, 100)).toEqual({ x: 1000, y: 0 });
  });

  it('returns null when nothing is close enough', () => {
    expect(nearestPoint({ x: 500, y: 500 }, candidates, 100)).toBeNull();
  });

  it('picks the nearest when two are in range', () => {
    expect(nearestPoint({ x: 400, y: 0 }, candidates, 5000)).toEqual({ x: 0, y: 0 });
    expect(nearestPoint({ x: 600, y: 0 }, candidates, 5000)).toEqual({ x: 1000, y: 0 });
  });
});

describe('snapAngle', () => {
  it('rounds to the step', () => {
    expect(snapAngle(43, 15)).toBe(45);
    expect(snapAngle(37, 15)).toBe(30);
  });

  it('rounds negative angles by distance, not toward zero', () => {
    // -8 is 7 degrees from -15 and 8 from 0, so it belongs on -15.
    expect(snapAngle(-8, 15)).toBe(-15);
    expect(snapAngle(-5, 15)).toBe(-0);
  });

  it('is a no-op at step zero', () => {
    expect(snapAngle(43, 0)).toBe(43);
  });
});

describe('constrainToAngle', () => {
  const anchor = { x: 0, y: 0 };

  it('projects onto the nearest ray, keeping the distance', () => {
    const { point, degrees } = constrainToAngle(anchor, { x: 1000, y: 60 }, 15);
    expect(degrees).toBe(0);
    expect(point.y).toBeCloseTo(0, 6);
    expect(point.x).toBeCloseTo(Math.hypot(1000, 60), 6);
  });

  it('snaps the length too when a rounding step is given', () => {
    // The reason wall lengths come out as 1200 rather than 1187.
    const { point } = constrainToAngle(anchor, { x: 1187, y: 4 }, 15, 25);
    expect(point.x).toBeCloseTo(1175, 6);
  });

  it('handles a straight-down drag in y-down document space', () => {
    const { degrees } = constrainToAngle(anchor, { x: 3, y: 1000 }, 15);
    expect(degrees).toBe(90);
  });
});

describe('snapPoint precedence', () => {
  it('prefers an existing point over the grid', () => {
    // Closing a wall chain on its own start has to land exactly, not nearly.
    const result = snapPoint({ x: 1010, y: 7 }, ctx({ points: [{ x: 1013, y: 4 }] }));
    expect(result.point).toEqual({ x: 1013, y: 4 });
    expect(result.hints).toEqual([{ kind: 'point', at: { x: 1013, y: 4 } }]);
  });

  it('prefers the point snap over the angle constraint', () => {
    const target = { x: 1013, y: 400 };
    const result = snapPoint({ x: 1010, y: 397 }, ctx({ points: [target], anchor: { x: 0, y: 0 } }));
    expect(result.point).toEqual(target);
  });

  it('constrains to an angle ray when an anchor is present', () => {
    const result = snapPoint({ x: 1000, y: 43 }, ctx({ anchor: { x: 0, y: 0 } }));
    expect(result.point.y).toBeCloseTo(0, 6);
    expect(result.hints[0]).toMatchObject({ kind: 'angle', degrees: 0 });
  });

  it('falls back to the grid with no anchor and no nearby point', () => {
    const result = snapPoint({ x: 1237, y: -18 }, ctx());
    expect(result.point).toEqual({ x: 1225, y: -25 });
    expect(result.hints).toEqual([{ kind: 'grid', stepMm: 25 }]);
  });

  it('returns the raw point untouched when Alt suppresses snapping', () => {
    const raw = { x: 1237.4, y: -18.9 };
    const result = snapPoint(raw, ctx({ suppressed: true, points: [{ x: 1237, y: -19 }] }));
    expect(result.point).toBe(raw);
    expect(result.hints).toEqual([]);
  });

  it('leaves the point alone with grid off and no anchor', () => {
    const raw = { x: 1237.4, y: -18.9 };
    expect(snapPoint(raw, ctx({ gridEnabled: false })).point).toBe(raw);
  });

  it('does not round the length along a ray when the grid is off', () => {
    const result = snapPoint({ x: 1187, y: 4 }, ctx({ gridEnabled: false, anchor: { x: 0, y: 0 } }));
    expect(result.point.x).toBeCloseTo(Math.hypot(1187, 4), 6);
  });
});
