import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, useStore } from './store';
import {
  addCatalogItem,
  addFloor,
  addPlacement,
  addRoomRect,
  deleteFloor,
  movePlacementToFloor,
  setFloorElevation,
  renameFloor,
} from './actions';
import type { ItemDraft } from '../core/catalog';
import { orderedFloors } from '../core/floors';

const DRESSER: ItemDraft = {
  name: 'Dresser',
  category: 'storage',
  shape: 'rect',
  widthMm: 1500,
  depthMm: 500,
  heightMm: 810,
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

const SHELF: ItemDraft = {
  name: 'Wall shelf',
  category: 'storage',
  shape: 'rect',
  widthMm: 900,
  depthMm: 250,
  heightMm: 300,
  voidBelowMm: 0,
  defaultMount: 'wall',
};

beforeEach(() => {
  useStore.getState().newDocument();
  // Every placement needs somewhere to stand; a room also calibrates the plan.
  addRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 });
});

const groundId = () => useStore.getState().doc.floors[0]!.id;

describe('adding and removing floors', () => {
  it('adds a floor above and makes it the one being edited', () => {
    const upstairs = addFloor('above');

    expect(useStore.getState().doc.floors).toHaveLength(2);
    expect(useStore.getState().doc.activeFloorId).toBe(upstairs);
    expect(activeFloor(useStore.getState()).walls).toEqual([]);
  });

  it('refuses to remove the only floor, and says why', () => {
    // Nothing downstream survives a document with no floors: every caller of
    // `activeFloor` would be falling through to a fallback that is not there.
    expect(deleteFloor(groundId())).toBe('A space needs at least one floor.');
    expect(useStore.getState().doc.floors).toHaveLength(1);
  });

  it('moves you somewhere real when the floor you were on is removed', () => {
    const ground = groundId();
    const upstairs = addFloor('above');
    expect(deleteFloor(upstairs)).toBeNull();

    expect(useStore.getState().doc.activeFloorId).toBe(ground);
  });

  it('keeps a basement below the ground floor however the array is ordered', () => {
    const ground = groundId();
    const basement = addFloor('below');

    expect(orderedFloors(useStore.getState().doc).map((f) => f.id)).toEqual([basement, ground]);
    // Appended, so array order says the opposite. `index` is the one that means it.
    expect(useStore.getState().doc.floors.map((f) => f.id)).toEqual([ground, basement]);
  });

  it('re-seats a cross-floor surface mount when its host floor is deleted', () => {
    // Nothing in the editor can create one, but the model expresses it and a file can
    // contain it — and `findPlacement` searches every floor, so a dangling hostId
    // resolves into an elevation measured against the wrong datum.
    const dresser = addCatalogItem(DRESSER);
    const host = addPlacement(dresser.id, { x: 2000, y: 2000 })!;

    const upstairs = addFloor('above');
    addRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 });
    const lamp = addCatalogItem(LAMP);
    const rider = addPlacement(lamp.id, { x: 2000, y: 2000 })!;
    useStore.getState().mutate('cross-floor mount', (draft) => {
      const p = draft.floors
        .find((f) => f.id === upstairs)!
        .placements.find((x) => x.id === rider.id)!;
      p.mount = { kind: 'surface', hostId: host.id };
      p.elevation = 810;
    });

    deleteFloor(groundId());

    const moved = useStore
      .getState()
      .doc.floors.find((f) => f.id === upstairs)!
      .placements.find((p) => p.id === rider.id)!;
    expect(moved.mount).toEqual({ kind: 'floor' });
    expect(moved.elevation).toBe(0);
  });
});

describe('switching floors', () => {
  it('is not an undo step', () => {
    // Undo walks back the edits you made. Having it teleport you between storeys
    // instead would make the stack unusable.
    const upstairs = addFloor('above');
    const depth = useStore.getState().past.length;

    useStore.getState().setActiveFloor(groundId());
    expect(useStore.getState().past.length).toBe(depth);

    useStore.getState().setActiveFloor(upstairs);
    expect(useStore.getState().doc.activeFloorId).toBe(upstairs);
  });

  it('still marks the document dirty, because it has to be saved', () => {
    // Reopening a three-storey house on the floor you left it is why the field is in
    // the document rather than in the editor.
    addFloor('above');
    useStore.getState().markSaved();

    useStore.getState().setActiveFloor(groundId());
    expect(useStore.getState().dirty).toBe(true);
  });

  it('drops a selection that names something on the floor you left', () => {
    // `pruneSelection` alone would keep it: a wall on the floor below still exists.
    const wallId = activeFloor(useStore.getState()).walls[0]!.id;
    useStore.getState().setSelection([{ kind: 'wall', id: wallId }]);

    addFloor('above');
    expect(useStore.getState().selection).toEqual([]);
  });

  it('does nothing for a floor that is not in the document', () => {
    const before = useStore.getState().doc;
    useStore.getState().setActiveFloor('nowhere');
    expect(useStore.getState().doc).toBe(before);
  });
});

describe('moving a placement to another floor', () => {
  it('takes everything standing on it along', () => {
    const dresser = addCatalogItem(DRESSER);
    const host = addPlacement(dresser.id, { x: 2000, y: 2000 })!;
    const lamp = addCatalogItem(LAMP);
    // Mounted explicitly: a lamp's default mount is the floor, so dropping one on a
    // dresser in a unit test does not stand it on the dresser.
    const rider = addPlacement(lamp.id, { x: 2000, y: 2000 }, {
      mount: { kind: 'surface', hostId: host.id },
    })!;

    const ground = groundId();
    const upstairs = addFloor('above');
    const notice = movePlacementToFloor(host.id, upstairs);

    const up = useStore.getState().doc.floors.find((f) => f.id === upstairs)!;
    const down = useStore.getState().doc.floors.find((f) => f.id === ground)!;
    expect(up.placements.map((p) => p.id).sort()).toEqual([host.id, rider.id].sort());
    expect(down.placements).toEqual([]);
    expect(up.placements.every((p) => p.floorId === upstairs)).toBe(true);
    expect(notice).toContain('1 item on it moved too');
  });

  it('re-seats a wall mount, and says so', () => {
    const shelf = addCatalogItem(SHELF);
    const placed = addPlacement(shelf.id, { x: 2500, y: 60 })!;
    expect(placed.mount.kind).toBe('wall');

    const upstairs = addFloor('above');
    const notice = movePlacementToFloor(placed.id, upstairs);

    const moved = useStore
      .getState()
      .doc.floors.find((f) => f.id === upstairs)!
      .placements[0]!;
    expect(moved.mount).toEqual({ kind: 'floor' });
    expect(notice).toContain('reseated');
  });

  it('leaves a lamp behind when only the lamp moves', () => {
    // The exemption is "the host is travelling too", not "it is surface-mounted".
    const dresser = addCatalogItem(DRESSER);
    const host = addPlacement(dresser.id, { x: 2000, y: 2000 })!;
    const lamp = addCatalogItem(LAMP);
    const rider = addPlacement(lamp.id, { x: 2000, y: 2000 }, {
      mount: { kind: 'surface', hostId: host.id },
    })!;
    expect(rider.mount.kind).toBe('surface');

    const upstairs = addFloor('above');
    movePlacementToFloor(rider.id, upstairs);

    const moved = useStore
      .getState()
      .doc.floors.find((f) => f.id === upstairs)!
      .placements[0]!;
    expect(moved.mount).toEqual({ kind: 'floor' });
  });

  it('is one undo step for the whole group', () => {
    const dresser = addCatalogItem(DRESSER);
    const host = addPlacement(dresser.id, { x: 2000, y: 2000 })!;
    const lamp = addCatalogItem(LAMP);
    addPlacement(lamp.id, { x: 2000, y: 2000 }, { mount: { kind: 'surface', hostId: host.id } });

    const ground = groundId();
    const upstairs = addFloor('above');
    movePlacementToFloor(host.id, upstairs);
    useStore.getState().undo();

    expect(
      useStore.getState().doc.floors.find((f) => f.id === ground)!.placements,
    ).toHaveLength(2);
  });
});

describe('floor properties', () => {
  it('takes a negative elevation for a basement', () => {
    const id = groundId();
    setFloorElevation(id, -2738);
    expect(useStore.getState().doc.floors[0]!.elevationMm).toBe(-2738);
  });

  it('renames a floor', () => {
    renameFloor(groundId(), 'Ground');
    expect(useStore.getState().doc.floors[0]!.name).toBe('Ground');
  });
});

describe('the defects a review pass found', () => {
  it('clears a walkway route drawn on a floor that is then deleted', () => {
    // `deleteFloor` moves `activeFloorId` inside its own recipe, which makes
    // `setActiveFloor` a no-op afterwards — so folding the reset into the switch left
    // the route alive, re-answering against the remaining floor's geometry.
    const upstairs = addFloor('above');
    useStore.getState().setWalkway([
      { x: 0, y: 2000 },
      { x: 5000, y: 2000 },
    ]);

    deleteFloor(upstairs);
    expect(useStore.getState().walkway).toBeNull();
  });

  it('leaves the active floor resolvable after undoing the floor that was added', () => {
    // `addFloor` used to switch *after* its own mutation, so the inverse patch removed
    // the floor while `activeFloorId` still named it. `activeFloor` falls back, which
    // hides it — but the picker matches no option and a save writes an id that is not
    // in the document.
    const ground = groundId();
    addFloor('above');
    useStore.getState().undo();

    const { doc } = useStore.getState();
    expect(doc.floors.some((f) => f.id === doc.activeFloorId)).toBe(true);
    expect(doc.activeFloorId).toBe(ground);
  });

  it('refuses to move furniture onto a floor whose plan has no scale', () => {
    // The same gate `addPlacement` applies, arrived at by a different door: a floor
    // with an uncalibrated background has no trustworthy scale, and anything on it is
    // placed at a size that means nothing.
    const dresser = addCatalogItem(DRESSER);
    const placed = addPlacement(dresser.id, { x: 2000, y: 2000 })!;
    const ground = groundId();

    const upstairs = addFloor('above');
    useStore.getState().mutate('uncalibrated plan', (draft) => {
      draft.floors.find((f) => f.id === upstairs)!.background = {
        assetId: 'a',
        pixelSize: { width: 1000, height: 800 },
        transform: { position: { x: 0, y: 0 }, rotationDeg: 0 },
        opacity: 1,
        locked: false,
      };
    });

    expect(movePlacementToFloor(placed.id, upstairs)).toContain('not been calibrated');
    expect(
      useStore.getState().doc.floors.find((f) => f.id === ground)!.placements,
    ).toHaveLength(1);
  });

  it('carries a rider that was already sitting on another floor', () => {
    // A cross-floor surface mount is representable and can be in a file. Walking only
    // the source floor leaves behind the very rider the walk exists to carry.
    const dresser = addCatalogItem(DRESSER);
    const host = addPlacement(dresser.id, { x: 2000, y: 2000 })!;

    const upstairs = addFloor('above');
    addRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 });
    const lamp = addCatalogItem(LAMP);
    const rider = addPlacement(lamp.id, { x: 2000, y: 2000 })!;
    useStore.getState().mutate('cross-floor mount', (draft) => {
      const p = draft.floors
        .find((f) => f.id === upstairs)!
        .placements.find((x) => x.id === rider.id)!;
      p.mount = { kind: 'surface', hostId: host.id };
    });

    const attic = addFloor('above');
    movePlacementToFloor(host.id, attic);

    const top = useStore.getState().doc.floors.find((f) => f.id === attic)!;
    expect(top.placements.map((p) => p.id).sort()).toEqual([host.id, rider.id].sort());
    // And it is still on the dresser, because the dresser came with it.
    expect(top.placements.find((p) => p.id === rider.id)!.mount).toEqual({
      kind: 'surface',
      hostId: host.id,
    });
  });
});
