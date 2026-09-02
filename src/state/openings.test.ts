import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, useStore } from './store';
import {
  addCatalogItem,
  addOpening,
  addWallChain,
  deleteSelection,
  setOpeningSwing,
  updateOpening,
} from './actions';
import { OpeningError } from '../core/openings';
import { DEFAULT_SWING, leafOf } from '../core/swing';
import type { ItemDraft } from '../core/catalog';

const SHELF: ItemDraft = {
  name: 'Shelf',
  category: 'storage',
  shape: 'rect',
  widthMm: 900,
  depthMm: 250,
  heightMm: 300,
  voidBelowMm: 0,
};

function floor() {
  return activeFloor(useStore.getState());
}

/** One 5m wall running east from the origin. */
function wall() {
  const [w] = addWallChain([
    { x: 0, y: 0 },
    { x: 5000, y: 0 },
  ]);
  return w!;
}

beforeEach(() => {
  useStore.getState().newDocument();
});

describe('adding an opening', () => {
  it('centres it on the clicked point along the wall', () => {
    wall();
    const opening = addOpening({ x: 2500, y: 20 }, 'door', 100)!;

    expect(opening.offsetMm).toBe(2094);
    expect(opening.widthMm).toBe(813);
    expect(floor().openings).toHaveLength(1);
  });

  it('is one undo step', () => {
    wall();
    const before = useStore.getState().past.length;
    addOpening({ x: 2500, y: 0 }, 'door', 100);

    expect(useStore.getState().past).toHaveLength(before + 1);
    useStore.getState().undo();
    expect(floor().openings).toHaveLength(0);
  });

  it('does nothing when the click is not on a wall', () => {
    wall();
    expect(addOpening({ x: 2500, y: 4000 }, 'door', 100)).toBeNull();
    expect(floor().openings).toHaveLength(0);
    expect(useStore.getState().past).toHaveLength(1); // the wall, and nothing else
  });

  it('picks the wall you are pointing at where two meet', () => {
    // Butt joins overlap on the inside of every corner, so "the first one that
    // matches" would put the door in whichever wall happened to be drawn first.
    addWallChain([
      { x: 0, y: 0 },
      { x: 5000, y: 0 },
      { x: 5000, y: 5000 },
    ]);
    const walls = floor().walls;
    const opening = addOpening({ x: 5000, y: 2000 }, 'door', 100)!;

    expect(opening.wallId).toBe(walls[1]!.id);
  });

  it('refuses a wall too short to hold the opening, without touching the document', () => {
    addWallChain([
      { x: 0, y: 0 },
      { x: 900, y: 0 },
    ]);
    const before = useStore.getState().past.length;

    expect(() => addOpening({ x: 450, y: 0 }, 'sliding', 100)).toThrow(OpeningError);
    expect(floor().openings).toHaveLength(0);
    expect(useStore.getState().past).toHaveLength(before);
  });
});

describe('editing an opening', () => {
  it('does not clamp a hand-typed offset back onto the wall', () => {
    // Silently sliding somebody's front door to make it fit hides the mistake.
    // Validation reports it and the geometry declines to build it.
    const w = wall();
    const opening = addOpening({ x: 1000, y: 0 }, 'door', 100)!;
    updateOpening(opening.id, { offsetMm: 4800 });

    expect(floor().openings[0]!.offsetMm).toBe(4800);
    expect(floor().openings[0]!.offsetMm + floor().openings[0]!.widthMm).toBeGreaterThan(
      w.b.x - w.a.x,
    );
  });

  it('keeps a width of at least a millimetre', () => {
    wall();
    const opening = addOpening({ x: 1000, y: 0 }, 'door', 100)!;
    updateOpening(opening.id, { widthMm: 0 });
    expect(floor().openings[0]!.widthMm).toBe(1);
  });
});

describe('deleting', () => {
  it('takes a wall’s openings with it', () => {
    const w = wall();
    addOpening({ x: 1000, y: 0 }, 'door', 100);
    addOpening({ x: 3000, y: 0 }, 'window', 100);

    deleteSelection([{ kind: 'wall', id: w.id }]);
    expect(floor().openings).toHaveLength(0);
  });

  it('deletes an opening on its own, leaving the wall', () => {
    const w = wall();
    const opening = addOpening({ x: 1000, y: 0 }, 'door', 100)!;

    deleteSelection([{ kind: 'opening', id: opening.id }]);
    expect(floor().openings).toHaveLength(0);
    expect(floor().walls.map((x) => x.id)).toEqual([w.id]);
  });

  it('re-seats a wall-mounted item when its wall is deleted', () => {
    // A wall mount keeps its stored elevation whether or not the wall exists, so
    // without this the shelf hangs in mid-air and nothing downstream notices.
    const w = wall();
    const item = addCatalogItem(SHELF);
    useStore.getState().mutate('seed', (draft) => {
      draft.floors[0]!.placements.push({
        id: 'p1',
        itemId: item.id,
        floorId: draft.floors[0]!.id,
        position: { x: 1000, y: 0 },
        rotation: 0,
        mount: { kind: 'wall', wallId: w.id },
        elevation: 1400,
      });
    });

    deleteSelection([{ kind: 'wall', id: w.id }]);

    const placement = floor().placements[0]!;
    expect(placement.mount).toEqual({ kind: 'floor' });
    expect(placement.elevation).toBe(0);
  });

  it('undoes back to the shelf still on its wall', () => {
    const w = wall();
    const item = addCatalogItem(SHELF);
    useStore.getState().mutate('seed', (draft) => {
      draft.floors[0]!.placements.push({
        id: 'p1',
        itemId: item.id,
        floorId: draft.floors[0]!.id,
        position: { x: 1000, y: 0 },
        rotation: 0,
        mount: { kind: 'wall', wallId: w.id },
        elevation: 1400,
      });
    });

    deleteSelection([{ kind: 'wall', id: w.id }]);
    useStore.getState().undo();

    expect(floor().placements[0]!.mount).toEqual({ kind: 'wall', wallId: w.id });
    expect(floor().placements[0]!.elevation).toBe(1400);
  });

  it('drops an opening out of the selection once it is gone', () => {
    wall();
    const opening = addOpening({ x: 1000, y: 0 }, 'door', 100)!;
    useStore.getState().setSelection([{ kind: 'opening', id: opening.id }]);

    deleteSelection([{ kind: 'opening', id: opening.id }]);
    expect(useStore.getState().selection).toEqual([]);
  });
});

describe('hanging a door', () => {
  function door() {
    wall();
    return addOpening({ x: 2500, y: 20 }, 'door', 100)!;
  }

  it('reads as a standard swing before anyone has touched it', () => {
    // Nothing is seeded on creation, so a file written before this existed opens
    // with its doors hung the ordinary way rather than hinged nowhere.
    const opening = door();
    expect(opening.swing).toBeUndefined();
    expect(leafOf(opening)).toEqual({
      style: 'hinged',
      pivot: DEFAULT_SWING.hinge,
      face: DEFAULT_SWING.into,
      angleDeg: DEFAULT_SWING.angleDeg,
    });
  });

  it('writes a whole swing on the first edit, not a fragment', () => {
    const opening = door();
    setOpeningSwing(opening.id, { into: 'back' });

    expect(floor().openings[0]!.swing).toEqual({ hinge: 'a', into: 'back', angleDeg: 90 });
  });

  it('clamps an angle nobody could hang a door at', () => {
    const opening = door();
    setOpeningSwing(opening.id, { angleDeg: 500 });
    expect(floor().openings[0]!.swing!.angleDeg).toBe(180);
  });

  it('is one undo step per change', () => {
    const opening = door();
    const before = useStore.getState().past.length;

    setOpeningSwing(opening.id, { hinge: 'b' });
    expect(useStore.getState().past).toHaveLength(before + 1);
    useStore.getState().undo();
    expect(floor().openings[0]!.swing).toBeUndefined();
  });

  it('keeps the hinge you chose through a kind change and back', () => {
    // A door turned into a cased opening and back is the door you had. `leafOf`
    // decides whether the field is read; the document just keeps it.
    const opening = door();
    setOpeningSwing(opening.id, { hinge: 'b', into: 'back' });

    updateOpening(opening.id, { kind: 'cased' });
    expect(leafOf(floor().openings[0]!)).toEqual({ style: 'none' });

    updateOpening(opening.id, { kind: 'door' });
    expect(leafOf(floor().openings[0]!)).toEqual({
      style: 'hinged',
      pivot: 'b',
      face: 'back',
      angleDeg: 90,
    });
  });

  it('does nothing to an opening that is gone', () => {
    const opening = door();
    const before = useStore.getState().past.length;
    setOpeningSwing(`${opening.id}-nope`, { hinge: 'b' });
    expect(useStore.getState().past).toHaveLength(before);
  });
});
