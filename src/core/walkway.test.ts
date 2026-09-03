import { describe, expect, it } from 'vitest';
import {
  WALKWAY_MIN_MM,
  isTooNarrow,
  narrowestGap,
  samplePath,
  walkwayObstructions,
} from './walkway';
import { createCatalogItem, type ItemDraft } from './catalog';
import { createOpening } from './openings';
import { commitRoomRect } from './tools';
import { createDocument, type Placement, type SpaceDocument } from './document';
import { polygon } from './geometry/polygon';
import type { Volume } from './geometry/collision';

/** A solid block, floor to 2m, as a plain obstruction. */
function block(minX: number, minY: number, maxX: number, maxY: number): Volume {
  return {
    outline: polygon([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]),
    span: { bottom: 0, top: 2000 },
  };
}

let seq = 0;
const id = () => `id-${seq++}`;

/** A 5m × 4m room with four walls. */
function room(): SpaceDocument {
  seq = 0;
  const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
  const built = commitRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 }, { name: 'Room', makeId: id })!;
  doc.floors[0]!.rooms.push(built.room);
  doc.floors[0]!.walls.push(...built.walls);
  return doc;
}

function place(doc: SpaceDocument, draft: ItemDraft, at: { x: number; y: number }): Placement {
  const item = createCatalogItem(draft, id());
  doc.catalog.push(item);
  const placement: Placement = {
    id: id(),
    itemId: item.id,
    floorId: 'f',
    position: at,
    rotation: 0,
    mount: { kind: 'floor' },
    elevation: 0,
  };
  doc.floors[0]!.placements.push(placement);
  return placement;
}

const SOFA: ItemDraft = {
  name: 'Sofa',
  category: 'seating',
  shape: 'rect',
  widthMm: 2130,
  depthMm: 910,
  heightMm: 840,
  voidBelowMm: 0,
};

describe('sampling the path', () => {
  it('samples both ends of a segment, whatever the step', () => {
    // A path turns where the room pinches, so a vertex that went unsampled would be
    // the answer that went unreported.
    const samples = samplePath([{ x: 0, y: 0 }, { x: 250, y: 0 }], 100);

    expect(samples.map((s) => Math.round(s.at.x))).toEqual([0, 100, 200, 250]);
  });

  it('skips a segment that goes nowhere', () => {
    expect(samplePath([{ x: 0, y: 0 }, { x: 0, y: 0 }], 100)).toEqual([]);
  });

  it('has nothing to sample on a single point', () => {
    expect(samplePath([{ x: 0, y: 0 }], 100)).toEqual([]);
    expect(narrowestGap([{ x: 0, y: 0 }], [])).toBeNull();
  });
});

describe('the narrowest gap', () => {
  it('measures a plain corridor square to the path', () => {
    // Two blocks 800 apart, path down the middle.
    const gap = narrowestGap(
      [{ x: 0, y: -1000 }, { x: 0, y: 1000 }],
      [block(-2000, -2000, -400, 2000), block(400, -2000, 2000, 2000)],
    )!;

    expect(gap.widthMm).toBe(800);
    expect(gap.blocked).toBe(false);
  });

  it('finds the pinch rather than the average', () => {
    // A corridor that narrows to 500 for part of its length.
    const gap = narrowestGap(
      [{ x: 0, y: -1000 }, { x: 0, y: 1000 }],
      [
        block(-2000, -2000, -400, 2000),
        block(400, -2000, 2000, 2000),
        block(-250, -100, -100, 100), // a pillar jutting in
      ],
    )!;

    expect(gap.widthMm).toBe(500); // 100 to the pillar, 400 to the right wall
    expect(Math.abs(gap.at.y)).toBeLessThanOrEqual(100);
  });

  it('reports the far side of a doorway rather than the wall behind it', () => {
    // The ray takes the first crossing, so walking out through a door measures the
    // opening, not whatever is beyond it.
    const gap = narrowestGap(
      [{ x: 0, y: 0 }, { x: 0, y: 500 }],
      [block(-2000, -2000, -400, 2000), block(400, -2000, 2000, 2000)],
    )!;

    expect(gap.widthMm).toBe(800);
  });

  it('says a path through a solid is blocked', () => {
    const gap = narrowestGap([{ x: 0, y: 0 }, { x: 1000, y: 0 }], [block(400, -500, 600, 500)])!;

    expect(gap.blocked).toBe(true);
    expect(gap.widthMm).toBe(0);
  });

  it('caps at the reach when there is nothing to either side', () => {
    const gap = narrowestGap([{ x: 0, y: 0 }, { x: 1000, y: 0 }], [], { maxReachMm: 1500 })!;
    expect(gap.widthMm).toBe(3000);
  });

  it('flags anything under 30 inches', () => {
    const wide = narrowestGap(
      [{ x: 0, y: -500 }, { x: 0, y: 500 }],
      [block(-2000, -2000, -450, 2000), block(450, -2000, 2000, 2000)],
    )!;
    const tight = narrowestGap(
      [{ x: 0, y: -500 }, { x: 0, y: 500 }],
      [block(-2000, -2000, -300, 2000), block(300, -2000, 2000, 2000)],
    )!;

    expect(wide.widthMm).toBe(900);
    expect(isTooNarrow(wide)).toBe(false);
    expect(tight.widthMm).toBe(600);
    expect(isTooNarrow(tight)).toBe(true);
    expect(WALKWAY_MIN_MM).toBe(762);
  });
});

describe('what counts as an obstruction', () => {
  it('includes the walls', () => {
    const doc = room();
    expect(walkwayObstructions(doc, doc.floors[0]!)).toHaveLength(4);
  });

  it('leaves a doorway open to a body, and a window shut', () => {
    // The wall is split around its openings, so this needs no "is this a door" check:
    // a doorway's only solid starts at the lintel, a window's sill wall does not.
    const doc = room();
    const [north, , , west] = doc.floors[0]!.walls;
    doc.floors[0]!.openings.push(
      createOpening({ id: 'door', wall: north!, kind: 'door', centreMm: 2500 }),
      createOpening({ id: 'win', wall: west!, kind: 'window', centreMm: 2000 }),
    );

    const solid = walkwayObstructions(doc, doc.floors[0]!);
    // The north wall is now two flanks (the lintel is above 900); the west wall is
    // whole again because its window's sill wall reaches 914.
    const northPieces = solid.filter((v) => v.outline.pts.every((p) => Math.abs(p.y) < 200));
    expect(northPieces).toHaveLength(2);

    const gap = narrowestGap([{ x: 2500, y: 1000 }, { x: 2500, y: -1000 }], solid)!;
    expect(gap.blocked).toBe(false);
  });

  it('includes a sofa, which a single 900mm ray would have passed straight over', () => {
    // A sofa back is 840. This is the case that decided the band: at PLAN's stated
    // probe height the couch is not there at all, and the probe reports a clear
    // walkway through the middle of it.
    const doc = room();
    place(doc, SOFA, { x: 2500, y: 1000 });

    expect(walkwayObstructions(doc, doc.floors[0]!)).toHaveLength(5);
    expect(walkwayObstructions(doc, doc.floors[0]!, { bottom: 900, top: 901 })).toHaveLength(4);
  });

  it('steps over a rug and ducks under a high shelf', () => {
    const doc = room();
    place(doc, { ...SOFA, name: 'Rug', heightMm: 10, voidBelowMm: 0 }, { x: 2500, y: 2000 });
    doc.floors[0]!.placements.push({
      id: 'shelf',
      itemId: doc.catalog[0]!.id,
      floorId: 'f',
      position: { x: 2500, y: 2500 },
      rotation: 0,
      mount: { kind: 'wall', wallId: 'w' },
      elevation: 1900,
    });

    expect(walkwayObstructions(doc, doc.floors[0]!)).toHaveLength(4); // the walls only
  });

  it('measures the real gap between a sofa and the wall', () => {
    // The sofa is 910 deep, centred 700 from the south wall's inner face, so the gap
    // behind it is 700 − 455 = 245mm. Too tight to walk, and only visible at all
    // because the band reaches the sofa's 840mm back.
    const doc = room();
    place(doc, SOFA, { x: 2500, y: 4000 - 57 - 700 });

    const gap = narrowestGap(
      [{ x: 1000, y: 3800 }, { x: 4000, y: 3800 }],
      walkwayObstructions(doc, doc.floors[0]!),
    )!;

    expect(gap.widthMm).toBeGreaterThan(0);
    expect(isTooNarrow(gap)).toBe(true);
  });
});
