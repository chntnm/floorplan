import { describe, expect, it } from 'vitest';
import {
  FLOOR_ASSEMBLY_MM,
  createStackedFloor,
  descendantsOf,
  floorAbove,
  floorBelow,
  floorHeight,
  orderedFloors,
  remountForFloor,
  suggestedElevation,
  uniqueFloorName,
  visibleFloors,
} from './floors';
import {
  DEFAULT_CEILING_HEIGHT_MM,
  createDocument,
  createFloor,
  type Floor,
  type Placement,
  type SpaceDocument,
} from './document';
import { polygon } from './geometry/polygon';

function doc(): SpaceDocument {
  return createDocument({ id: 'd', floorId: 'ground', now: '2026-01-01T00:00:00.000Z' });
}

/** Add a floor at `index` without going through the stacking helper. */
function push(d: SpaceDocument, id: string, name: string, index: number, elevationMm: number): Floor {
  const floor = createFloor(id, name, index);
  floor.elevationMm = elevationMm;
  d.floors.push(floor);
  return floor;
}

function placement(id: string, over: Partial<Placement> = {}): Placement {
  return {
    id,
    itemId: 'i',
    floorId: 'ground',
    position: { x: 0, y: 0 },
    rotation: 0,
    mount: { kind: 'floor' },
    elevation: 0,
    ...over,
  };
}

describe('stacking order', () => {
  it('orders by index, not by position in the array', () => {
    // The two disagree the first time someone adds a basement: it takes index −1 and
    // is appended, so array order says it is on top.
    const d = doc();
    push(d, 'up', 'Upstairs', 1, 2738);
    push(d, 'down', 'Basement', -1, -2738);

    expect(orderedFloors(d).map((f) => f.id)).toEqual(['down', 'ground', 'up']);
  });

  it('finds the floor immediately below and above', () => {
    const d = doc();
    push(d, 'up', 'Upstairs', 1, 2738);
    push(d, 'down', 'Basement', -1, -2738);

    expect(floorBelow(d, 'ground')?.id).toBe('down');
    expect(floorAbove(d, 'ground')?.id).toBe('up');
    expect(floorBelow(d, 'down')).toBeUndefined();
    expect(floorAbove(d, 'up')).toBeUndefined();
  });
});

describe('where a new floor lands', () => {
  it('clears the tallest ceiling on the floor below, plus the structure between', () => {
    const d = doc();
    d.floors[0]!.rooms.push({
      id: 'r',
      name: 'Vaulted living room',
      boundary: polygon([
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
      ]),
      ceilingHeightMm: 3600,
      areaMm2: 500_000,
    });

    // The vault, not the 2438 default — stacking a storey on top of a room it does
    // not clear is the one number that has to come from the document.
    expect(floorHeight(d.floors[0]!)).toBe(3600);
    expect(suggestedElevation(d, 1)).toBe(3600 + FLOOR_ASSEMBLY_MM);
  });

  it('hangs a basement below the floor above it', () => {
    const d = doc();
    expect(suggestedElevation(d, -1)).toBe(-(DEFAULT_CEILING_HEIGHT_MM + FLOOR_ASSEMBLY_MM));
  });

  it('is zero when there is nothing to stack against', () => {
    const d = doc();
    d.floors = [];
    expect(suggestedElevation(d, 0)).toBe(0);
  });

  it('adds at the ends only, above and below', () => {
    const d = doc();
    const up = createStackedFloor(d, 'above', 'f1');
    expect(up.index).toBe(1);
    expect(up.elevationMm).toBe(DEFAULT_CEILING_HEIGHT_MM + FLOOR_ASSEMBLY_MM);

    const down = createStackedFloor(d, 'below', 'f2');
    expect(down.index).toBe(-1);
    expect(down.name).toBe('Basement');
  });

  it('does not reuse a name already taken', () => {
    expect(uniqueFloorName('Basement', [{ name: 'Basement' }])).toBe('Basement 2');
  });
});

describe('moving between floors', () => {
  it('carries everything standing on a placement, however deep', () => {
    // A tray on a lamp on a dresser goes upstairs when the dresser does. Leaving it
    // strands a surface mount pointing at a host on another floor.
    const floor = createFloor('ground', 'Ground', 0);
    floor.placements = [
      placement('tray', { mount: { kind: 'surface', hostId: 'lamp' } }),
      placement('dresser'),
      placement('lamp', { mount: { kind: 'surface', hostId: 'dresser' } }),
    ];

    expect(descendantsOf(floor.placements, 'dresser')).toEqual(new Set(['dresser', 'lamp', 'tray']));
  });

  it('does not carry something standing on a different item', () => {
    const floor = createFloor('ground', 'Ground', 0);
    floor.placements = [
      placement('dresser'),
      placement('table'),
      placement('vase', { mount: { kind: 'surface', hostId: 'table' } }),
    ];

    expect(descendantsOf(floor.placements, 'dresser')).toEqual(new Set(['dresser']));
  });

  it('re-seats a wall mount, because the wall is not over there', () => {
    const shelf = placement('shelf', { mount: { kind: 'wall', wallId: 'w1' }, elevation: 1200 });
    expect(remountForFloor(shelf, new Set(['shelf']))).toEqual({
      mount: { kind: 'floor' },
      elevation: 0,
      reseated: true,
    });
  });

  it('keeps a surface mount whose host is travelling too', () => {
    const lamp = placement('lamp', { mount: { kind: 'surface', hostId: 'dresser' }, elevation: 810 });
    expect(remountForFloor(lamp, new Set(['dresser', 'lamp']))).toEqual({
      mount: { kind: 'surface', hostId: 'dresser' },
      elevation: 810,
      reseated: false,
    });
  });

  it('re-seats a surface mount whose host stayed behind', () => {
    const lamp = placement('lamp', { mount: { kind: 'surface', hostId: 'dresser' }, elevation: 810 });
    expect(remountForFloor(lamp, new Set(['lamp'])).reseated).toBe(true);
  });

  it('leaves a ceiling mount alone — it references nothing floor-local', () => {
    const pendant = placement('pendant', { mount: { kind: 'ceiling', drop: 400 } });
    expect(remountForFloor(pendant, new Set(['pendant'])).reseated).toBe(false);
  });
});

describe('what the space view shows', () => {
  function threeStorey(): SpaceDocument {
    const d = doc();
    push(d, 'up', 'Upstairs', 1, 2738);
    push(d, 'down', 'Basement', -1, -2738);
    return d;
  }

  it('shows the active floor alone', () => {
    const d = threeStorey();
    expect(visibleFloors(d, 'active').map((f) => f.id)).toEqual(['ground']);
  });

  it('shows the whole building, bottom to top', () => {
    const d = threeStorey();
    expect(visibleFloors(d, 'all').map((f) => f.id)).toEqual(['down', 'ground', 'up']);
  });

  it('cuts away the floors above, which are otherwise a lid', () => {
    const d = threeStorey();
    expect(visibleFloors(d, 'cutaway').map((f) => f.id)).toEqual(['down', 'ground']);
  });
});
