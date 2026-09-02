import { describe, expect, it } from 'vitest';
import { area, bounds, isCounterClockwise } from './geometry/polygon';
import { wallLength } from './geometry/wall';
import {
  MIN_ROOM_SIDE_MM,
  SHAPE_KINDS,
  commitRoomRect,
  commitShapeRoom,
  commitWallChain,
  rectFromDrag,
  roundPoint,
  shapeBoundary,
} from './tools';

/** Deterministic ids, so a commit can be asserted whole. */
function counter(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('commitWallChain', () => {
  it('turns n points into n-1 walls', () => {
    const walls = commitWallChain(
      [
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 },
      ],
      undefined,
      counter('w'),
    );
    expect(walls.map((w) => w.id)).toEqual(['w-1', 'w-2']);
    expect(walls.map((w) => wallLength(w))).toEqual([4000, 3000]);
  });

  it('drops degenerate segments from a double-click', () => {
    // A repeated point has no outline, no angle and nowhere to host an opening.
    const walls = commitWallChain(
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 2000 },
      ],
      undefined,
      counter(),
    );
    expect(walls).toHaveLength(2);
  });

  it('rounds to integer millimetres at the commit, not before', () => {
    const walls = commitWallChain(
      [
        { x: 0.4, y: -0.6 },
        { x: 1000.7, y: 0.2 },
      ],
      undefined,
      counter(),
    );
    expect(walls[0]!.a).toEqual({ x: 0, y: -1 });
    expect(walls[0]!.b).toEqual({ x: 1001, y: 0 });
  });

  it('returns nothing for a single click', () => {
    expect(commitWallChain([{ x: 0, y: 0 }], undefined, counter())).toEqual([]);
    expect(commitWallChain([], undefined, counter())).toEqual([]);
  });

  it('carries the wall defaults onto every wall', () => {
    const walls = commitWallChain(
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      { thicknessMm: 203, heightMm: 2700 },
      counter(),
    );
    expect(walls[0]).toMatchObject({ thicknessMm: 203, heightMm: 2700, baseElevationMm: 0 });
  });
});

describe('rectFromDrag', () => {
  it('normalizes a drag made in any direction', () => {
    const up = rectFromDrag({ x: 4000, y: 3000 }, { x: 0, y: 0 });
    const down = rectFromDrag({ x: 0, y: 0 }, { x: 4000, y: 3000 });
    expect(up).toEqual(down);
    expect(down.width).toBe(4000);
    expect(down.depth).toBe(3000);
  });
});

describe('commitRoomRect', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 4000, y: 3000 };

  it('produces a boundary and the four walls around it', () => {
    // A boundary alone has nothing to extrude in 3D and nothing to snap against.
    const result = commitRoomRect(start, end, { name: 'Living', makeId: counter() })!;
    expect(result.walls).toHaveLength(4);
    expect(result.room.name).toBe('Living');
    expect(result.room.boundary.pts).toHaveLength(4);
  });

  it('records the area and a counter-clockwise boundary', () => {
    const result = commitRoomRect(start, end, { name: 'Living', makeId: counter() })!;
    expect(result.room.areaMm2).toBe(12_000_000);
    expect(area(result.room.boundary)).toBeCloseTo(12_000_000);
    expect(isCounterClockwise(result.room.boundary)).toBe(true);
  });

  it('closes the wall loop — the last wall returns to the first corner', () => {
    const result = commitRoomRect(start, end, { name: 'Living', makeId: counter() })!;
    expect(result.walls[3]!.b).toEqual(result.walls[0]!.a);
  });

  it('runs the walls on the boundary, so the two agree', () => {
    const result = commitRoomRect(start, end, { name: 'Living', makeId: counter() })!;
    const b = bounds(result.room.boundary);
    expect({ x: b.minX, y: b.minY }).toEqual({ x: 0, y: 0 });
    expect({ x: b.maxX, y: b.maxY }).toEqual({ x: 4000, y: 3000 });
  });

  it('refuses a stray click', () => {
    const tiny = MIN_ROOM_SIDE_MM - 1;
    expect(commitRoomRect(start, { x: tiny, y: 3000 }, { name: 'x', makeId: counter() })).toBeNull();
    expect(commitRoomRect(start, start, { name: 'x', makeId: counter() })).toBeNull();
  });

  it('takes the floor ceiling height when given one', () => {
    const result = commitRoomRect(start, end, {
      name: 'Living',
      ceilingHeightMm: 2700,
      makeId: counter(),
    })!;
    expect(result.room.ceilingHeightMm).toBe(2700);
  });
});

describe('commitShapeRoom', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 4000, y: 3000 };

  it('fits every shape inside the dragged box', () => {
    // "Account for all common shapes" is one list, and drag-sizing has to mean the
    // same thing for each of them.
    for (const kind of SHAPE_KINDS) {
      const b = bounds(shapeBoundary(kind, start, end));
      expect(b.minX).toBeGreaterThanOrEqual(-1);
      expect(b.minY).toBeGreaterThanOrEqual(-1);
      expect(b.maxX).toBeLessThanOrEqual(4001);
      expect(b.maxY).toBeLessThanOrEqual(3001);
      expect(area(shapeBoundary(kind, start, end))).toBeGreaterThan(0);
    }
  });

  it('centres the shape in the box', () => {
    const b = bounds(shapeBoundary('circle', start, end));
    expect((b.minX + b.maxX) / 2).toBeCloseTo(2000, 6);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(1500, 6);
  });

  it('sizes a circle by the smaller axis so it stays inside the drag', () => {
    const b = bounds(shapeBoundary('circle', start, end));
    expect(b.maxY - b.minY).toBeCloseTo(3000, 0);
  });

  it('commits a boundary with no walls', () => {
    // A 64-segment circle would otherwise become 64 walls to select, save and extrude.
    const room = commitShapeRoom('circle', start, end, { name: 'Nook', makeId: counter() })!;
    expect(room.boundary.pts.length).toBeGreaterThan(4);
    expect(isCounterClockwise(room.boundary)).toBe(true);
    expect(room.areaMm2).toBeGreaterThan(0);
  });

  it('refuses a stray click', () => {
    expect(commitShapeRoom('rect', start, start, { name: 'x', makeId: counter() })).toBeNull();
  });
});

describe('roundPoint', () => {
  it('rounds half away from negative correctly for document storage', () => {
    expect(roundPoint({ x: 0.5, y: -0.5 })).toEqual({ x: 1, y: -0 });
    expect(roundPoint({ x: 1999.999, y: 12.4 })).toEqual({ x: 2000, y: 12 });
  });
});
