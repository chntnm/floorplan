import { describe, expect, it } from 'vitest';
import {
  BODY_RADIUS_MM,
  WALK_SPEED_MMS,
  CROUCH_EYE_MM,
  EYE_HEIGHT_MM,
  NO_INPUT,
  createWalker,
  bodySpan,
  eyePosition,
  forwardVector,
  groundHeight,
  isClear,
  look,
  lookTarget,
  normalizeHeading,
  rightVector,
  stepWalker,
  type WalkInput,
  type Walker,
  type WalkWorld,
} from './walk';
import { blockersOf, buildScene } from './scene';
import { createOpening, type OpeningDefaults } from './openings';
import { createCatalogItem, type ItemDraft } from './catalog';
import { commitRoomRect } from './tools';
import { createDocument, type OpeningKind, type Placement, type SpaceDocument } from './document';

let seq = 0;
const id = () => `id-${seq++}`;

/**
 * A 5m × 4m room. Its north wall runs along y = 0; the interior is y > 57.
 *
 * The walker fixtures below all stand in the middle facing north (heading 0) and
 * walk at the north wall, so "did I get out?" is `position.y < 0`.
 */
function room(): SpaceDocument {
  seq = 0;
  const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
  const built = commitRoomRect({ x: 0, y: 0 }, { x: 5000, y: 4000 }, { name: 'Room', makeId: id })!;
  doc.floors[0]!.rooms.push(built.room);
  doc.floors[0]!.walls.push(...built.walls);
  return doc;
}

function cutNorthWall(doc: SpaceDocument, kind: OpeningKind, size?: Partial<OpeningDefaults>) {
  const north = doc.floors[0]!.walls[0]!;
  doc.floors[0]!.openings.push(
    createOpening({ id: id(), wall: north, kind, centreMm: 2500, ...(size ? { size } : {}) }),
  );
}

function put(doc: SpaceDocument, draft: ItemDraft, at: { x: number; y: number }, over: Partial<Placement> = {}) {
  const item = createCatalogItem(draft, id());
  doc.catalog.push(item);
  doc.floors[0]!.placements.push({
    id: id(),
    itemId: item.id,
    floorId: 'f',
    position: at,
    rotation: 0,
    mount: { kind: 'floor' },
    elevation: 0,
    ...over,
  });
}

function world(doc: SpaceDocument, mode: WalkWorld['mode'] = 'walk'): WalkWorld {
  return { blockers: blockersOf(buildScene(doc, doc.floors[0]!)), mode };
}

/** Run the walk loop at 60fps for `seconds`, which is what the render loop does. */
function walkFor(
  walker: Walker,
  input: Partial<WalkInput>,
  seconds: number,
  w: WalkWorld,
): Walker {
  const dt = 1 / 60;
  let current = walker;
  for (let t = 0; t < seconds; t += dt) {
    current = stepWalker(current, { ...NO_INPUT, ...input }, dt, w);
  }
  return current;
}

/** Standing in the middle of the room, facing the north wall. */
function inside(): Walker {
  return createWalker({ x: 2500, y: 2000 }, 0);
}

describe('bearings', () => {
  it('reads 0 as north and 90 as east, matching the plan on screen', () => {
    // The document's y axis points south, so a compass bearing is the reading that
    // matches what you see in plan view.
    expect(forwardVector(0).x).toBeCloseTo(0, 9);
    expect(forwardVector(0).y).toBeCloseTo(-1, 9);
    expect(forwardVector(90).x).toBeCloseTo(1, 9);
    expect(forwardVector(90).y).toBeCloseTo(0, 9);
  });

  it('puts the walker’s right hand to the east when they face north', () => {
    expect(rightVector(0).x).toBeCloseTo(1, 9);
    expect(rightVector(0).y).toBeCloseTo(0, 9);
    expect(rightVector(90).y).toBeCloseTo(1, 9); // facing east, right is south
  });

  it('keeps a heading in [0, 360)', () => {
    expect(normalizeHeading(-90)).toBe(270);
    expect(normalizeHeading(450)).toBe(90);
  });
});

describe('the body interval', () => {
  it('starts a stride above the floor, not at it', () => {
    // The reason a 5mm rug does not stop a walker dead: [0,1800] genuinely overlaps
    // [0,5], and [200,1800] does not.
    expect(bodySpan(inside())).toEqual({ bottom: 200, top: 1800 });
  });

  it('rises for a deliberate step up, and lowers its head for a crouch', () => {
    expect(bodySpan(inside(), true).bottom).toBe(450);
    expect(bodySpan({ ...inside(), crouching: true }).top).toBe(1250);
  });

  it('rides on whatever the walker is standing on', () => {
    expect(bodySpan({ ...inside(), elevation: 400 })).toEqual({ bottom: 600, top: 2200 });
  });
});

describe('walking through a doorway', () => {
  it('gets out through an 813mm door', () => {
    const doc = room();
    cutNorthWall(doc, 'door');

    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));
    expect(after.position.y).toBeLessThan(0);
    // Straight through, not squeezed sideways.
    expect(after.position.x).toBeCloseTo(2500, 0);
  });

  it('does not get out through a solid wall', () => {
    const doc = room();
    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));

    // Stopped a body radius clear of the wall's inner face, which is at y = 57 —
    // within one frame of it, since the loop moves in discrete 23mm steps and stops
    // at the last position that was clear.
    const contact = 57 + BODY_RADIUS_MM;
    expect(after.position.y).toBeGreaterThanOrEqual(contact);
    expect(after.position.y).toBeLessThan(contact + (WALK_SPEED_MMS / 60));
  });

  it('does not fit through a 400mm gap', () => {
    // The capsule radius has to be enforced, not merely declared. Every other
    // traversal test uses an 813mm door, which would never exercise it.
    const doc = room();
    cutNorthWall(doc, 'cased', { widthMm: 400 });

    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));
    expect(after.position.y).toBeGreaterThan(0);
  });

  it('walks under the lintel without ducking', () => {
    const doc = room();
    cutNorthWall(doc, 'door');
    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));

    expect(after.crouching).toBe(false);
    expect(after.position.y).toBeLessThan(0);
  });

  it('cannot climb through a window', () => {
    // Sill 914 is inside the body interval, so the wall below a window is still wall.
    const doc = room();
    cutNorthWall(doc, 'window');

    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));
    expect(after.position.y).toBeGreaterThan(0);
  });
});

describe('walking among furniture', () => {
  const RUG: ItemDraft = {
    name: 'Rug',
    category: 'rug',
    shape: 'rect',
    widthMm: 3000,
    depthMm: 3000,
    heightMm: 10,
    voidBelowMm: 0,
  };

  const DRESSER: ItemDraft = {
    name: 'Dresser',
    category: 'storage',
    shape: 'rect',
    widthMm: 1500,
    depthMm: 500,
    heightMm: 810,
    voidBelowMm: 0,
  };

  const TABLE: ItemDraft = {
    name: 'Table',
    category: 'table',
    shape: 'rect',
    widthMm: 1800,
    depthMm: 900,
    heightMm: 760,
    voidBelowMm: 720,
  };

  const SHELF: ItemDraft = {
    name: 'Shelf',
    category: 'storage',
    shape: 'rect',
    widthMm: 2000,
    depthMm: 300,
    heightMm: 300,
    voidBelowMm: 0,
  };

  const PLATFORM: ItemDraft = {
    name: 'Storage cube',
    category: 'storage',
    shape: 'rect',
    widthMm: 1200,
    depthMm: 1200,
    heightMm: 400,
    voidBelowMm: 0,
  };

  it('walks over a rug rather than being stopped by a carpet', () => {
    const doc = room();
    cutNorthWall(doc, 'door');
    put(doc, RUG, { x: 2500, y: 1200 });

    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));
    expect(after.position.y).toBeLessThan(0);
  });

  it('stands on the rug while crossing it', () => {
    const doc = room();
    put(doc, RUG, { x: 2500, y: 1500 });

    const after = walkFor(inside(), { forward: 1 }, 0.4, world(doc));
    expect(after.elevation).toBe(10);
  });

  it('is stopped by a dresser', () => {
    const doc = room();
    cutNorthWall(doc, 'door');
    put(doc, DRESSER, { x: 2500, y: 1200 });

    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));
    expect(after.position.y).toBeGreaterThan(1200);
  });

  it('is stopped by a dining table, because a table top is at chest height', () => {
    // `voidBelowMm` is the open air *below* the top, so a table is [720, 760] of
    // solid — squarely inside the body interval [200, 1800]. The void is what lets a
    // rug lie under the table, not what lets a person walk through it.
    const doc = room();
    cutNorthWall(doc, 'door');
    put(doc, TABLE, { x: 2500, y: 1200 });

    const after = walkFor(inside(), { forward: 1 }, 4, world(doc));
    expect(after.position.y).toBeGreaterThan(1650); // the table's near edge
  });

  it('ducks under a wall shelf it cannot otherwise pass', () => {
    const doc = room();
    put(doc, SHELF, { x: 2500, y: 1200 }, { mount: { kind: 'wall', wallId: 'w' }, elevation: 1400 });
    const w = world(doc);

    // Standing: the shelf at [1400, 1700] is inside the body interval.
    expect(walkFor(inside(), { forward: 1 }, 3, w).position.y).toBeGreaterThan(1200);
    // Crouching: the head drops to 1250 and the shelf passes overhead.
    expect(walkFor(inside(), { forward: 1, crouch: true }, 3, w).position.y).toBeLessThan(1200);
  });

  it('steps up onto a low platform only when the step key is held', () => {
    // The cube spans y 400..1600, so a walker starting at y = 2000 begins clear of it.
    const doc = room();
    put(doc, PLATFORM, { x: 2500, y: 1000 });
    const w = world(doc);

    // 0.7s is ~980mm — far enough to be standing on it, not far enough to cross it.
    const walked = walkFor(inside(), { forward: 1 }, 0.7, w);
    expect(walked.elevation).toBe(0);
    expect(walked.position.y).toBeGreaterThan(1600); // stopped at its near edge

    const stepped = walkFor(inside(), { forward: 1, stepUp: true }, 0.7, w);
    expect(stepped.elevation).toBe(400);
    expect(stepped.position.y).toBeLessThan(1600);
  });

  it('steps back down off the platform without needing the key', () => {
    // Rising is limited to a stride; falling is not, which is what lets you walk off.
    const doc = room();
    put(doc, PLATFORM, { x: 2500, y: 1000 });
    const w = world(doc);

    const up = walkFor(inside(), { forward: 1, stepUp: true }, 0.7, w);
    expect(up.elevation).toBe(400);

    const down = walkFor(up, { forward: 1 }, 1.5, w);
    expect(down.elevation).toBe(0);
  });

  it('lets a walker who has been built around walk back out', () => {
    // Furniture placed on top of where someone is standing blocks every candidate
    // move, and they would be frozen with no way out but switching to fly.
    const doc = room();
    put(doc, DRESSER, { x: 2500, y: 2000 });

    const after = walkFor(inside(), { forward: 1 }, 1, world(doc));
    expect(after.position.y).toBeLessThan(2000);
  });
});

describe('sliding', () => {
  it('slides along a wall approached at an angle instead of stopping dead', () => {
    const doc = room();
    // Facing north-east, into the north wall. The y component is blocked; the x
    // component is not, so the walker should end up further east than they started.
    const after = walkFor(createWalker({ x: 2000, y: 500 }, 45), { forward: 1 }, 2, world(doc));

    expect(after.position.x).toBeGreaterThan(2500);
    expect(after.position.y).toBeGreaterThan(0);
  });
});

describe('the camera', () => {
  it('puts the eye at standing height above whatever the feet are on', () => {
    expect(eyePosition(inside()).z).toBe(EYE_HEIGHT_MM);
    expect(eyePosition({ ...inside(), elevation: 400 }).z).toBe(400 + EYE_HEIGHT_MM);
    expect(eyePosition({ ...inside(), crouching: true }).z).toBe(CROUCH_EYE_MM);
  });

  it('looks where the walker is facing', () => {
    const target = lookTarget(inside(), 1000);
    expect(target.y).toBeCloseTo(2000 - 1000, 6);
    expect(target.z).toBeCloseTo(EYE_HEIGHT_MM, 6);
  });

  it('clamps pitch so the horizon never ends up behind you', () => {
    expect(look(inside(), 0, 200).pitch).toBe(85);
    expect(look(inside(), 0, -200).pitch).toBe(-85);
  });

  it('wraps yaw rather than accumulating a five-figure angle', () => {
    expect(look({ ...inside(), heading: 350 }, 20, 0).heading).toBe(10);
  });
});

describe('fly mode', () => {
  it('goes through walls, because inspecting a ceiling means getting to it', () => {
    const doc = room();
    const after = walkFor(inside(), { forward: 1 }, 4, world(doc, 'fly'));
    expect(after.position.y).toBeLessThan(0);
  });

  it('rises and falls, but not below the floor', () => {
    const doc = room();
    const w = world(doc, 'fly');
    expect(walkFor(inside(), { rise: 1 }, 1, w).elevation).toBeGreaterThan(1000);
    expect(walkFor(inside(), { rise: -1 }, 1, w).elevation).toBe(0);
  });

  it('does not crouch — there is nothing to duck under when nothing blocks', () => {
    const doc = room();
    expect(walkFor(inside(), { crouch: true }, 0.5, world(doc, 'fly')).crouching).toBe(false);
  });
});

describe('the timestep', () => {
  it('clamps a huge delta, so a backgrounded tab does not teleport the walker', () => {
    const doc = room();
    const after = stepWalker(inside(), { ...NO_INPUT, forward: 1 }, 30, world(doc));

    // 30 seconds would be 42 metres. Clamped to 100ms, it is 140mm.
    expect(after.position.y).toBeCloseTo(2000 - 140, 6);
  });

  it('does nothing at all for a zero-length frame', () => {
    const doc = room();
    const before = inside();
    expect(stepWalker(before, { ...NO_INPUT, forward: 1 }, 0, world(doc))).toBe(before);
  });
});

describe('isClear and groundHeight', () => {
  it('reports a body inside a solid as colliding, not as clear', () => {
    // A walker that has somehow ended up inside a wall must read as blocked, or it
    // would be free to walk out through the far side.
    const doc = room();
    const blockers = blockersOf(buildScene(doc, doc.floors[0]!));
    expect(isClear({ x: 2500, y: 0 }, { bottom: 200, top: 1800 }, blockers)).toBe(false);
  });

  it('finds the floor under a point with nothing on it', () => {
    const doc = room();
    const blockers = blockersOf(buildScene(doc, doc.floors[0]!));
    expect(groundHeight({ x: 2500, y: 2000 }, 0, blockers, 200)).toBe(0);
  });
});
