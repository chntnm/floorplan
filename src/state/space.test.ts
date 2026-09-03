import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, useStore } from './store';
import {
  DEFAULT_WALL_MOUNT_MM,
  addCatalogItem,
  addPlacement,
  addRoomRect,
  addSavedView,
  commitPlacementTransform,
  placementSnapContext,
  previewPlacementTransform,
  removeSavedView,
  setCeilingDrop,
  setPlacementMount,
} from './actions';
import type { ItemDraft } from '../core/catalog';
import { resolveElevation } from '../core/placement';
import { spaceViews, type SpaceCamera } from '../core/views';
import type { PlacementTransform } from './store';
import type { Placement } from '../core/document';
import type { Vec2 } from '../core/geometry/vec';

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

const PENDANT: ItemDraft = {
  name: 'Pendant',
  category: 'lighting',
  shape: 'circle',
  widthMm: 400,
  depthMm: 400,
  heightMm: 500,
  voidBelowMm: 0,
  defaultMount: 'ceiling',
};

const CHAIR: ItemDraft = {
  name: 'Chair',
  category: 'seating',
  shape: 'rect',
  widthMm: 460,
  depthMm: 510,
  heightMm: 900,
  voidBelowMm: 0,
};

const CAMERA: SpaceCamera = {
  position: { x: 1200, y: 300, z: 1650 },
  target: { x: 2500, y: 2500, z: 1200 },
  mode: 'walk',
};

function floor() {
  return activeFloor(useStore.getState());
}

/** A 5m × 4m room, whose north wall runs along y = 0. */
function room() {
  addRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 });
}

beforeEach(() => {
  useStore.getState().newDocument();
});

describe('dropping a wall-mounted item', () => {
  it('hangs it on the wall it was dropped against', () => {
    room();
    const item = addCatalogItem(SHELF);
    const placement = addPlacement(item.id, { x: 2500, y: 100 })!;

    expect(placement.mount).toEqual({ kind: 'wall', wallId: floor().walls[0]!.id });
    expect(placement.elevation).toBe(DEFAULT_WALL_MOUNT_MM);
    expect(useStore.getState().notice).toBeNull();
  });

  it('lands it on the floor and says why when there is no wall in reach', () => {
    // Never a wallId it guessed: an item attached to a wall the user did not choose
    // moves when that wall does, which is worse than one sitting on the floor.
    room();
    const item = addCatalogItem(SHELF);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    expect(placement.mount).toEqual({ kind: 'floor' });
    expect(useStore.getState().notice).toContain('no wall here');
  });

  it('clears the notice on the next placement that goes to plan', () => {
    room();
    const shelf = addCatalogItem(SHELF);
    addPlacement(shelf.id, { x: 2500, y: 2000 });
    expect(useStore.getState().notice).not.toBeNull();

    const chair = addCatalogItem(CHAIR);
    addPlacement(chair.id, { x: 2500, y: 2000 });
    expect(useStore.getState().notice).toBeNull();
  });

  it('hangs a ceiling item from the ceiling wherever it is dropped', () => {
    room();
    const item = addCatalogItem(PENDANT);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    expect(placement.mount).toEqual({ kind: 'ceiling', drop: 0 });
    // Flush to a 2438 ceiling, so a 500 tall pendant hangs with its base at 1938.
    expect(resolveElevation(useStore.getState().doc, placement)).toBe(1938);
  });
});

describe('changing a mount', () => {
  it('moves an item onto the nearest wall', () => {
    room();
    const item = addCatalogItem(CHAIR);
    const placement = addPlacement(item.id, { x: 2500, y: 200 })!;

    expect(setPlacementMount(placement.id, 'wall')).toBeNull();
    expect(floor().placements[0]!.mount.kind).toBe('wall');
  });

  it('refuses, with a reason, when nothing is near enough', () => {
    room();
    const item = addCatalogItem(CHAIR);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    expect(setPlacementMount(placement.id, 'wall')).toContain('no wall near enough');
    expect(floor().placements[0]!.mount).toEqual({ kind: 'floor' });
  });

  it('sends you to the drag gesture for a surface mount', () => {
    // A surface mount names a specific host, and there is nothing sensible to pick
    // from a list of words.
    room();
    const item = addCatalogItem(CHAIR);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    expect(setPlacementMount(placement.id, 'surface')).toContain('Drag this onto');
  });

  it('is one undo step', () => {
    room();
    const item = addCatalogItem(CHAIR);
    const placement = addPlacement(item.id, { x: 2500, y: 200 })!;
    const before = useStore.getState().past.length;

    setPlacementMount(placement.id, 'wall');
    expect(useStore.getState().past).toHaveLength(before + 1);
    useStore.getState().undo();
    expect(floor().placements[0]!.mount).toEqual({ kind: 'floor' });
  });
});

describe('the ceiling drop', () => {
  it('lowers the item by the amount it is dropped', () => {
    room();
    const item = addCatalogItem(PENDANT);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    setCeilingDrop(placement.id, 600);
    const updated = floor().placements[0]!;
    expect(updated.mount).toEqual({ kind: 'ceiling', drop: 600 });
    expect(resolveElevation(useStore.getState().doc, updated)).toBe(1338);
  });

  it('is ignored on something that is not hanging', () => {
    room();
    const item = addCatalogItem(CHAIR);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    setCeilingDrop(placement.id, 600);
    expect(floor().placements[0]!.mount).toEqual({ kind: 'floor' });
  });
});

describe('saved views', () => {
  it('records a bookmark in the document, so it travels with the file', () => {
    addSavedView('Doorway', CAMERA);
    const views = spaceViews(useStore.getState().doc.savedViews);

    expect(views).toHaveLength(1);
    expect(views[0]!.name).toBe('Doorway');
    expect(views[0]!.camera.x).toBe(1200);
  });

  it('suffixes a duplicate name rather than refusing', () => {
    addSavedView('Doorway', CAMERA);
    addSavedView('Doorway', CAMERA);

    expect(useStore.getState().doc.savedViews.map((v) => v.name)).toEqual([
      'Doorway',
      'Doorway 2',
    ]);
  });

  it('names an unnamed bookmark rather than saving an empty label', () => {
    addSavedView('   ', CAMERA);
    expect(useStore.getState().doc.savedViews[0]!.name).toBe('View');
  });

  it('removes one', () => {
    addSavedView('Doorway', CAMERA);
    const id = useStore.getState().doc.savedViews[0]!.id;
    removeSavedView(id);

    expect(useStore.getState().doc.savedViews).toHaveLength(0);
  });

  it('using a view moves the walker but records no history', () => {
    // A bookmark records where you looked from; using one is not an edit to the space.
    addSavedView('Doorway', CAMERA);
    const view = useStore.getState().doc.savedViews[0]!;
    const before = useStore.getState().past.length;

    useStore.getState().applySavedView(view);

    expect(useStore.getState().past).toHaveLength(before);
    expect(useStore.getState().cameraMode).toBe('walk');
    expect(useStore.getState().walker?.position).toEqual({ x: 1200, y: 300 });
  });

  it('faces the walker back at what the view was looking at', () => {
    // The camera looked from (1200,300) toward (2500,2500) — south-east, so a
    // bearing between 90 and 180.
    addSavedView('Doorway', CAMERA);
    useStore.getState().applySavedView(useStore.getState().doc.savedViews[0]!);

    const heading = useStore.getState().walker!.heading;
    expect(heading).toBeGreaterThan(90);
    expect(heading).toBeLessThan(180);
  });

  it('leaves the walker alone for an orbit bookmark', () => {
    addSavedView('Above', { ...CAMERA, mode: 'orbit' });
    useStore.getState().applySavedView(useStore.getState().doc.savedViews[0]!);

    expect(useStore.getState().walker).toBeNull();
    expect(useStore.getState().pendingCamera?.mode).toBe('orbit');
  });
});

describe('dragging something that is mounted', () => {
  /** Drag a placement to a new point, the way the stage does: preview, then commit. */
  function dragTo(placement: Placement, to: Vec2) {
    const ctx = placementSnapContext(placement.itemId, {
      toleranceMm: 100,
      excludePlacementId: placement.id,
    });
    const start: PlacementTransform = {
      placementId: placement.id,
      mode: 'move',
      grab: placement.position,
      origin: {
        position: placement.position,
        rotation: placement.rotation,
        mount: placement.mount,
      },
      position: placement.position,
      rotation: placement.rotation,
      mount: placement.mount,
      hints: [],
    };
    commitPlacementTransform(previewPlacementTransform(start, to, ctx));
  }

  it('keeps a wall-mounted item on its wall, and at its height', () => {
    // The snap reports a *floor* mount for anything that is not a surface-host match
    // — a wall snap seats the footprint against the wall but never claims a wall
    // mount. Letting that through drops the TV to the ground on a 5mm nudge.
    room();
    const item = addCatalogItem(SHELF);
    const placement = addPlacement(item.id, { x: 2500, y: 100 })!;
    expect(placement.mount.kind).toBe('wall');

    dragTo(placement, { x: 2700, y: 100 });

    const moved = floor().placements[0]!;
    expect(moved.mount).toEqual(placement.mount);
    expect(moved.elevation).toBe(DEFAULT_WALL_MOUNT_MM);
    expect(moved.position.x).not.toBe(placement.position.x);
  });

  it('keeps a hanging item hanging', () => {
    room();
    const item = addCatalogItem(PENDANT);
    const placement = addPlacement(item.id, { x: 2500, y: 2000 })!;

    dragTo(placement, { x: 1500, y: 2000 });
    expect(floor().placements[0]!.mount).toEqual({ kind: 'ceiling', drop: 0 });
  });

  it('still drops a surface-mounted item to the floor when dragged off its host', () => {
    // The other half of the rule: a surface mount that finds no host really has been
    // taken off the thing it was standing on.
    room();
    const table = addCatalogItem({
      name: 'Table',
      category: 'table',
      shape: 'rect',
      widthMm: 1800,
      depthMm: 900,
      heightMm: 760,
      voidBelowMm: 720,
    });
    const lamp = addCatalogItem({
      name: 'Lamp',
      category: 'lighting',
      shape: 'circle',
      widthMm: 300,
      depthMm: 300,
      heightMm: 500,
      voidBelowMm: 0,
    });
    const host = addPlacement(table.id, { x: 2500, y: 2000 })!;
    const child = addPlacement(lamp.id, { x: 2500, y: 2000 }, {
      mount: { kind: 'surface', hostId: host.id },
    })!;

    dragTo(child, { x: 800, y: 3500 });
    expect(floor().placements.find((p) => p.id === child.id)!.mount).toEqual({ kind: 'floor' });
  });
});
