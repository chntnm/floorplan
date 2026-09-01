import { describe, expect, it } from 'vitest';
import { rectFootprint } from './geometry/footprint';
import { bounds, polygon, area as polyArea } from './geometry/polygon';
import {
  createDocument,
  type CatalogItem,
  type Placement,
  type Room,
  type SpaceDocument,
} from './document';
import {
  MountCycleError,
  ceilingHeightAt,
  effectiveHeight,
  exceedsHeadroom,
  placementSpan,
  resolveElevation,
  roomOf,
  surfaceHeight,
  worldOutline,
} from './placement';

function item(over: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    name: over.id,
    category: 'other',
    widthMm: 1000,
    depthMm: 500,
    heightMm: 750,
    voidBelowMm: 0,
    canHostSurface: false,
    footprint: rectFootprint(over.widthMm ?? 1000, over.depthMm ?? 500),
    defaultMount: 'floor',
    color: '#888',
    quantityOwned: 1,
    ...over,
  };
}

function place(over: Partial<Placement> & { id: string; itemId: string }): Placement {
  return {
    floorId: 'floor-1',
    position: { x: 0, y: 0 },
    rotation: 0,
    mount: { kind: 'floor' },
    elevation: 0,
    ...over,
  };
}

function docWith(items: CatalogItem[], placements: Placement[], rooms: Room[] = []): SpaceDocument {
  const doc = createDocument({ id: 'doc', floorId: 'floor-1', now: '2026-09-01T00:00:00.000Z' });
  doc.catalog = items;
  doc.floors[0]!.placements = placements;
  doc.floors[0]!.rooms = rooms;
  return doc;
}

describe('worldOutline', () => {
  const desk = item({ id: 'desk', widthMm: 1600, depthMm: 800 });

  it('translates to the placement position', () => {
    const out = worldOutline(place({ id: 'p', itemId: 'desk', position: { x: 3000, y: 2000 } }), desk);
    expect(bounds(out)).toEqual({ minX: 2200, minY: 1600, maxX: 3800, maxY: 2400 });
  });

  it('swaps extents at 90°', () => {
    const out = worldOutline(place({ id: 'p', itemId: 'desk', rotation: 90 }), desk);
    const b = bounds(out);
    expect(b.maxX - b.minX).toBe(800);
    expect(b.maxY - b.minY).toBe(1600);
  });

  it('preserves area under rotation', () => {
    const exact = 1600 * 800;
    for (const rotation of [0, 15, 37, 90, 180, 271]) {
      const out = worldOutline(place({ id: 'p', itemId: 'desk', rotation }), desk);
      // World vertices snap to integer mm, so a rotated rectangle's area shifts by
      // roughly perimeter × ½mm. On a 1.28 m² desk that is well under 0.5%.
      expect(Math.abs(polyArea(out) - exact) / exact, `${rotation}°`).toBeLessThan(0.005);
    }
  });

  it('does not accumulate error — 24 separate 15° queries land exactly on 360°', () => {
    // The reason rotation is never baked into stored vertices: each query derives
    // from the pristine local footprint, so repeated rotation cannot drift.
    const at0 = worldOutline(place({ id: 'p', itemId: 'desk', rotation: 0 }), desk);
    const at360 = worldOutline(place({ id: 'p', itemId: 'desk', rotation: 360 }), desk);
    expect(at360.pts).toEqual(at0.pts);
  });

  it('mirrors when flipped, without changing area', () => {
    const l = item({
      id: 'sectional',
      footprint: {
        generator: { kind: 'lshape', w: 2400, d: 2000, cutW: 900, cutD: 800, corner: 'ne' },
        outline: polygon([
          { x: -1200, y: -1000 },
          { x: -1200, y: 1000 },
          { x: 1200, y: 1000 },
          { x: 1200, y: -200 },
          { x: 300, y: -200 },
          { x: 300, y: -1000 },
        ]),
      },
    });
    const normal = worldOutline(place({ id: 'p', itemId: 'sectional' }), l);
    const flipped = worldOutline(place({ id: 'p', itemId: 'sectional', flipped: true }), l);
    expect(polyArea(flipped)).toBeCloseTo(polyArea(normal), 6);
    expect(flipped.pts).not.toEqual(normal.pts);
  });
});

describe('resolveElevation', () => {
  it('puts floor mounts on the floor', () => {
    const doc = docWith([item({ id: 'a' })], [place({ id: 'p1', itemId: 'a' })]);
    expect(resolveElevation(doc, doc.floors[0]!.placements[0]!)).toBe(0);
  });

  it('uses the stored elevation for wall mounts', () => {
    const doc = docWith(
      [item({ id: 'shelf', heightMm: 300 })],
      [place({ id: 'p1', itemId: 'shelf', mount: { kind: 'wall', wallId: 'w1' }, elevation: 1400 })],
    );
    expect(resolveElevation(doc, doc.floors[0]!.placements[0]!)).toBe(1400);
  });

  it('stacks a surface mount on its host', () => {
    const doc = docWith(
      [
        item({ id: 'nightstand', heightMm: 600, canHostSurface: true }),
        item({ id: 'lamp', heightMm: 400 }),
      ],
      [
        place({ id: 'host', itemId: 'nightstand' }),
        place({ id: 'child', itemId: 'lamp', mount: { kind: 'surface', hostId: 'host' } }),
      ],
    );
    expect(resolveElevation(doc, doc.floors[0]!.placements[1]!)).toBe(600);
  });

  it('uses surfaceHeightMm when the usable top is not the full height', () => {
    // A desk with a hutch: surface at 750, total height 1400.
    const doc = docWith(
      [
        item({ id: 'desk', heightMm: 1400, surfaceHeightMm: 750, canHostSurface: true }),
        item({ id: 'monitor', heightMm: 450 }),
      ],
      [
        place({ id: 'host', itemId: 'desk' }),
        place({ id: 'child', itemId: 'monitor', mount: { kind: 'surface', hostId: 'host' } }),
      ],
    );
    expect(surfaceHeight(doc.floors[0]!.placements[0]!, doc.catalog[0]!)).toBe(750);
    expect(resolveElevation(doc, doc.floors[0]!.placements[1]!)).toBe(750);
  });

  it('stacks three deep', () => {
    const doc = docWith(
      [
        item({ id: 'table', heightMm: 750, canHostSurface: true }),
        item({ id: 'tray', heightMm: 50, canHostSurface: true }),
        item({ id: 'cup', heightMm: 100 }),
      ],
      [
        place({ id: 'a', itemId: 'table' }),
        place({ id: 'b', itemId: 'tray', mount: { kind: 'surface', hostId: 'a' } }),
        place({ id: 'c', itemId: 'cup', mount: { kind: 'surface', hostId: 'b' } }),
      ],
    );
    expect(resolveElevation(doc, doc.floors[0]!.placements[2]!)).toBe(800);
  });

  it('throws on a surface-mount cycle instead of recursing forever', () => {
    const doc = docWith(
      [item({ id: 'a', canHostSurface: true })],
      [
        place({ id: 'p1', itemId: 'a', mount: { kind: 'surface', hostId: 'p2' } }),
        place({ id: 'p2', itemId: 'a', mount: { kind: 'surface', hostId: 'p1' } }),
      ],
    );
    expect(() => resolveElevation(doc, doc.floors[0]!.placements[0]!)).toThrow(MountCycleError);
  });

  it('degrades a dangling host to the floor rather than failing to open', () => {
    const doc = docWith(
      [item({ id: 'lamp' })],
      [place({ id: 'p1', itemId: 'lamp', mount: { kind: 'surface', hostId: 'deleted' } })],
    );
    expect(resolveElevation(doc, doc.floors[0]!.placements[0]!)).toBe(0);
  });

  it('hangs a ceiling mount below the ceiling', () => {
    const doc = docWith(
      [item({ id: 'pendant', heightMm: 300 })],
      [place({ id: 'p1', itemId: 'pendant', mount: { kind: 'ceiling', drop: 500 } })],
    );
    // Default ceiling 2438 − 500 drop − 300 tall = 1638 base.
    expect(resolveElevation(doc, doc.floors[0]!.placements[0]!)).toBe(1638);
  });
});

describe('room resolution', () => {
  const room: Room = {
    id: 'r1',
    name: 'Living',
    boundary: polygon([
      { x: 0, y: 0 },
      { x: 0, y: 4000 },
      { x: 5000, y: 4000 },
      { x: 5000, y: 0 },
    ]),
    ceilingHeightMm: 3000,
    areaMm2: 20_000_000,
  };

  it('finds the room a placement stands in', () => {
    const doc = docWith(
      [item({ id: 'a' })],
      [place({ id: 'p1', itemId: 'a', position: { x: 2500, y: 2000 } })],
      [room],
    );
    expect(roomOf(doc, doc.floors[0]!.placements[0]!)?.id).toBe('r1');
    expect(ceilingHeightAt(doc, doc.floors[0]!.placements[0]!)).toBe(3000);
  });

  it('falls back to the floor default outside every traced room', () => {
    const doc = docWith(
      [item({ id: 'a' })],
      [place({ id: 'p1', itemId: 'a', position: { x: 9000, y: 9000 } })],
      [room],
    );
    expect(roomOf(doc, doc.floors[0]!.placements[0]!)).toBeUndefined();
    expect(ceilingHeightAt(doc, doc.floors[0]!.placements[0]!)).toBe(2438);
  });

  it('tracks the room a placement moves into — nothing is stored to go stale', () => {
    const low: Room = { ...room, id: 'r2', ceilingHeightMm: 2100 };
    low.boundary = polygon([
      { x: 6000, y: 0 },
      { x: 6000, y: 4000 },
      { x: 9000, y: 4000 },
      { x: 9000, y: 0 },
    ]);
    const doc = docWith(
      [item({ id: 'a' })],
      [place({ id: 'p1', itemId: 'a', position: { x: 2500, y: 2000 } })],
      [room, low],
    );
    const p = doc.floors[0]!.placements[0]!;
    expect(ceilingHeightAt(doc, p)).toBe(3000);
    p.position = { x: 7500, y: 2000 };
    expect(ceilingHeightAt(doc, p)).toBe(2100);
  });
});

describe('headroom', () => {
  it('flags a bookcase that breaks through a low ceiling', () => {
    const lowRoom: Room = {
      id: 'r1',
      name: 'Attic',
      boundary: polygon([
        { x: 0, y: 0 },
        { x: 0, y: 4000 },
        { x: 4000, y: 4000 },
        { x: 4000, y: 0 },
      ]),
      ceilingHeightMm: 2050,
      areaMm2: 16_000_000,
    };
    const doc = docWith(
      [item({ id: 'bookcase', heightMm: 2100 })],
      [place({ id: 'p1', itemId: 'bookcase', position: { x: 2000, y: 2000 } })],
      [lowRoom],
    );
    expect(exceedsHeadroom(doc, doc.floors[0]!.placements[0]!, doc.catalog[0]!)).toBe(true);
  });

  it('passes the same bookcase under a standard ceiling', () => {
    const doc = docWith(
      [item({ id: 'bookcase', heightMm: 2100 })],
      [place({ id: 'p1', itemId: 'bookcase' })],
    );
    expect(exceedsHeadroom(doc, doc.floors[0]!.placements[0]!, doc.catalog[0]!)).toBe(false);
  });
});

describe('placementSpan', () => {
  it('honours voidBelowMm and the resolved elevation together', () => {
    const doc = docWith(
      [item({ id: 'table', heightMm: 750, voidBelowMm: 720 })],
      [place({ id: 'p1', itemId: 'table' })],
    );
    expect(placementSpan(doc, doc.floors[0]!.placements[0]!, doc.catalog[0]!)).toEqual({
      bottom: 720,
      top: 750,
    });
  });

  it('applies a per-placement height override', () => {
    const doc = docWith(
      [item({ id: 'a', heightMm: 750 })],
      [place({ id: 'p1', itemId: 'a', overrides: { heightMm: 900 } })],
    );
    expect(effectiveHeight(doc.floors[0]!.placements[0]!, doc.catalog[0]!)).toBe(900);
  });
});
