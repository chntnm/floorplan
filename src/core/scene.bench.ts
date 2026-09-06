import { bench, describe } from 'vitest';
import { createCatalogItem } from './catalog';
import { findCollisions, type Volume } from './geometry/collision';
import { createDocument, type Floor, type SpaceDocument } from './document';
import { blockersOf, buildScene, buildStack } from './scene';
import { commitRoomRect } from './tools';
import { validateFloor } from './validation';
import {
  NO_INPUT,
  WALK_SPEED_MMS,
  bodySpan,
  createWalker,
  forwardVector,
  isClear,
  stepWalker,
  type Walker,
} from './walk';

/**
 * What PLAN.md §10.4's target can honestly be checked against without a GPU.
 *
 * The target is 500 placements at 60fps, and most of what decides that is the
 * renderer — draw calls, culling, whether repeated catalog items are instanced. None
 * of it can be measured here, and a number taken from a software rasteriser in a
 * headless browser would read as a frame rate while measuring nothing of the sort.
 *
 * What *is* measurable is everything the renderer is handed, and one thing that runs
 * inside the frame. `buildScene` and `validateFloor` run once per edit;
 * `stepWalker` runs sixty times a second against the cached blocker list, so it is
 * the only figure here that comes out of the 16.7ms budget. It is timed twice, because
 * a frame that touches nothing and a frame that is blocked do different work: the
 * first is a bounding-box rejection per blocker, the second sweeps the blockers again
 * for the surfaces it is against and projects the move along them.
 *
 * Three densities, because placement count turns out not to be the variable that
 * matters — the number of *overlapping pairs* is, and those are two very different
 * numbers. Five hundred items on a 1.1m pitch is a furnished floor; on a 520mm pitch
 * every item touches its neighbours, which is a floor with a problem on it; on a
 * 120mm pitch they are piled on each other, which is not a plan anyone drew.
 *
 * Run with `pnpm bench`. Not part of `pnpm test` and not in CI: a timing that gates a
 * merge fails on whatever else the machine was doing.
 */

const PITCHES = {
  /** Furnished: a metre of clear floor around everything. */
  sparse: 1100,
  /** Every item against its neighbours. A floor the validation panel has notes on. */
  touching: 520,
  /** Piled. Not a plan, and here to show where the cost actually comes from. */
  piled: 120,
} as const;

const COUNT = 500;

let seq = 0;
const id = () => `id-${seq++}`;

function floorOf(pitchMm: number): { doc: SpaceDocument; floor: Floor } {
  seq = 0;
  const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
  const built = commitRoomRect({ x: 0, y: 0 }, { x: 40000, y: 32000 }, { name: 'Hall', makeId: id })!;
  const floor = doc.floors[0]!;
  floor.rooms.push(built.room);
  floor.walls.push(...built.walls);

  // Six catalog items over five hundred placements — the repetition §10.4's
  // instancing note is about, and the reason the scene model groups by item.
  const items = ['Chair', 'Table', 'Shelf', 'Lamp', 'Rug', 'Box'].map((name, i) =>
    createCatalogItem(
      { name, category: 'other', widthMm: 500 + i * 40, depthMm: 500, heightMm: 700, shape: 'rect' },
      id(),
    ),
  );
  doc.catalog.push(...items);

  const cols = Math.ceil(Math.sqrt(COUNT));
  for (let k = 0; k < COUNT; k++) {
    floor.placements.push({
      id: id(),
      itemId: items[k % items.length]!.id,
      floorId: 'f',
      position: { x: 900 + (k % cols) * pitchMm, y: 900 + Math.floor(k / cols) * pitchMm },
      rotation: 0,
      mount: { kind: 'floor' },
      elevation: 0,
    });
  }
  return { doc, floor };
}

/**
 * Check that a walker is standing clear and that one frame's stride ahead is what the
 * bench says it is. A bench that times the wrong thing is worse than none — the first
 * version of this file stood its walker inside a placement at one pitch and in open
 * floor at the others, and the blocked frame it claimed to measure never happened.
 */
function assertStride(walker: Walker, blockers: readonly Volume[], blocked: boolean) {
  const span = bodySpan(walker);
  const { x, y } = walker.position;
  if (!isClear(walker.position, span, blockers)) {
    throw new Error(`the walker at ${x},${y} is standing inside something`);
  }
  const f = forwardVector(walker.heading);
  const stride = WALK_SPEED_MMS / 60;
  const ahead = { x: x + f.x * stride, y: y + f.y * stride };
  if (isClear(ahead, span, blockers) === blocked) {
    throw new Error(`the step from ${x},${y} should be ${blocked ? 'blocked' : 'clear'}`);
  }
}

for (const [label, pitchMm] of Object.entries(PITCHES)) {
  describe(`${COUNT} placements, ${label}`, () => {
    const { doc, floor } = floorOf(pitchMm);
    const scene = buildScene(doc, floor);
    const blockers = blockersOf(scene);
    const world = { blockers, mode: 'walk' as const };

    // Open floor in the far corner, beyond the grid at every pitch.
    const clear = createWalker({ x: 32000, y: 28000 }, 45);
    // Ten millimetres clear of the first row's face and a stride short of touching
    // it, walking south-east — into the row, with an east component for the slide to
    // keep, which is the whole of the blocked path.
    const blocked = createWalker({ x: 900, y: 390 }, 135);
    assertStride(clear, blockers, false);
    assertStride(blocked, blockers, true);

    bench('buildScene', () => {
      buildScene(doc, floor);
    });

    bench('buildStack', () => {
      buildStack(doc, [floor], floor.id);
    });

    bench('blockersOf', () => {
      blockersOf(scene);
    });

    bench('findCollisions', () => {
      findCollisions(blockers);
    });

    bench('validateFloor', () => {
      validateFloor(doc, floor);
    });

    // The frame. Everything above is per edit.
    bench('stepWalker, clear', () => {
      stepWalker(clear, { ...NO_INPUT, forward: 1 }, 1 / 60, world);
    });

    bench('stepWalker, blocked', () => {
      stepWalker(blocked, { ...NO_INPUT, forward: 1 }, 1 / 60, world);
    });
  });
}
