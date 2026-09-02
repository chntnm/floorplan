import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, floorBounds, useStore, HISTORY_LIMIT } from './store';
import { addRoomRect, addShapeRoom, addWallChain, deleteSelection, setRoomName } from './actions';
import { DEFAULT_SCALE, DEFAULT_VIEWPORT, screenToDoc } from '../core/viewport';
import { readSpaceJson, writeSpaceJson } from '../core/space-file';

const CHAIN = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
  { x: 4000, y: 3000 },
  { x: 0, y: 3000 },
];

function floor() {
  return activeFloor(useStore.getState());
}

beforeEach(() => {
  useStore.getState().newDocument();
});

describe('the two slices', () => {
  it('records nothing for editor state', () => {
    // A drag lives entirely here: hundreds of mousemoves, zero history.
    const store = useStore.getState();
    for (let i = 0; i < 300; i++) {
      store.setCursor({ x: i, y: i });
      store.setDraft({ tool: 'wall', points: [{ x: 0, y: 0 }], cursor: { x: i, y: i } });
      store.setViewport({ scale: DEFAULT_SCALE, x: i, y: 0 });
    }
    store.setTool('wall');
    store.setEditMode('furnish');
    store.setSelection([]);

    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().dirty).toBe(false);
  });

  it('records exactly one entry per completed gesture', () => {
    addWallChain(CHAIN);
    expect(useStore.getState().past).toHaveLength(1);
    expect(floor().walls).toHaveLength(3);
  });
});

describe('undo and redo', () => {
  it('undoes three drawn segments in three presses, not three hundred', () => {
    // The acceptance check for the slice split: draw three chains, undo three times.
    addWallChain([CHAIN[0]!, CHAIN[1]!]);
    addWallChain([CHAIN[1]!, CHAIN[2]!]);
    addWallChain([CHAIN[2]!, CHAIN[3]!]);
    expect(floor().walls).toHaveLength(3);

    useStore.getState().undo();
    expect(floor().walls).toHaveLength(2);
    useStore.getState().undo();
    expect(floor().walls).toHaveLength(1);
    useStore.getState().undo();
    expect(floor().walls).toHaveLength(0);
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('redoes what it undid', () => {
    addRoomRect({ x: 0, y: 0 }, { x: 4000, y: 3000 });
    const before = JSON.stringify(useStore.getState().doc.floors);

    useStore.getState().undo();
    expect(floor().rooms).toHaveLength(0);
    expect(floor().walls).toHaveLength(0);

    useStore.getState().redo();
    expect(JSON.stringify(useStore.getState().doc.floors)).toBe(before);
  });

  it('is a no-op at either end of the stack', () => {
    expect(() => useStore.getState().undo()).not.toThrow();
    expect(() => useStore.getState().redo()).not.toThrow();
    expect(floor().walls).toHaveLength(0);
  });

  it('discards the redo branch once you draw again', () => {
    addWallChain([CHAIN[0]!, CHAIN[1]!]);
    useStore.getState().undo();
    expect(useStore.getState().future).toHaveLength(1);

    addWallChain([CHAIN[1]!, CHAIN[2]!]);
    expect(useStore.getState().future).toHaveLength(0);
    expect(floor().walls).toHaveLength(1);
  });

  it('restores a room name through undo', () => {
    const room = addRoomRect({ x: 0, y: 0 }, { x: 4000, y: 3000 })!;
    setRoomName(room.id, 'Kitchen');
    expect(floor().rooms[0]!.name).toBe('Kitchen');

    useStore.getState().undo();
    expect(floor().rooms[0]!.name).toBe('Room 1');
  });

  it('bounds the history rather than growing without limit', () => {
    for (let i = 0; i < HISTORY_LIMIT + 15; i++) {
      addWallChain([
        { x: i * 10, y: 0 },
        { x: i * 10 + 500, y: 0 },
      ]);
    }
    expect(useStore.getState().past).toHaveLength(HISTORY_LIMIT);
    expect(floor().walls).toHaveLength(HISTORY_LIMIT + 15);
  });
});

describe('no-op mutations', () => {
  it('do not land on the undo stack', () => {
    // Every mutation bumps `modifiedAt`, so the timestamp cannot be the test for
    // whether anything actually happened.
    useStore.getState().mutate('nothing', () => {});
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().dirty).toBe(false);
  });

  it('are what an empty commit produces', () => {
    expect(addWallChain([{ x: 0, y: 0 }])).toEqual([]);
    expect(addRoomRect({ x: 0, y: 0 }, { x: 10, y: 10 })).toBeNull();
    expect(useStore.getState().past).toHaveLength(0);
  });
});

describe('selection', () => {
  it('is pruned when its entity is deleted', () => {
    const walls = addWallChain([CHAIN[0]!, CHAIN[1]!]);
    const ref = { kind: 'wall' as const, id: walls[0]!.id };
    useStore.getState().setSelection([ref]);

    deleteSelection([ref]);
    expect(floor().walls).toHaveLength(0);
    expect(useStore.getState().selection).toEqual([]);
  });

  it('is pruned when undo removes its entity', () => {
    const walls = addWallChain([CHAIN[0]!, CHAIN[1]!]);
    useStore.getState().setSelection([{ kind: 'wall', id: walls[0]!.id }]);

    useStore.getState().undo();
    expect(useStore.getState().selection).toEqual([]);
  });

  it('toggles additively', () => {
    const walls = addWallChain(CHAIN);
    const a = { kind: 'wall' as const, id: walls[0]!.id };
    const b = { kind: 'wall' as const, id: walls[1]!.id };

    useStore.getState().setSelection([a]);
    useStore.getState().toggleSelection(b);
    expect(useStore.getState().selection).toHaveLength(2);

    useStore.getState().toggleSelection(b);
    expect(useStore.getState().selection).toEqual([a]);
  });

  it('is dropped when the edit mode changes', () => {
    // A wall selected in plan mode is not selectable in furnish mode; leaving it
    // highlighted would offer a Delete button the mode does not honour.
    const walls = addWallChain(CHAIN);
    useStore.getState().setSelection([{ kind: 'wall', id: walls[0]!.id }]);
    useStore.getState().setEditMode('furnish');
    expect(useStore.getState().selection).toEqual([]);
  });
});

describe('deleting a wall', () => {
  it('takes its openings with it', () => {
    const walls = addWallChain(CHAIN);
    const wallId = walls[0]!.id;
    useStore.getState().mutate('add opening', (draft) => {
      draft.floors[0]!.openings.push({
        id: 'o1',
        wallId,
        offsetMm: 900,
        widthMm: 813,
        heightMm: 2032,
        sillMm: 0,
        kind: 'door',
      });
    });
    expect(floor().openings).toHaveLength(1);

    // An opening whose host is gone has no position and nothing to cut.
    deleteSelection([{ kind: 'wall', id: wallId }]);
    expect(floor().openings).toHaveLength(0);
  });
});

describe('document lifecycle', () => {
  it('marks dirty on change and clean on save', () => {
    expect(useStore.getState().dirty).toBe(false);
    addWallChain(CHAIN);
    expect(useStore.getState().dirty).toBe(true);

    useStore.getState().markSaved();
    expect(useStore.getState().dirty).toBe(false);
  });

  it('clears history when a document is loaded', () => {
    addWallChain(CHAIN);
    const json = writeSpaceJson(useStore.getState().doc);

    useStore.getState().loadDocument(readSpaceJson(json));
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().future).toHaveLength(0);
    expect(useStore.getState().dirty).toBe(false);
    expect(floor().walls).toHaveLength(3);
  });

  it('round-trips a drawn plan through the file format', () => {
    // The portability requirement, at the store level: draw, write, read, same plan.
    addRoomRect({ x: 0, y: 0 }, { x: 4000, y: 3000 });
    addShapeRoom('circle', { x: 6000, y: 0 }, { x: 8000, y: 2000 });
    const before = useStore.getState().doc;

    const after = readSpaceJson(writeSpaceJson(before));
    expect(after).toEqual(before);
  });

  it('resets the viewport for a new document', () => {
    useStore.getState().setViewport({ scale: 0.5, x: -900, y: 40 });
    useStore.getState().newDocument();
    expect(useStore.getState().viewport).toEqual(DEFAULT_VIEWPORT);
    expect(screenToDoc(useStore.getState().viewport, { x: 120, y: 100 })).toEqual({ x: 0, y: 0 });
  });
});

describe('zoomToFit', () => {
  it('frames what has been drawn', () => {
    addRoomRect({ x: 10_000, y: 10_000 }, { x: 14_000, y: 13_000 });
    useStore.getState().setStageSize({ width: 900, height: 700 });
    useStore.getState().zoomToFit();

    const vp = useStore.getState().viewport;
    const centre = screenToDoc(vp, { x: 450, y: 350 });
    expect(centre.x).toBeCloseTo(12_000, 3);
    expect(centre.y).toBeCloseTo(11_500, 3);
  });

  it('falls back to the default viewport for an empty floor', () => {
    useStore.getState().zoomToFit();
    expect(useStore.getState().viewport).toEqual(DEFAULT_VIEWPORT);
  });

  it('reports no bounds for an empty floor', () => {
    expect(floorBounds(floor())).toBeNull();
  });

  it('includes wall thickness in the fitted extent', () => {
    addWallChain([
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
    ]);
    const box = floorBounds(floor())!;
    expect(box.minY).toBeCloseTo(-57, 6);
    expect(box.maxY).toBeCloseTo(57, 6);
  });
});
