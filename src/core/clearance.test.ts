import { describe, expect, it } from 'vitest';
import {
  CLEARANCE_STEP_OVER_MM,
  findClearanceViolations,
  floorZones,
  zoneOutline,
  zoneSpan,
} from './clearance';
import { createCatalogItem, type ItemDraft } from './catalog';
import { createDocument, type ClearanceZone, type Placement, type SpaceDocument } from './document';
import { bounds } from './geometry/polygon';

const DRAWER: ClearanceZone = { edge: 'front', depthMm: 900, reason: 'drawer pull' };

/** A 1500 × 500 × 810 dresser that needs 900mm in front of it. */
const DRESSER: ItemDraft = {
  name: 'Dresser',
  category: 'storage',
  shape: 'rect',
  widthMm: 1500,
  depthMm: 500,
  heightMm: 810,
  voidBelowMm: 0,
  clearances: [DRAWER],
};

const BOX: ItemDraft = {
  name: 'Box',
  category: 'other',
  shape: 'rect',
  widthMm: 400,
  depthMm: 400,
  heightMm: 400,
  voidBelowMm: 0,
};

const RUG: ItemDraft = {
  name: 'Rug',
  category: 'rug',
  shape: 'rect',
  widthMm: 2000,
  depthMm: 2000,
  heightMm: 10,
  voidBelowMm: 0,
};

let seq = 0;

function doc(): SpaceDocument {
  seq = 0;
  return createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
}

function place(
  d: SpaceDocument,
  draft: ItemDraft,
  at: { x: number; y: number },
  over: Partial<Placement> = {},
): Placement {
  const item = createCatalogItem(draft, `i-${seq++}`);
  d.catalog.push(item);
  const placement: Placement = {
    id: `p-${seq++}`,
    itemId: item.id,
    floorId: 'f',
    position: at,
    rotation: 0,
    mount: { kind: 'floor' },
    elevation: 0,
    ...over,
  };
  d.floors[0]!.placements.push(placement);
  return placement;
}

function violations(d: SpaceDocument) {
  return findClearanceViolations(d, d.floors[0]!);
}

describe('where a zone sits', () => {
  it('extends from the front edge, into the room', () => {
    // Local +y is the front: wall snap seats the back edge (local −y) on the wall,
    // so the front is what faces away from it.
    const d = doc();
    const dresser = place(d, DRESSER, { x: 0, y: 0 });
    const item = d.catalog[0]!;

    expect(bounds(zoneOutline(dresser, item, DRAWER)!)).toEqual({
      minX: -750,
      maxX: 750,
      minY: 250, // half the 500 depth
      maxY: 1150, // + 900
    });
  });

  it('turns with the item it belongs to', () => {
    const d = doc();
    const dresser = place(d, DRESSER, { x: 0, y: 0 }, { rotation: 90 });
    const box = bounds(zoneOutline(dresser, d.catalog[0]!, DRAWER)!);

    // Turned a quarter, the drawer clearance now runs along −x.
    expect(box.minX).toBe(-1150);
    expect(box.maxX).toBe(-250);
    expect(box.minY).toBe(-750);
    expect(box.maxY).toBe(750);
  });

  it('mirrors a side zone when the item is flipped', () => {
    // Mirroring an item really does move its left-hand drawer to the other side, and
    // it falls out of putting the zone through the same transform as the outline.
    const d = doc();
    const left: ClearanceZone = { edge: 'left', depthMm: 300, reason: 'side access' };
    const normal = place(d, DRESSER, { x: 0, y: 0 });
    const flipped = place(d, DRESSER, { x: 0, y: 0 }, { flipped: true });

    expect(bounds(zoneOutline(normal, d.catalog[0]!, left)!).minX).toBe(-1050);
    expect(bounds(zoneOutline(flipped, d.catalog[1]!, left)!).maxX).toBe(1050);
  });

  it('takes a circular item off its bounding box', () => {
    // The only edge a round table has. Stated rather than approximated with an
    // offset curve nobody is asking for.
    const d = doc();
    const round = place(d, { ...DRESSER, shape: 'circle', widthMm: 1200, depthMm: 1200 }, { x: 0, y: 0 });
    const box = bounds(zoneOutline(round, d.catalog[0]!, DRAWER)!);

    expect(box.minY).toBe(600);
    expect(box.maxY).toBe(1500);
  });

  it('runs from the floor to the height the zone declares', () => {
    const d = doc();
    const dresser = place(d, DRESSER, { x: 0, y: 0 });

    expect(zoneSpan(d, dresser, d.catalog[0]!, DRAWER)).toEqual({ bottom: 0, top: 810 });
    expect(zoneSpan(d, dresser, d.catalog[0]!, { ...DRAWER, heightMm: 400 })).toEqual({
      bottom: 0,
      top: 400,
    });
  });

  it('is nothing at all for an item that declares none', () => {
    const d = doc();
    place(d, BOX, { x: 0, y: 0 });
    expect(floorZones(d, d.floors[0]!)).toHaveLength(0);
  });
});

describe('what blocks a zone', () => {
  it('reports a box standing in front of the drawers', () => {
    const d = doc();
    const dresser = place(d, DRESSER, { x: 0, y: 0 });
    const box = place(d, BOX, { x: 0, y: 600 });

    const found = violations(d);
    expect(found).toHaveLength(1);
    expect(found[0]!.placementId).toBe(dresser.id);
    expect(found[0]!.intruderId).toBe(box.id);
    expect(found[0]!.zone.reason).toBe('drawer pull');
  });

  it('says nothing once the box is moved clear', () => {
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    place(d, BOX, { x: 0, y: 1500 }); // past the 1150 the zone reaches to

    expect(violations(d)).toEqual([]);
  });

  it('lets a rug lie in front of a dresser', () => {
    // The threshold is a property of the intruder, not of the zone: what makes the
    // rug irrelevant is that you step over it, and the zone still runs to the floor
    // so a low box is caught.
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    place(d, RUG, { x: 0, y: 600 });

    expect(violations(d)).toEqual([]);
  });

  it('still catches something low enough to trip over but too tall to step over', () => {
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    place(d, { ...BOX, name: 'Shoe rack', heightMm: CLEARANCE_STEP_OVER_MM + 50 }, { x: 0, y: 600 });

    expect(violations(d)).toHaveLength(1);
  });

  it('does not report an item against its own zone', () => {
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    expect(violations(d)).toEqual([]);
  });

  it('ignores a wall the item is pushed against', () => {
    // Walls are not obstructions here, the same rule door swing settled: wall snap
    // seats the back edge *on* the wall face, so a back zone tested against walls
    // would fire on every chair pushed against one. The walkway probe is the check
    // that includes walls.
    const d = doc();
    const chair: ItemDraft = {
      ...BOX,
      name: 'Dining chair',
      heightMm: 900,
      clearances: [{ edge: 'back', depthMm: 1067, reason: 'chair pull-out' }],
    };
    d.floors[0]!.walls.push({
      id: 'w1',
      a: { x: -2000, y: -300 },
      b: { x: 2000, y: -300 },
      thicknessMm: 114,
      heightMm: 2438,
      baseElevationMm: 0,
    });
    place(d, chair, { x: 0, y: 0 });

    expect(violations(d)).toEqual([]);
  });

  it('sorts the worst intrusion first', () => {
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    place(d, BOX, { x: -600, y: 1100 }); // clipping the far corner of the zone
    const deep = place(d, BOX, { x: 0, y: 500 }); // squarely in it

    expect(violations(d)[0]!.intruderId).toBe(deep.id);
  });

  it('respects the zone height — a shelf above the drawers is not in their way', () => {
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    place(
      d,
      { ...BOX, name: 'Wall shelf', heightMm: 300 },
      { x: 0, y: 600 },
      { mount: { kind: 'wall', wallId: 'w1' }, elevation: 1200 },
    );

    // The dresser's zone stops at 810; the shelf starts at 1200.
    expect(violations(d)).toEqual([]);
  });
});

describe('something sitting on the zoned item itself', () => {
  const LAMP: ItemDraft = {
    name: 'Lamp',
    category: 'lighting',
    shape: 'circle',
    widthMm: 300,
    depthMm: 300,
    heightMm: 500,
    voidBelowMm: 0,
  };

  it('does not report a lamp on the dresser as blocking the dresser drawers', () => {
    // The lamp rides on the host. It cannot be in the way of the host opening,
    // whatever its footprint does — and the zone runs to the floor, so the only
    // thing keeping this quiet by accident is the zone top and the surface height
    // being the same number.
    const d = doc();
    const dresser = place(d, { ...DRESSER, clearances: [{ ...DRAWER, heightMm: 900 }] }, { x: 0, y: 0 });
    place(d, LAMP, { x: 0, y: 400 }, { mount: { kind: 'surface', hostId: dresser.id } });

    expect(violations(d)).toEqual([]);
  });

  it('still reports something stacked on a different item nearby', () => {
    // The exemption is "it rides on the host", not "it is off the floor".
    const d = doc();
    place(d, DRESSER, { x: 0, y: 0 });
    const table = place(d, { ...DRESSER, name: 'Side table', heightMm: 500 }, { x: 0, y: 900 });
    place(d, LAMP, { x: 0, y: 600 }, { mount: { kind: 'surface', hostId: table.id } });

    expect(violations(d).length).toBeGreaterThan(0);
  });
});
