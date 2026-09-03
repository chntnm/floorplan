import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, floorBounds, useStore, HISTORY_LIMIT } from './store';
import {
  addRoomRect,
  addShapeRoom,
  addWallChain,
  commitWallTransform,
  deleteSelection,
  previewWallTransform,
  renameDocument,
  setRoomName,
} from './actions';
import type { WallTransform } from './store';
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

describe('wall transform', () => {
  function grabWall(end: 'a' | 'b' | 'both'): WallTransform {
    const wall = addWallChain([
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
    ])[0]!;
    return {
      wallId: wall.id,
      end,
      grab: { x: 2000, y: 0 },
      origin: { a: wall.a, b: wall.b },
      a: wall.a,
      b: wall.b,
    };
  }

  it('moves one endpoint and leaves the other alone', () => {
    const moved = previewWallTransform(grabWall('b'), { x: 6000, y: 0 });
    commitWallTransform(moved);

    expect(floor().walls[0]!.a).toEqual({ x: 0, y: 0 });
    expect(floor().walls[0]!.b).toEqual({ x: 6000, y: 0 });
  });

  it('translates the whole wall by the drag delta', () => {
    const moved = previewWallTransform(grabWall('both'), { x: 2500, y: 1000 });
    commitWallTransform(moved);

    expect(floor().walls[0]!.a).toEqual({ x: 500, y: 1000 });
    expect(floor().walls[0]!.b).toEqual({ x: 4500, y: 1000 });
  });

  it('measures a body move from the original, not the last frame', () => {
    // Otherwise a drag that reverses direction accumulates instead of tracking.
    const start = grabWall('both');
    const half = previewWallTransform(start, { x: 3000, y: 0 });
    const back = previewWallTransform(half, { x: 2000, y: 0 });
    expect(back.a).toEqual({ x: 0, y: 0 });
  });

  it('is one undo step for a whole drag', () => {
    const start = grabWall('b');
    expect(useStore.getState().past).toHaveLength(1); // the wall itself

    // Every intermediate frame is a preview; only the last is committed.
    let live = start;
    for (let x = 4000; x <= 6000; x += 25) live = previewWallTransform(live, { x, y: 0 });
    commitWallTransform(live);

    expect(useStore.getState().past).toHaveLength(2);
    useStore.getState().undo();
    expect(floor().walls[0]!.b).toEqual({ x: 4000, y: 0 });
  });

  it('does not record a press that never moved', () => {
    // immer writes a patch for an assignment even when the value is deep-equal, so
    // clicking a wall would otherwise leave a do-nothing entry on the stack.
    const start = grabWall('both');
    commitWallTransform(previewWallTransform(start, start.grab));
    expect(useStore.getState().past).toHaveLength(1);
  });

  it('rounds to integer millimetres on commit', () => {
    commitWallTransform(previewWallTransform(grabWall('b'), { x: 5999.6, y: 0.4 }));
    expect(floor().walls[0]!.b).toEqual({ x: 6000, y: 0 });
  });

  it('ignores a wall that was deleted mid-drag', () => {
    const start = grabWall('b');
    deleteSelection([{ kind: 'wall', id: start.wallId }]);
    expect(() => commitWallTransform(previewWallTransform(start, { x: 6000, y: 0 }))).not.toThrow();
    expect(floor().walls).toHaveLength(0);
  });
});

describe('document lifecycle', () => {
  it('renames the document as one undo step', () => {
    renameDocument('Maple Street');
    expect(useStore.getState().doc.title).toBe('Maple Street');
    useStore.getState().undo();
    expect(useStore.getState().doc.title).toBe('Untitled space');
  });

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

describe('the walkway route', () => {
  const ROUTE = [
    { x: 0, y: 0 },
    { x: 3000, y: 0 },
  ];

  it('survives a tool change, unlike a measurement', () => {
    // It is a route you work against while moving furniture. A measurement is a
    // number you just took; losing that on a tool change costs nothing.
    const store = useStore.getState();
    store.setWalkway(ROUTE);
    store.setMeasurement({ from: ROUTE[0]!, to: ROUTE[1]! });

    useStore.getState().setTool('select');
    expect(useStore.getState().walkway).toEqual(ROUTE);
    expect(useStore.getState().measurement).toBeNull();
  });

  it('records no history — it is a question, not an edit', () => {
    const before = useStore.getState().past.length;
    useStore.getState().setWalkway(ROUTE);
    expect(useStore.getState().past).toHaveLength(before);
    expect(useStore.getState().dirty).toBe(false);
  });

  it('goes away with the document it was drawn on', () => {
    useStore.getState().setWalkway(ROUTE);
    useStore.getState().newDocument();
    expect(useStore.getState().walkway).toBeNull();
  });
});
