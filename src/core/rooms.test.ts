import { describe, expect, it } from 'vitest';
import {
  JOIN_TOLERANCE_MM,
  detectLoops,
  detectRooms,
  sameRing,
  uniqueRoomName,
} from './rooms';
import { commitRoomRect } from './tools';
import { createDocument, type Floor, type Room, type Wall } from './document';
import { area, bounds, isCounterClockwise, polygon } from './geometry/polygon';
import type { Vec2 } from './geometry/vec';

let seq = 0;
const nextId = () => `x${seq++}`;

function wall(a: Vec2, b: Vec2): Wall {
  return { id: nextId(), a, b, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 };
}

/** The four walls of an axis-aligned rectangle, on its centrelines. */
function rectWalls(minX: number, minY: number, maxX: number, maxY: number): Wall[] {
  const c: Vec2[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
  return c.map((p, i) => wall(p, c[(i + 1) % 4]!));
}

function floorWith(walls: Wall[], rooms: Room[] = []): Floor {
  const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
  const floor = doc.floors[0]!;
  floor.walls = walls;
  floor.rooms = rooms;
  return floor;
}

const areas = (loops: { pts: Vec2[] }[]) =>
  loops.map((l) => Math.round(area(polygon(l.pts)))).sort((a, b) => a - b);

describe('finding loops in the wall graph', () => {
  it('finds the one room a closed rectangle encloses', () => {
    const loops = detectLoops(rectWalls(0, 0, 4000, 3000));

    expect(loops).toHaveLength(1);
    expect(area(loops[0]!)).toBe(12_000_000);
  });

  it('finds two rooms that share a wall, not one room around both', () => {
    // The discriminating fixture. A single rectangle's interior and outer faces have
    // the same |area| and opposite signs, so a test on one room passes even if the
    // outer face was kept. Two rooms is where keeping the wrong one shows up: it
    // gives one loop of 24m² instead of two of 12m².
    const loops = detectLoops([
      ...rectWalls(0, 0, 4000, 3000),
      ...rectWalls(4000, 0, 8000, 3000),
    ]);

    expect(loops).toHaveLength(2);
    expect(areas(loops)).toEqual([12_000_000, 12_000_000]);
  });

  it('winds every loop counter-clockwise, the convention every other polygon uses', () => {
    const loops = detectLoops(rectWalls(0, 0, 4000, 3000));
    expect(isCounterClockwise(loops[0]!)).toBe(true);
  });

  it('splits a wall at a T-junction so a partition makes two rooms', () => {
    // A partition butting into the middle of a wall has its endpoint on that wall's
    // *interior*. Without splitting there is no node there, the graph has no branch,
    // and the walk hands back the single loop around the outside.
    const loops = detectLoops([
      ...rectWalls(0, 0, 4000, 3000),
      wall({ x: 1500, y: 0 }, { x: 1500, y: 3000 }),
    ]);

    expect(areas(loops)).toEqual([4_500_000, 7_500_000]);
  });

  it('still splits when the partition lands a couple of millimetres off', () => {
    // Traced by hand over an imported plan, an endpoint does not land on the
    // centreline. Two millimetres out is inside the join tolerance and must still
    // close the cycle.
    const loops = detectLoops([
      ...rectWalls(0, 0, 4000, 3000),
      wall({ x: 1500, y: 2 }, { x: 1502, y: 2998 }),
    ]);

    expect(loops).toHaveLength(2);
  });

  it('does not weld a partition that misses by more than the tolerance', () => {
    // A gap wider than the tolerance is a doorway-sized hole, and the two "rooms"
    // really are one space. Reporting two would be inventing a wall.
    const loops = detectLoops([
      ...rectWalls(0, 0, 4000, 3000),
      wall({ x: 1500, y: JOIN_TOLERANCE_MM * 5 }, { x: 1500, y: 3000 }),
    ]);

    expect(loops).toHaveLength(1);
    expect(area(loops[0]!)).toBe(12_000_000);
  });

  it('cuts both walls where two cross in the middle', () => {
    const loops = detectLoops([
      ...rectWalls(0, 0, 4000, 4000),
      wall({ x: 2000, y: 0 }, { x: 2000, y: 4000 }),
      wall({ x: 0, y: 2000 }, { x: 4000, y: 2000 }),
    ]);

    expect(areas(loops)).toEqual([4_000_000, 4_000_000, 4_000_000, 4_000_000]);
  });

  it('ignores a spur that encloses nothing', () => {
    const loops = detectLoops([
      ...rectWalls(0, 0, 4000, 3000),
      wall({ x: 2000, y: 3000 }, { x: 2000, y: 5000 }),
    ]);

    expect(loops).toHaveLength(1);
    expect(area(loops[0]!)).toBe(12_000_000);
  });

  it('finds nothing in walls that do not close', () => {
    expect(
      detectLoops([
        wall({ x: 0, y: 0 }, { x: 4000, y: 0 }),
        wall({ x: 4000, y: 0 }, { x: 4000, y: 3000 }),
      ]),
    ).toEqual([]);
  });

  it('keeps a courtyard as its own room, inside the ring around it', () => {
    // Polygons here have no holes, so an island of walls does not punch one. The
    // outer room's area includes the courtyard, which is stated in the module rather
    // than quietly wrong.
    const loops = detectLoops([
      ...rectWalls(0, 0, 6000, 6000),
      ...rectWalls(2000, 2000, 4000, 4000),
    ]);

    expect(areas(loops)).toEqual([4_000_000, 36_000_000]);
  });

  it('drops a sliver between two near-parallel walls', () => {
    const loops = detectLoops([
      wall({ x: 0, y: 0 }, { x: 4000, y: 0 }),
      wall({ x: 4000, y: 0 }, { x: 4000, y: 2 }),
      wall({ x: 4000, y: 2 }, { x: 0, y: 2 }),
      wall({ x: 0, y: 2 }, { x: 0, y: 0 }),
    ]);

    expect(loops).toEqual([]);
  });

  it('starts every ring at the same corner however the walk entered it', () => {
    // Canonicalising the start is what makes a second run a no-op instead of a
    // rewrite of every boundary in the document.
    const a = detectLoops(rectWalls(0, 0, 4000, 3000));
    const b = detectLoops([...rectWalls(0, 0, 4000, 3000)].reverse());

    expect(sameRing(a[0]!, b[0]!)).toBe(true);
    expect(a[0]!.pts[0]).toEqual({ x: 0, y: 0 });
  });
});

describe('agreeing with a room drawn by hand', () => {
  it('detects exactly the boundary and area the Room tool committed', () => {
    // The two paths have to describe the same walls with the same number, or a plan
    // half drawn and half detected reports two different areas for two identical
    // rooms. Boundaries are centrelines in both.
    const drawn = commitRoomRect({ x: 0, y: 0 }, { x: 4000, y: 3000 }, {
      name: 'Living',
      makeId: nextId,
    })!;
    const loops = detectLoops(drawn.walls);

    expect(loops).toHaveLength(1);
    expect(sameRing(loops[0]!, drawn.room.boundary)).toBe(true);
    expect(Math.round(area(loops[0]!))).toBe(drawn.room.areaMm2);
  });
});

describe('reconciling with the rooms already there', () => {
  it('is a no-op the second time, once the boundaries match', () => {
    const drawn = commitRoomRect({ x: 0, y: 0 }, { x: 4000, y: 3000 }, {
      name: 'Living',
      makeId: nextId,
    })!;
    const floor = floorWith(drawn.walls, [drawn.room]);

    expect(detectRooms(floor, { makeId: nextId })).toEqual({
      updated: [],
      added: [],
      unmatched: [],
    });
  });

  it('adds a room for a loop nothing covers', () => {
    const floor = floorWith(rectWalls(0, 0, 4000, 3000));
    const result = detectRooms(floor, { makeId: nextId });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('Room 1');
    expect(result.added[0]!.areaMm2).toBe(12_000_000);
    expect(result.added[0]!.ceilingHeightMm).toBe(floor.defaultCeilingHeightMm);
  });

  it('keeps the name and ceiling height of the room it matched', () => {
    // The boundary is derived; everything a person chose is not.
    const floor = floorWith(rectWalls(0, 0, 4000, 3000), [
      {
        id: 'r1',
        name: 'Living room',
        boundary: polygon([
          { x: 100, y: 100 },
          { x: 3900, y: 100 },
          { x: 3900, y: 2900 },
          { x: 100, y: 2900 },
        ]),
        ceilingHeightMm: 3200,
        areaMm2: 10_640_000,
      },
    ]);

    const result = detectRooms(floor, { makeId: nextId });
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([
      { roomId: 'r1', boundary: expect.anything(), areaMm2: 12_000_000 },
    ]);
    // Nothing in the plan touches the name or the ceiling: they are not in it.
    expect(Object.keys(result.updated[0]!)).toEqual(['roomId', 'boundary', 'areaMm2']);
  });

  it('gives the larger half of a partitioned room the old name', () => {
    // Overlap area rather than centroid containment, because a partition can leave
    // the old centroid in either half — or inside the partition itself.
    const existing: Room = {
      id: 'r1',
      name: 'Living room',
      boundary: polygon([
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 },
        { x: 0, y: 3000 },
      ]),
      ceilingHeightMm: 2438,
      areaMm2: 12_000_000,
    };
    const floor = floorWith(
      [...rectWalls(0, 0, 4000, 3000), wall({ x: 1500, y: 0 }, { x: 1500, y: 3000 })],
      [existing],
    );

    const result = detectRooms(floor, { makeId: nextId });
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]!.roomId).toBe('r1');
    expect(result.updated[0]!.areaMm2).toBe(7_500_000); // the 2500-wide half
    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.areaMm2).toBe(4_500_000);
  });

  it('reports a room no loop supports, and leaves it alone', () => {
    // An Area-tool room has no walls at all. Deleting unmatched rooms would remove a
    // legitimate one on every run.
    const floor = floorWith(rectWalls(0, 0, 4000, 3000), [
      {
        id: 'circle',
        name: 'Terrace',
        boundary: polygon([
          { x: 10_000, y: 0 },
          { x: 12_000, y: 0 },
          { x: 11_000, y: 2000 },
        ]),
        ceilingHeightMm: 2438,
        areaMm2: 2_000_000,
      },
    ]);

    const result = detectRooms(floor, { makeId: nextId });
    expect(result.unmatched).toEqual(['circle']);
    expect(result.added).toHaveLength(1);
  });

  it('names new rooms around the ones already named', () => {
    expect(uniqueRoomName('Room 1', [{ name: 'Room 1' }])).toBe('Room 1 2');
    expect(uniqueRoomName('Room 1', [])).toBe('Room 1');
  });
});

describe('sameRing', () => {
  it('is false for the same shape started at a different corner', () => {
    // Which is the whole reason rings are canonicalised before they are compared.
    const a = polygon([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    const b = polygon([
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
    ]);

    expect(sameRing(a, b)).toBe(false);
    expect(bounds(a)).toEqual(bounds(b));
  });
});
