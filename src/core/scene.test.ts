import { describe, expect, it } from 'vitest';
import { blockersOf, buildScene, defaultStandpoint } from './scene';
import { createOpening } from './openings';
import { createCatalogItem, type ItemDraft } from './catalog';
import { commitRoomRect } from './tools';
import { createDocument, type Placement, type SpaceDocument } from './document';

let seq = 0;
const id = () => `id-${seq++}`;

const RUG: ItemDraft = {
  name: 'Rug',
  category: 'rug',
  shape: 'rect',
  widthMm: 2000,
  depthMm: 1400,
  heightMm: 10,
  voidBelowMm: 0,
};

const LAMP: ItemDraft = {
  name: 'Lamp',
  category: 'lighting',
  shape: 'circle',
  widthMm: 300,
  depthMm: 300,
  heightMm: 500,
  voidBelowMm: 0,
};

/** A 5m × 4m room with four walls, and nothing in it. */
function room(): SpaceDocument {
  seq = 0;
  const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
  const built = commitRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 }, {
    name: 'Room',
    makeId: id,
  })!;
  doc.floors[0]!.rooms.push(built.room);
  doc.floors[0]!.walls.push(...built.walls);
  return doc;
}

function place(doc: SpaceDocument, draft: ItemDraft, at: { x: number; y: number }, over: Partial<Placement> = {}) {
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
    ...over,
  };
  doc.floors[0]!.placements.push(placement);
  return placement;
}

describe('buildScene', () => {
  it('turns each wall into one solid when nothing is cut into it', () => {
    const doc = room();
    const scene = buildScene(doc, doc.floors[0]!);

    expect(scene.solids).toHaveLength(4);
    expect(scene.solids.every((s) => s.span.bottom === 0 && s.span.top === 2438)).toBe(true);
    expect(new Set(scene.solids.map((s) => s.ref.id)).size).toBe(4);
  });

  it('splits a wall around a doorway, leaving only the lintel above it', () => {
    const doc = room();
    const north = doc.floors[0]!.walls[0]!;
    doc.floors[0]!.openings.push(
      createOpening({ id: 'o', wall: north, kind: 'door', centreMm: 2500 }),
    );

    const scene = buildScene(doc, doc.floors[0]!);
    const pieces = scene.solids.filter((s) => s.ref.id === north.id);

    expect(pieces).toHaveLength(3);
    // The only solid over the doorway starts at the head height. That, and nothing
    // else, is what makes the doorway walkable.
    const lintel = pieces.find((p) => p.span.bottom === 2032)!;
    expect(lintel.span.top).toBe(2438);
    expect(pieces.filter((p) => p.span.bottom === 0)).toHaveLength(2);
  });

  it('gives every room a floor and a ceiling slab', () => {
    const doc = room();
    const scene = buildScene(doc, doc.floors[0]!);

    expect(scene.slabs.map((s) => s.kind).sort()).toEqual(['ceiling', 'floor']);
    expect(scene.slabs.find((s) => s.kind === 'ceiling')!.elevationMm).toBe(2438);
  });

  it('carries a placement’s solid span, not its full height', () => {
    // The same `voidBelowMm` the plan view and the collision engine use — a rug is
    // 10mm of solid, and the 3D view must not draw or block more than that.
    const doc = room();
    place(doc, RUG, { x: 2500, y: 2000 });

    const scene = buildScene(doc, doc.floors[0]!);
    const rug = scene.solids.find((s) => s.ref.kind === 'placement')!;
    expect(rug.span).toEqual({ bottom: 0, top: 10 });
  });

  it('raises a surface-mounted item onto its host', () => {
    const doc = room();
    const host = place(doc, { ...RUG, name: 'Table', heightMm: 760, voidBelowMm: 720 }, { x: 2500, y: 2000 });
    place(doc, LAMP, { x: 2500, y: 2000 }, { mount: { kind: 'surface', hostId: host.id } });

    const scene = buildScene(doc, doc.floors[0]!);
    const lamp = scene.solids.find((s) => s.id !== host.id && s.ref.kind === 'placement')!;
    expect(lamp.span).toEqual({ bottom: 760, top: 1260 });
  });

  it('skips a placement whose item is gone rather than failing the whole view', () => {
    const doc = room();
    place(doc, RUG, { x: 2500, y: 2000 });
    doc.catalog = [];

    const scene = buildScene(doc, doc.floors[0]!);
    expect(scene.solids.every((s) => s.ref.kind === 'wall')).toBe(true);
  });

  it('skips a mount cycle rather than recursing into the renderer', () => {
    const doc = room();
    const a = place(doc, LAMP, { x: 1000, y: 1000 });
    const b = place(doc, LAMP, { x: 1000, y: 1000 });
    a.mount = { kind: 'surface', hostId: b.id };
    b.mount = { kind: 'surface', hostId: a.id };

    const scene = buildScene(doc, doc.floors[0]!);
    expect(scene.solids.filter((s) => s.ref.kind === 'placement')).toHaveLength(0);
  });

  it('stands an over-dropped ceiling item on the floor rather than sinking it', () => {
    // 3000mm of pendant in a 2438mm room resolves to an elevation of −562. The part
    // below the slab would be invisible and would still block the walker, so it is
    // clamped — the item is really in the room, and validation is what says the drop
    // is wrong.
    const doc = room();
    place(doc, { ...LAMP, heightMm: 3000 }, { x: 2500, y: 2000 }, {
      mount: { kind: 'ceiling', drop: 0 },
    });

    const scene = buildScene(doc, doc.floors[0]!);
    const pendant = scene.solids.find((s) => s.ref.kind === 'placement')!;
    expect(pendant.span).toEqual({ bottom: 0, top: 2438 });
  });

  it('reports an empty floor as having no extent, rather than a point at the origin', () => {
    const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
    expect(buildScene(doc, doc.floors[0]!).bounds).toBeNull();
  });
});

describe('blockersOf', () => {
  it('is exactly the solids, as collision volumes', () => {
    const doc = room();
    place(doc, RUG, { x: 2500, y: 2000 });
    const scene = buildScene(doc, doc.floors[0]!);

    expect(blockersOf(scene)).toHaveLength(scene.solids.length);
  });
});

describe('defaultStandpoint', () => {
  it('is the middle of the largest room, not the origin', () => {
    // A plan traced from an imported raster can sit anywhere; dropping the walker at
    // 0,0 would routinely start them outside the building.
    const doc = room();
    expect(defaultStandpoint(doc.floors[0]!, buildScene(doc, doc.floors[0]!))).toEqual({
      x: 2500,
      y: 2000,
    });
  });

  it('falls back to the middle of everything drawn when no room is traced', () => {
    const doc = room();
    doc.floors[0]!.rooms = [];
    const scene = buildScene(doc, doc.floors[0]!);
    const at = defaultStandpoint(doc.floors[0]!, scene);

    expect(at.x).toBeCloseTo(2500, 6);
    expect(at.y).toBeCloseTo(2000, 6);
  });

  it('is the origin only when there is genuinely nothing', () => {
    const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
    expect(defaultStandpoint(doc.floors[0]!, buildScene(doc, doc.floors[0]!))).toEqual({
      x: 0,
      y: 0,
    });
  });
});
