import { describe, expect, it } from 'vitest';
import { OTHER_FLOOR_OPACITY, blockersOf, buildScene, buildStack, defaultStandpoint } from './scene';
import { createOpening } from './openings';
import { createCatalogItem, type ItemDraft } from './catalog';
import { commitRoomRect } from './tools';
import { createDocument, createFloor, type Placement, type SpaceDocument } from './document';

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

describe('leaves in the scene', () => {
  function withOpening(kind: 'door' | 'window' | 'pocket' | 'cased' | 'sliding') {
    const doc = room();
    const wall = doc.floors[0]!.walls[0]!;
    const opening = createOpening({ id: 'o1', wall, kind, centreMm: 2500 });
    doc.floors[0]!.openings.push(opening);
    const scene = buildScene(doc, doc.floors[0]!);
    return { scene, leaf: scene.solids.find((s) => s.id === 'o1:leaf') };
  }

  it('stands a door leaf where the door comes to rest', () => {
    const { leaf } = withOpening('door');
    expect(leaf).toBeDefined();
    expect(leaf!.ref).toEqual({ kind: 'opening', id: 'o1' });
  });

  it('does not let an open door narrow its own doorway', () => {
    // A leaf is drawn open, and you cannot push it. Treating it as solid would make
    // a doorway passable or not depending on how far the door happens to be swung.
    const { scene, leaf } = withOpening('door');
    expect(leaf!.blocking).toBe(false);
    expect(blockersOf(scene).some((v) => v.outline === leaf!.outline)).toBe(false);
  });

  it('glazes a window, and glass stops you', () => {
    const { leaf } = withOpening('window');
    expect(leaf!.blocking).toBe(true);
    expect(leaf!.opacity).toBeLessThan(1);
  });

  it('draws nothing for a pocket door or a cased opening', () => {
    expect(withOpening('pocket').leaf).toBeUndefined();
    expect(withOpening('cased').leaf).toBeUndefined();
  });

  it('parks a sliding leaf over the wall beside the opening', () => {
    const { leaf } = withOpening('sliding');
    expect(leaf).toBeDefined();
    expect(leaf!.blocking).toBe(false);
  });
});

describe('stacking floors', () => {
  /** The 5 x 4 room, plus an identical one on a floor 2738mm up. */
  function twoStorey(): SpaceDocument {
    const doc = room();
    const upstairs = createFloor('up', 'Upstairs', 1);
    upstairs.elevationMm = 2738;
    const built = commitRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 }, {
      name: 'Bedroom',
      makeId: id,
    })!;
    upstairs.rooms.push(built.room);
    upstairs.walls.push(...built.walls);
    doc.floors.push(upstairs);
    return doc;
  }

  it('shifts a floor by its elevation relative to the active datum', () => {
    const doc = twoStorey();
    const stack = buildStack(doc, doc.floors, 'f');

    const ground = stack.solids.filter((s) => s.floorId === 'f');
    const up = stack.solids.filter((s) => s.floorId === 'up');
    expect(ground[0]!.span.bottom).toBe(0);
    expect(up[0]!.span.bottom).toBe(2738);
  });

  it('leaves the active floor where the rest of the application put it', () => {
    // Whichever floor is active keeps the coordinates the plan view, the walker and
    // every collision test already use — the stack shifts the others around it.
    const doc = twoStorey();
    const stack = buildStack(doc, doc.floors, 'up');

    expect(stack.solids.find((s) => s.floorId === 'up')!.span.bottom).toBe(0);
    expect(stack.solids.find((s) => s.floorId === 'f')!.span.bottom).toBe(-2738);
  });

  it('dims every floor that is not the one being edited', () => {
    const doc = twoStorey();
    const stack = buildStack(doc, doc.floors, 'f');

    expect(stack.solids.find((s) => s.floorId === 'f')!.opacity).toBe(1);
    expect(stack.solids.find((s) => s.floorId === 'up')!.opacity).toBe(OTHER_FLOOR_OPACITY);
  });

  it('drops the ceiling of a floor that has another floor over it', () => {
    // The slab above is the ceiling. A lid on every storey hides the stack, which is
    // the whole point of looking at more than one.
    const doc = twoStorey();
    const stack = buildStack(doc, doc.floors, 'f');

    expect(stack.slabs.filter((s) => s.floorId === 'up' && s.kind === 'ceiling')).toEqual([]);
    expect(stack.slabs.filter((s) => s.floorId === 'f' && s.kind === 'ceiling')).toHaveLength(1);
  });

  it('frames every floor it shows, not just the active one', () => {
    // `bounds` feeds the orbit camera. Fitting one storey clips the rest.
    const doc = twoStorey();
    const upstairs = doc.floors[1]!;
    for (const wall of upstairs.walls) {
      wall.a = { x: wall.a.x + 9000, y: wall.a.y };
      wall.b = { x: wall.b.x + 9000, y: wall.b.y };
    }
    upstairs.rooms = [];

    expect(buildStack(doc, doc.floors, 'f').bounds!.maxX).toBeGreaterThan(13_000);
  });

  it('keeps ids unique across floors', () => {
    // Two floors traced from the same template can carry the same wall ids; React
    // keys and three.js meshes both need them distinct.
    const doc = twoStorey();
    doc.floors[1]!.walls = doc.floors[0]!.walls.map((w) => ({ ...w }));
    const stack = buildStack(doc, doc.floors, 'f');

    expect(new Set(stack.solids.map((s) => s.id)).size).toBe(stack.solids.length);
  });

  it('is only what you see — the walker is fed the active floor alone', () => {
    // Floors default to elevationMm 0, so a second floor added before its elevation
    // is set puts both storeys' walls in the same band. Feeding the stack to
    // collision would have you walking into walls you are only looking at.
    const doc = twoStorey();
    doc.floors[1]!.elevationMm = 0;

    const active = buildScene(doc, doc.floors[0]!);
    expect(blockersOf(active).length).toBeLessThan(
      blockersOf(buildStack(doc, doc.floors, 'f')).length,
    );
  });
});
