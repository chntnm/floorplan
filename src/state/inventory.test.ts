import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, useStore } from './store';
import {
  addCatalogItem,
  addPlacement,
  commitPlacementTransform,
  deleteSelection,
  previewPlacementTransform,
  placementSnapContext,
  removeCatalogItem,
  rotatePlacementBy,
  setBackground,
  setQuantityOwned,
  updateCatalogItem,
} from './actions';
import { clearAssets, putAsset } from './assets';
import { CatalogError, type ItemDraft } from '../core/catalog';
import { PlacementBlockedError, createBackground } from '../core/calibration';
import { placedCount, unplacedCount, type CatalogItem } from '../core/document';
import type { PlacementTransform } from './store';

const TABLE: ItemDraft = {
  name: 'Dining table',
  category: 'table',
  shape: 'rect',
  widthMm: 1800,
  depthMm: 900,
  heightMm: 760,
  voidBelowMm: 720,
  quantityOwned: 1,
};

const CHAIR: ItemDraft = {
  name: 'Dining chair',
  category: 'seating',
  shape: 'rect',
  widthMm: 460,
  depthMm: 510,
  heightMm: 900,
  voidBelowMm: 0,
  quantityOwned: 6,
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

function floor() {
  return activeFloor(useStore.getState());
}

function transformFor(placementId: string, mode: 'move' | 'rotate' = 'move'): PlacementTransform {
  const placement = floor().placements.find((p) => p.id === placementId)!;
  return {
    placementId,
    mode,
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
}

beforeEach(() => {
  useStore.getState().newDocument();
  clearAssets();
});

describe('the catalog', () => {
  it('adds an item as one undo step', () => {
    const item = addCatalogItem(TABLE);
    expect(useStore.getState().doc.catalog).toHaveLength(1);
    expect(useStore.getState().past).toHaveLength(1);
    expect(item.voidBelowMm).toBe(720);
  });

  it('refuses an item that would have no solid part', () => {
    expect(() => addCatalogItem({ ...TABLE, voidBelowMm: 800 })).toThrow(CatalogError);
    expect(useStore.getState().doc.catalog).toHaveLength(0);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('keeps the id when an item is edited, so placements survive', () => {
    // The whole point of the catalog/placement split: editing the thing you own must
    // not orphan the six of them you already put down.
    const item = addCatalogItem(CHAIR);
    addPlacement(item.id, { x: 0, y: 0 });
    updateCatalogItem(item.id, { ...CHAIR, name: 'Side chair', widthMm: 480 });

    const updated = useStore.getState().doc.catalog[0] as CatalogItem;
    expect(updated.id).toBe(item.id);
    expect(updated.name).toBe('Side chair');
    expect(floor().placements[0]!.itemId).toBe(item.id);
  });

  it('counts owned and placed separately', () => {
    // "I own 6, 4 are placed, 2 unplaced" has to stay expressible.
    const item = addCatalogItem(CHAIR);
    for (let i = 0; i < 4; i++) addPlacement(item.id, { x: i * 1000, y: 0 });

    const doc = useStore.getState().doc;
    expect(placedCount(doc, item.id)).toBe(4);
    expect(unplacedCount(doc, item.id)).toBe(2);
  });

  it('reports a negative unplaced count rather than clamping it', () => {
    // Owning fewer than you have placed is a real state, and hiding it would hide the
    // fact that the plan needs two more chairs bought.
    const item = addCatalogItem(CHAIR);
    for (let i = 0; i < 6; i++) addPlacement(item.id, { x: i * 1000, y: 0 });
    setQuantityOwned(item.id, 4);

    expect(unplacedCount(useStore.getState().doc, item.id)).toBe(-2);
  });

  it('removes an item together with every placement of it', () => {
    const item = addCatalogItem(CHAIR);
    addPlacement(item.id, { x: 0, y: 0 });
    addPlacement(item.id, { x: 2000, y: 0 });
    removeCatalogItem(item.id);

    expect(useStore.getState().doc.catalog).toHaveLength(0);
    expect(floor().placements).toHaveLength(0);
  });

  it('re-seats anything standing on a placement it removes', () => {
    const table = addCatalogItem(TABLE);
    const lamp = addCatalogItem(LAMP);
    const host = addPlacement(table.id, { x: 0, y: 0 })!;
    const child = addPlacement(lamp.id, { x: 0, y: 0 }, { mount: { kind: 'surface', hostId: host.id } })!;

    removeCatalogItem(table.id);

    const remaining = floor().placements.find((p) => p.id === child.id)!;
    expect(remaining.mount).toEqual({ kind: 'floor' });
  });
});

describe('placing', () => {
  it('refuses on an uncalibrated plan, with the reason the panel shows', () => {
    // The gate shipped in phase 3 as a predicate; this is what makes it real.
    const item = addCatalogItem(TABLE);
    const ref = putAsset({ mime: 'image/png', bytes: new Uint8Array([1]), id: 'bg' });
    setBackground(createBackground({ assetId: ref.id, pixelSize: { width: 800, height: 600 } }), [ref]);

    expect(() => addPlacement(item.id, { x: 0, y: 0 })).toThrow(PlacementBlockedError);
    expect(floor().placements).toHaveLength(0);
  });

  it('allows placing once the plan has a scale', () => {
    const item = addCatalogItem(TABLE);
    const ref = putAsset({ mime: 'image/png', bytes: new Uint8Array([1]), id: 'bg' });
    const bg = createBackground({ assetId: ref.id, pixelSize: { width: 800, height: 600 } });
    setBackground({ ...bg, calibration: { refA: { x: 0, y: 0 }, refB: { x: 400, y: 0 }, realLengthMm: 3000, mmPerPx: 7.5 } }, [ref]);

    expect(() => addPlacement(item.id, { x: 0, y: 0 })).not.toThrow();
    expect(floor().placements).toHaveLength(1);
  });

  it('rounds the position onto the integer-millimetre grid', () => {
    const item = addCatalogItem(TABLE);
    const placement = addPlacement(item.id, { x: 1000.4, y: -2000.6 })!;
    expect(placement.position).toEqual({ x: 1000, y: -2001 });
  });
});

describe('dragging a placement', () => {
  it('records nothing until the pointer is released', () => {
    const item = addCatalogItem(TABLE);
    const placement = addPlacement(item.id, { x: 0, y: 0 })!;
    const before = useStore.getState().past.length;

    let transform = transformFor(placement.id);
    const ctx = placementSnapContext(item.id, { toleranceMm: 100, excludePlacementId: placement.id });
    for (let i = 1; i <= 200; i++) {
      transform = previewPlacementTransform(transform, { x: i * 10, y: 0 }, ctx);
      useStore.getState().setPlacementTransform(transform);
    }

    expect(useStore.getState().past).toHaveLength(before);

    commitPlacementTransform(transform);
    expect(useStore.getState().past).toHaveLength(before + 1);
  });

  it('is absolute, not accumulated frame by frame', () => {
    const item = addCatalogItem(TABLE);
    const placement = addPlacement(item.id, { x: 0, y: 0 })!;
    let transform = transformFor(placement.id);

    // Wander, then come back to exactly where the drag began.
    for (const at of [{ x: 900, y: 900 }, { x: -400, y: 250 }, { x: 0, y: 0 }]) {
      transform = previewPlacementTransform(transform, at, null);
    }
    expect(transform.position).toEqual({ x: 0, y: 0 });
  });

  it('records nothing for a press that never moved', () => {
    const item = addCatalogItem(TABLE);
    const placement = addPlacement(item.id, { x: 0, y: 0 })!;
    const before = useStore.getState().past.length;

    commitPlacementTransform(transformFor(placement.id));
    expect(useStore.getState().past).toHaveLength(before);
  });

  it('mounts onto a host it is dragged over, and back off again', () => {
    const table = addCatalogItem(TABLE);
    const lamp = addCatalogItem(LAMP);
    addPlacement(table.id, { x: 0, y: 0 });
    const child = addPlacement(lamp.id, { x: 5000, y: 5000 })!;

    const ctx = placementSnapContext(lamp.id, { toleranceMm: 50, excludePlacementId: child.id });
    let transform = transformFor(child.id);

    transform = previewPlacementTransform(transform, { x: 5000, y: 5000 }, ctx);
    expect(transform.mount.kind).toBe('floor');

    // Drag it onto the table at the origin.
    transform = previewPlacementTransform(transform, { x: 0, y: 0 }, ctx);
    expect(transform.mount.kind).toBe('surface');

    // And off again.
    transform = previewPlacementTransform(transform, { x: 5000, y: 5000 }, ctx);
    expect(transform.mount.kind).toBe('floor');
  });

  it('never lets a placement mount onto itself', () => {
    // An item is always inside its own outline, so leaving it in the host list would
    // surface-mount it to itself the moment it moved.
    const table = addCatalogItem(TABLE);
    const placement = addPlacement(table.id, { x: 0, y: 0 })!;

    const ctx = placementSnapContext(table.id, { toleranceMm: 50, excludePlacementId: placement.id });
    const transform = previewPlacementTransform(transformFor(placement.id), { x: 0, y: 0 }, ctx);

    expect(transform.mount).toEqual({ kind: 'floor' });
  });
});

describe('rotating', () => {
  it('keeps the angle in [0, 360)', () => {
    const item = addCatalogItem(TABLE);
    const placement = addPlacement(item.id, { x: 0, y: 0 })!;

    rotatePlacementBy(placement.id, -15);
    expect(floor().placements[0]!.rotation).toBe(345);

    rotatePlacementBy(placement.id, 30);
    expect(floor().placements[0]!.rotation).toBe(15);
  });
});

describe('deleting a placement', () => {
  it('re-seats its children on the floor rather than leaving a dangling host', () => {
    const table = addCatalogItem(TABLE);
    const lamp = addCatalogItem(LAMP);
    const host = addPlacement(table.id, { x: 0, y: 0 })!;
    const child = addPlacement(lamp.id, { x: 0, y: 0 }, { mount: { kind: 'surface', hostId: host.id } })!;

    deleteSelection([{ kind: 'placement', id: host.id }]);

    const remaining = floor().placements.find((p) => p.id === child.id)!;
    expect(remaining.mount).toEqual({ kind: 'floor' });
    expect(remaining.elevation).toBe(0);
  });

  it('undoes back to the child still standing on its host', () => {
    const table = addCatalogItem(TABLE);
    const lamp = addCatalogItem(LAMP);
    const host = addPlacement(table.id, { x: 0, y: 0 })!;
    const child = addPlacement(lamp.id, { x: 0, y: 0 }, { mount: { kind: 'surface', hostId: host.id } })!;

    deleteSelection([{ kind: 'placement', id: host.id }]);
    useStore.getState().undo();

    const restored = floor().placements.find((p) => p.id === child.id)!;
    expect(restored.mount).toEqual({ kind: 'surface', hostId: host.id });
  });
});
