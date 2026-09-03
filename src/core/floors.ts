/**
 * Floors, and how they stack. See PLAN.md §11.
 *
 * Floors stack along the document's Z axis at their `elevationMm`. One is active: the
 * plan view edits it, the walker walks it, and the floor below it shows through as a
 * ghost so a staircase can be made to land in the right place.
 *
 * ## `index` is the stacking order; the array is insertion order
 *
 * `Floor` carries both a position in `doc.floors` and an `index`, which is two places
 * a reader could look for the same answer. `index` is the one that means it —
 * `orderedFloors` is the only thing that sorts, and nothing else reads array position
 * for stacking. That matters the first time someone adds a basement: it takes index
 * −1 and is appended to the array, so the two orders disagree immediately and
 * permanently.
 *
 * ## Elevation is suggested, not derived
 *
 * A new floor is put a storey above the one below it, which is a guess made from the
 * ceiling heights actually in the document. It is then an ordinary editable number:
 * a split level, a mezzanine and a garage half a storey down are all real, and none
 * of them survive a formula.
 *
 * Pure — no DOM, no store.
 */

import { createFloor, type Floor, type Id, type Placement, type SpaceDocument } from './document';

/**
 * Structure between one floor's ceiling and the next floor's datum.
 *
 * Joists, subfloor and finish. 300mm is an ordinary domestic build-up; it is only the
 * opening guess for a new floor's elevation, which is editable the moment it exists.
 */
export const FLOOR_ASSEMBLY_MM = 300;

/** Floors bottom to top. The only ordering in the application. */
export function orderedFloors(doc: SpaceDocument): Floor[] {
  return [...doc.floors].sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
}

/** The tallest ceiling anywhere on a floor — what has to be cleared to stack above it. */
export function floorHeight(floor: Floor): number {
  return floor.rooms.reduce(
    (h, r) => Math.max(h, r.ceilingHeightMm),
    floor.defaultCeilingHeightMm,
  );
}

/** The floor immediately below this one, by stacking order. */
export function floorBelow(doc: SpaceDocument, floorId: Id): Floor | undefined {
  const ordered = orderedFloors(doc);
  const i = ordered.findIndex((f) => f.id === floorId);
  return i > 0 ? ordered[i - 1] : undefined;
}

/** The floor immediately above this one, by stacking order. */
export function floorAbove(doc: SpaceDocument, floorId: Id): Floor | undefined {
  const ordered = orderedFloors(doc);
  const i = ordered.findIndex((f) => f.id === floorId);
  return i >= 0 && i < ordered.length - 1 ? ordered[i + 1] : undefined;
}

/**
 * Where a floor at `index` would sit.
 *
 * Above the nearest floor below it, clearing that floor's tallest ceiling and the
 * structure between them. With nothing below, it hangs the same distance under the
 * nearest floor above — which is how a basement gets a sensible negative datum
 * instead of sitting inside the ground floor.
 */
export function suggestedElevation(doc: SpaceDocument, index: number): number {
  const ordered = orderedFloors(doc);
  const below = [...ordered].reverse().find((f) => f.index < index);
  if (below) return below.elevationMm + floorHeight(below) + FLOOR_ASSEMBLY_MM;

  const above = ordered.find((f) => f.index > index);
  if (above) return above.elevationMm - (floorHeight(above) + FLOOR_ASSEMBLY_MM);

  return 0;
}

export function uniqueFloorName(base: string, existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A new empty floor, above or below everything already there.
 *
 * Only the ends, deliberately. Inserting between two floors means renumbering the
 * ones above, which rewrites `index` on floors nobody touched and makes one gesture
 * an edit to the whole building. Adding at an end and then editing the elevation does
 * everything inserting would, and says what it did.
 */
export function createStackedFloor(
  doc: SpaceDocument,
  where: 'above' | 'below',
  id: Id,
): Floor {
  const ordered = orderedFloors(doc);
  const index =
    where === 'above'
      ? (ordered[ordered.length - 1]?.index ?? -1) + 1
      : (ordered[0]?.index ?? 1) - 1;

  const name = uniqueFloorName(where === 'above' ? `Level ${index + 1}` : 'Basement', doc.floors);
  const floor = createFloor(id, name, index);
  floor.elevationMm = suggestedElevation(doc, index);
  return floor;
}

// ---------------------------------------------------------------------------
// Moving things between floors
// ---------------------------------------------------------------------------

/**
 * Everything riding on a placement, however many items deep.
 *
 * The mirror of `clearance.ts`'s `hostsAbove`. A tray on a lamp on a dresser goes
 * upstairs when the dresser does — anything else strands a surface mount pointing at
 * a host on another floor, which `findPlacement` would happily resolve and every
 * elevation calculation would then answer against the wrong datum.
 *
 * Takes a placement list rather than a floor because the very thing it is guarding
 * against is already representable: a cross-floor surface mount is in the model and can
 * be in a file, and searching only the source floor would leave exactly the rider this
 * function exists to carry.
 */
export function descendantsOf(placements: readonly Placement[], placementId: Id): Set<Id> {
  const found = new Set<Id>([placementId]);
  // Repeat until nothing new appears: `placements` is in no particular order, so one
  // pass would miss a tray listed before the lamp it stands on.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of placements) {
      if (found.has(p.id)) continue;
      if (p.mount.kind === 'surface' && found.has(p.mount.hostId)) {
        found.add(p.id);
        grew = true;
      }
    }
  }
  return found;
}

/**
 * What a mount becomes on the way to another floor.
 *
 * A `wall` mount names a wall that does not exist over there, and a `surface` mount
 * whose host stayed behind names a host that does not either. Both fall back to the
 * floor. A `ceiling` mount references nothing and survives; a `surface` mount whose
 * host is travelling too survives, because the pair stays intact.
 *
 * Returned rather than applied so the caller can say what it did — silently dropping
 * a wall-hung shelf to the floor of another storey is the kind of thing that should
 * come with a sentence.
 */
export function remountForFloor(
  placement: Placement,
  moving: ReadonlySet<Id>,
): { mount: Placement['mount']; elevation: number; reseated: boolean } {
  const { mount } = placement;
  if (mount.kind === 'wall') return { mount: { kind: 'floor' }, elevation: 0, reseated: true };
  if (mount.kind === 'surface' && !moving.has(mount.hostId)) {
    return { mount: { kind: 'floor' }, elevation: 0, reseated: true };
  }
  return { mount, elevation: placement.elevation, reseated: false };
}

// ---------------------------------------------------------------------------
// What the 3D view shows
// ---------------------------------------------------------------------------

/**
 * Which floors the space view draws.
 *
 * `active` is the floor you are editing, alone. `all` is the building. `cutaway` is
 * named for what it removes — the floors above, which are otherwise a lid you cannot
 * see past — so it shows the active floor and everything under it.
 *
 * This is a **display** setting and nothing else reads it. Collision always comes from
 * the active floor, or walking would change depending on what you had chosen to look
 * at. Two questions, as with clearance and the walkway probe.
 */
export type FloorVisibility = 'active' | 'all' | 'cutaway';

export const FLOOR_VISIBILITY: FloorVisibility[] = ['active', 'all', 'cutaway'];

export const FLOOR_VISIBILITY_LABELS: Record<FloorVisibility, string> = {
  active: 'This floor',
  all: 'All floors',
  cutaway: 'Cutaway',
};

export function visibleFloors(doc: SpaceDocument, visibility: FloorVisibility): Floor[] {
  const ordered = orderedFloors(doc);
  const active = ordered.find((f) => f.id === doc.activeFloorId);
  if (!active) return ordered.slice(0, 1);

  switch (visibility) {
    case 'active':
      return [active];
    case 'all':
      return ordered;
    case 'cutaway':
      return ordered.filter((f) => f.index <= active.index);
  }
}
