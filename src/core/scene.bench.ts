import { bench, describe } from 'vitest';
import { createCatalogItem } from './catalog';
import { findCollisions } from './geometry/collision';
import { createDocument, type Floor, type SpaceDocument } from './document';
import { blockersOf, buildScene, buildStack } from './scene';
import { commitRoomRect } from './tools';
import { validateFloor } from './validation';
import { NO_INPUT, createWalker, stepWalker } from './walk';

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
 * the only figure here that comes out of the 16.7ms budget.
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

for (const [label, pitchMm] of Object.entries(PITCHES)) {
  describe(`${COUNT} placements, ${label}`, () => {
    const { doc, floor } = floorOf(pitchMm);
    const scene = buildScene(doc, floor);
    const blockers = blockersOf(scene);
    const walker = createWalker({ x: 20000, y: 16000 }, 45);
    const world = { blockers, mode: 'walk' as const };

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
    bench('stepWalker', () => {
      stepWalker(walker, { ...NO_INPUT, forward: 1 }, 1 / 60, world);
    });
  });
}
