/**
 * Document actions — every write to the document goes through one of these.
 *
 * Each is a single `mutate` call, so each is a single undo step. Keeping them here
 * rather than inside components means a wall chain committed from the Konva stage and
 * one committed from a test take exactly the same path.
 */

import type {
  AssetRef,
  Background,
  CatalogItem,
  Id,
  Opening,
  OpeningKind,
  Placement,
  Room,
  Wall,
} from '../core/document';
import { createOpening, type OpeningDefaults } from '../core/openings';
import { detectRooms, type RoomDetection } from '../core/rooms';
import {
  createStackedFloor,
  descendantsOf,
  floorAbove,
  floorBelow,
  remountForFloor,
} from '../core/floors';
import { DEFAULT_SWING, clampSwingAngle, type Swing } from '../core/swing';
import { nearestWall, projectOntoWall } from '../core/geometry/wall';
import { createSavedView, uniqueViewName, type SpaceCamera } from '../core/views';
import type { Mount } from '../core/document';
import { createCatalogItem, type ItemDraft } from '../core/catalog';
import { snapPlacement, snapRotation, type PlacementSnapContext } from '../core/placement-snap';
import { worldOutline } from '../core/placement';
import { findItem } from '../core/document';
import { newId } from '../core/tools';
import { commitRoomRect, commitShapeRoom, commitWallChain, type ShapeKind } from '../core/tools';
import {
  applyCalibration,
  assertAcceptsPlacements,
  clampOpacity,
  docToImage,
  rotateBackground,
  backgroundCentre,
} from '../core/calibration';
import type { Vec2 } from '../core/geometry/vec';
import {
  activeFloor,
  useStore,
  type MutateOptions,
  type PlacementTransform,
  type SelectionRef,
  type WallTransform,
} from './store';

function withActiveFloor(label: string, fn: (floor: ReturnType<typeof activeFloor>) => void): void {
  const { mutate, doc } = useStore.getState();
  const floorId = doc.activeFloorId;
  mutate(label, (draft) => {
    const floor = draft.floors.find((f) => f.id === floorId);
    if (floor) fn(floor);
  });
}

/** Commit a drawn wall chain. Returns the walls added, for selection. */
export function addWallChain(points: readonly Vec2[]): Wall[] {
  const { wallDefaults } = useStore.getState();
  const walls = commitWallChain(points, wallDefaults);
  if (walls.length === 0) return [];

  withActiveFloor(walls.length === 1 ? 'Draw wall' : `Draw ${walls.length} walls`, (floor) => {
    floor.walls.push(...walls);
  });
  return walls;
}

/** Commit a dragged rectangular room, with its four enclosing walls. */
export function addRoomRect(start: Vec2, end: Vec2): Room | null {
  const state = useStore.getState();
  const floor = activeFloor(state);
  const result = commitRoomRect(start, end, {
    name: `Room ${floor.rooms.length + 1}`,
    ceilingHeightMm: floor.defaultCeilingHeightMm,
    walls: state.wallDefaults,
  });
  if (!result) return null;

  withActiveFloor('Draw room', (f) => {
    f.rooms.push(result.room);
    f.walls.push(...result.walls);
  });
  return result.room;
}

/** Commit a dragged non-rectangular room boundary. */
export function addShapeRoom(kind: ShapeKind, start: Vec2, end: Vec2): Room | null {
  const state = useStore.getState();
  const floor = activeFloor(state);
  const room = commitShapeRoom(kind, start, end, {
    name: `Area ${floor.rooms.length + 1}`,
    ceilingHeightMm: floor.defaultCeilingHeightMm,
  });
  if (!room) return null;

  withActiveFloor('Draw shape', (f) => {
    f.rooms.push(room);
  });
  return room;
}

/**
 * Delete a selection.
 *
 * Deleting a wall takes three things with it, and every one of them is a reference
 * that would otherwise dangle:
 *
 *  - **Openings on it** — an opening with a dangling `wallId` has no position, no
 *    host to cut and nothing that could render it.
 *  - **Wall-mounted placements** — a shelf whose wall is gone is re-seated on the
 *    floor. `resolveElevation` returns the stored elevation for a wall mount without
 *    checking the wall still exists, so leaving it would hang the shelf in mid-air.
 *  - **Surface children of deleted placements** — the same fix one level down.
 *    `resolveElevation` already degrades a dangling host to zero, which is the right
 *    *failure* but the wrong *result*: the lamp would sit at floor level while still
 *    claiming to be on a nightstand, and undo would have to put both back.
 *
 * Doing it here rather than tolerating it downstream means the document is never left
 * referencing something that is gone.
 */
export function deleteSelection(selection: readonly SelectionRef[]): void {
  if (selection.length === 0) return;

  const wallIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
  const roomIds = new Set(selection.filter((s) => s.kind === 'room').map((s) => s.id));
  const openingIds = new Set(selection.filter((s) => s.kind === 'opening').map((s) => s.id));
  const placementIds = new Set(selection.filter((s) => s.kind === 'placement').map((s) => s.id));

  const label = selection.length === 1 ? `Delete ${selection[0]!.kind}` : `Delete ${selection.length} items`;

  useStore.getState().mutate(label, (draft) => {
    for (const floor of draft.floors) {
      floor.walls = floor.walls.filter((w) => !wallIds.has(w.id));
      floor.openings = floor.openings.filter(
        (o) => !openingIds.has(o.id) && !wallIds.has(o.wallId),
      );
      floor.rooms = floor.rooms.filter((r) => !roomIds.has(r.id));
      floor.placements = floor.placements.filter((p) => !placementIds.has(p.id));

      for (const placement of floor.placements) {
        const orphanedHost =
          placement.mount.kind === 'surface' && placementIds.has(placement.mount.hostId);
        const orphanedWall = placement.mount.kind === 'wall' && wallIds.has(placement.mount.wallId);
        if (orphanedHost || orphanedWall) {
          placement.mount = { kind: 'floor' };
          placement.elevation = 0;
        }
      }
    }
  });
}


// ---------------------------------------------------------------------------
// Floors (PLAN.md §11)
// ---------------------------------------------------------------------------

/** Add an empty floor at the top or bottom of the stack, and switch to it. */
export function addFloor(where: 'above' | 'below'): Id {
  const { doc } = useStore.getState();
  const floor = createStackedFloor(doc, where, newId());

  useStore.getState().mutate(`Add floor ${where}`, (draft) => {
    draft.floors.push(floor);
  });
  useStore.getState().setActiveFloor(floor.id);
  return floor.id;
}

export function renameFloor(floorId: Id, name: string): void {
  useStore.getState().mutate('Rename floor', (draft) => {
    const floor = draft.floors.find((f) => f.id === floorId);
    if (floor) floor.name = name;
  });
}

/**
 * Set a floor's datum above building zero.
 *
 * Signed and unclamped on purpose: a basement's datum is negative, and so is a garage
 * half a storey down.
 */
export function setFloorElevation(floorId: Id, elevationMm: number): void {
  useStore.getState().mutate('Floor elevation', (draft) => {
    const floor = draft.floors.find((f) => f.id === floorId);
    if (floor) floor.elevationMm = Math.round(elevationMm);
  });
}

export function setFloorCeilingHeight(floorId: Id, heightMm: number): void {
  useStore.getState().mutate('Default ceiling', (draft) => {
    const floor = draft.floors.find((f) => f.id === floorId);
    if (floor) floor.defaultCeilingHeightMm = Math.max(1, Math.round(heightMm));
  });
}

/**
 * Remove a floor and everything on it.
 *
 * Refuses the last floor: a document with no floors has nowhere to draw, and every
 * caller of `activeFloor` would be falling back forever. Returns a sentence when it
 * refuses rather than failing quietly.
 *
 * Anything on *another* floor surface-mounted onto something here is re-seated on its
 * own floor, the same repair deletion has done since phase 4. Nothing in the editor
 * can create a cross-floor surface mount, but the model can express one and a file
 * can contain one, and a dangling `hostId` resolves through `findPlacement` — which
 * searches every floor — into an elevation measured against the wrong datum.
 */
export function deleteFloor(floorId: Id): string | null {
  const { doc } = useStore.getState();
  if (doc.floors.length <= 1) return 'A space needs at least one floor.';

  const going = doc.floors.find((f) => f.id === floorId);
  if (!going) return null;

  const orphanedHosts = new Set(going.placements.map((p) => p.id));
  const next = floorBelow(doc, floorId) ?? floorAbove(doc, floorId) ?? doc.floors[0]!;

  useStore.getState().mutate(`Delete floor ${going.name}`, (draft) => {
    draft.floors = draft.floors.filter((f) => f.id !== floorId);
    for (const floor of draft.floors) {
      for (const placement of floor.placements) {
        if (placement.mount.kind === 'surface' && orphanedHosts.has(placement.mount.hostId)) {
          placement.mount = { kind: 'floor' };
          placement.elevation = 0;
        }
      }
    }
    if (draft.activeFloorId === floorId) draft.activeFloorId = next.id;
  });

  useStore.getState().setActiveFloor(next.id);
  return null;
}

/**
 * Move a placement — and everything standing on it — to another floor.
 *
 * An explicit action rather than a drag, per PLAN §11: the plan view shows one floor,
 * so there is nowhere to drag *to*, and a gesture that silently changed storeys would
 * be indistinguishable from a nudge.
 *
 * Two things travel or break. Anything surface-mounted on it goes too, or it would be
 * left pointing at a host on another floor. And a `wall` mount names a wall that does
 * not exist over there, so it is re-seated on the floor — reported, because a shelf
 * that was on the wall and is now on the ground is worth a sentence rather than a
 * discovery.
 */
export function movePlacementToFloor(placementId: Id, floorId: Id): string | null {
  const { doc } = useStore.getState();
  const from = doc.floors.find((f) => f.placements.some((p) => p.id === placementId));
  if (!from || from.id === floorId) return null;
  if (!doc.floors.some((f) => f.id === floorId)) return null;

  const moving = descendantsOf(from, placementId);
  let reseated = 0;

  useStore.getState().mutate('Move to floor', (draft) => {
    const source = draft.floors.find((f) => f.id === from.id);
    const target = draft.floors.find((f) => f.id === floorId);
    if (!source || !target) return;

    const travelling = source.placements.filter((p) => moving.has(p.id));
    source.placements = source.placements.filter((p) => !moving.has(p.id));

    for (const placement of travelling) {
      const next = remountForFloor(placement, moving);
      if (next.reseated) reseated++;
      placement.floorId = floorId;
      placement.mount = next.mount;
      placement.elevation = next.elevation;
      target.placements.push(placement);
    }
  });

  const carried = moving.size - 1;
  const parts: string[] = [];
  if (carried > 0) parts.push(`${carried} item${carried === 1 ? '' : 's'} on it moved too`);
  if (reseated > 0) parts.push(`${reseated} wall mount${reseated === 1 ? '' : 's'} reseated on the floor`);
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}

// ---------------------------------------------------------------------------
// Openings (PLAN.md §4.4)
// ---------------------------------------------------------------------------

/**
 * Put an opening in the wall nearest a clicked point.
 *
 * The click is projected onto the wall's centreline and taken as the *centre* of the
 * opening, which is where a person pointing at a wall means the door to be. Returns
 * null when the click was not on a wall; throws `OpeningError`, with a message meant
 * to be shown, when the wall cannot hold the opening at all.
 */
export function addOpening(
  at: Vec2,
  kind: OpeningKind,
  toleranceMm: number,
  size?: Partial<OpeningDefaults>,
): Opening | null {
  const state = useStore.getState();
  const floor = activeFloor(state);
  const wall = nearestWall(floor.walls, at, toleranceMm);
  if (!wall) return null;

  const opening = createOpening({
    id: newId(),
    wall,
    kind,
    centreMm: projectOntoWall(wall, at),
    ...(size ? { size } : {}),
  });

  const floorId = floor.id;
  useStore.getState().mutate(`Add ${kind}`, (draft) => {
    const target = draft.floors.find((f) => f.id === floorId);
    if (target) target.openings.push(opening);
  });
  return opening;
}

/**
 * Edit an opening's size or position along its wall.
 *
 * Deliberately does **not** clamp to the wall. A number typed into the panel is what
 * the user meant, and quietly moving their front door to make it fit would hide the
 * mistake; validation reports an opening that no longer fits and the geometry simply
 * does not build it.
 *
 * A `kind` change deliberately does **not** clear the stored `swing`. Turning a door
 * into a cased opening and back gives you the door you had, hinged where you hung it,
 * rather than one re-seeded from defaults. `leafOf` decides whether the field is read
 * at all, so an unread swing on a cased opening costs nothing, and dropping one costs
 * a choice the user made.
 */
export function updateOpening(openingId: Id, patch: Partial<Omit<Opening, 'id' | 'wallId'>>): void {
  useStore.getState().mutate('Edit opening', (draft) => {
    for (const floor of draft.floors) {
      const opening = floor.openings.find((o) => o.id === openingId);
      if (!opening) continue;
      if (patch.kind !== undefined) opening.kind = patch.kind;
      if (patch.offsetMm !== undefined) opening.offsetMm = Math.round(patch.offsetMm);
      if (patch.widthMm !== undefined) opening.widthMm = Math.max(1, Math.round(patch.widthMm));
      if (patch.heightMm !== undefined) opening.heightMm = Math.max(1, Math.round(patch.heightMm));
      if (patch.sillMm !== undefined) opening.sillMm = Math.max(0, Math.round(patch.sillMm));
      if (patch.swing !== undefined) opening.swing = { ...patch.swing };
    }
  });
}

/**
 * Change one part of an opening's swing — which end it is hinged at, which side it
 * opens onto, how far it opens.
 *
 * Merged onto the *effective* swing rather than the stored one, so the first edit to
 * an opening that has never had a swing written writes a whole one instead of a
 * fragment. `leafOf` supplies the standard until then, which is why nothing had to be
 * seeded when the opening was created — and why every opening in a file saved before
 * this phase still reads as a door hung the ordinary way.
 */
export function setOpeningSwing(openingId: Id, patch: Partial<Swing>): void {
  const opening = activeFloor(useStore.getState()).openings.find((o) => o.id === openingId);
  if (!opening) return;

  const current: Swing = opening.swing ?? DEFAULT_SWING;
  updateOpening(openingId, {
    swing: {
      hinge: patch.hinge ?? current.hinge,
      into: patch.into ?? current.into,
      angleDeg: clampSwingAngle(patch.angleDeg ?? current.angleDeg),
    },
  });
}

export function renameDocument(title: string): void {
  useStore.getState().mutate('Rename', (draft) => {
    draft.title = title;
  });
}

export function setRoomName(roomId: string, name: string): void {
  useStore.getState().mutate('Rename room', (draft) => {
    for (const floor of draft.floors) {
      const room = floor.rooms.find((r) => r.id === roomId);
      if (room) room.name = name;
    }
  });
}

export function setRoomCeilingHeight(roomId: string, heightMm: number): void {
  useStore.getState().mutate('Ceiling height', (draft) => {
    for (const floor of draft.floors) {
      const room = floor.rooms.find((r) => r.id === roomId);
      if (room) room.ceilingHeightMm = Math.max(1, Math.round(heightMm));
    }
  });
}

/**
 * Derive rooms from the walls that enclose them.
 *
 * One undo step for the whole sweep, and a no-op when nothing changed — `detectRooms`
 * omits rooms whose boundary already matches, so re-running on a settled plan writes
 * no patches at all and `mutate` drops it before it reaches the history stack.
 *
 * Returns what it found so the caller can say so. Unmatched rooms are **left alone**:
 * an Area-tool room has no walls by design, and deleting what detection cannot see
 * would remove a legitimate room on every run.
 */
export function detectFloorRooms(): RoomDetection {
  const { doc } = useStore.getState();
  const floorId = doc.activeFloorId;
  const floor = doc.floors.find((f) => f.id === floorId);
  if (!floor) return { updated: [], added: [], unmatched: [] };

  const result = detectRooms(floor, { makeId: newId });
  if (result.updated.length === 0 && result.added.length === 0) return result;

  withActiveFloor('Detect rooms', (f) => {
    for (const change of result.updated) {
      const room = f.rooms.find((r) => r.id === change.roomId);
      if (!room) continue;
      room.boundary = change.boundary;
      room.areaMm2 = change.areaMm2;
    }
    f.rooms.push(...result.added.map((room) => ({ ...room })));
  });

  return result;
}

/**
 * Commit a wall drag. Called once on release, never during the drag.
 *
 * A click that never moved would otherwise land an undo entry that changes nothing —
 * immer records a patch for an assignment even when the value is deep-equal — so an
 * unchanged wall is skipped here rather than filtered later.
 */
export function commitWallTransform(transform: WallTransform): void {
  const a = { x: Math.round(transform.a.x), y: Math.round(transform.a.y) };
  const b = { x: Math.round(transform.b.x), y: Math.round(transform.b.y) };

  const floor = activeFloor(useStore.getState());
  const existing = floor.walls.find((w) => w.id === transform.wallId);
  if (!existing) return;
  if (existing.a.x === a.x && existing.a.y === a.y && existing.b.x === b.x && existing.b.y === b.y) {
    return;
  }

  const label = transform.end === 'both' ? 'Move wall' : 'Move wall end';
  useStore.getState().mutate(label, (draft) => {
    for (const f of draft.floors) {
      const wall = f.walls.find((w) => w.id === transform.wallId);
      if (wall) {
        wall.a = a;
        wall.b = b;
      }
    }
  });
}

/** The wall geometry a drag currently previews, given the snapped pointer position. */
export function previewWallTransform(transform: WallTransform, at: Vec2): WallTransform {
  if (transform.end === 'both') {
    const dx = at.x - transform.grab.x;
    const dy = at.y - transform.grab.y;
    return {
      ...transform,
      a: { x: transform.origin.a.x + dx, y: transform.origin.a.y + dy },
      b: { x: transform.origin.b.x + dx, y: transform.origin.b.y + dy },
    };
  }
  return { ...transform, [transform.end]: at } as WallTransform;
}

// ---------------------------------------------------------------------------
// Background (PLAN.md §6.1)
// ---------------------------------------------------------------------------

/**
 * Attach an imported floor plan to the active floor.
 *
 * The manifest entries and the background land in one mutation, so an import is one
 * undo step and there is never a document state that references an asset it has not
 * declared. The bytes are already in the runtime asset store by this point; only the
 * manifest is document state.
 *
 * Replacing an existing background drops the old manifest entries but deliberately
 * leaves its bytes in the runtime store, because undo has to be able to bring them
 * back and there is nowhere else they could come from.
 */
export function setBackground(background: Background, assets: readonly AssetRef[]): void {
  const { doc } = useStore.getState();
  const floorId = doc.activeFloorId;
  const previous = doc.floors.find((f) => f.id === floorId)?.background;
  const retired = new Set(
    previous ? [previous.assetId, previous.sourceAssetId].filter((x): x is string => !!x) : [],
  );

  useStore.getState().mutate('Import floor plan', (draft) => {
    draft.assets = draft.assets.filter((a) => !retired.has(a.id));
    for (const ref of assets) {
      if (!draft.assets.some((a) => a.id === ref.id)) draft.assets.push({ ...ref });
    }
    const floor = draft.floors.find((f) => f.id === floorId);
    if (floor) floor.background = background;
  });
}

export function removeBackground(): void {
  const { doc } = useStore.getState();
  const floorId = doc.activeFloorId;
  const bg = doc.floors.find((f) => f.id === floorId)?.background;
  if (!bg) return;

  const retired = new Set([bg.assetId, bg.sourceAssetId].filter((x): x is string => !!x));
  useStore.getState().mutate('Remove floor plan', (draft) => {
    draft.assets = draft.assets.filter((a) => !retired.has(a.id));
    const floor = draft.floors.find((f) => f.id === floorId);
    if (floor) delete floor.background;
  });
}

/**
 * Edit the active floor's background in place. No-op when there is none.
 *
 * The equality check is not redundant with `mutate`'s no-op guard. These recipes
 * assign a whole new object, and immer compares by reference — so setting a property
 * to the value it already holds produces a patch and an undo entry that does
 * nothing. Comparing the result first is what keeps "click Locked twice" out of the
 * history.
 */
function mutateBackground(
  label: string,
  fn: (bg: Background) => Background,
  options?: MutateOptions,
): void {
  const { doc } = useStore.getState();
  const floorId = doc.activeFloorId;
  const current = doc.floors.find((f) => f.id === floorId)?.background;
  if (!current) return;

  const next = fn(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;

  useStore.getState().mutate(
    label,
    (draft) => {
      const floor = draft.floors.find((f) => f.id === floorId);
      if (floor) floor.background = next;
    },
    options,
  );
}

/**
 * Close the calibration gate.
 *
 * The reference line arrives in document millimetres, because that is what the stage
 * produces. It is converted to image pixels here, through the background's *current*
 * transform — provisional on a first calibration, real on a recalibration — which is
 * why `applyCalibration` then rescales about `refA` rather than about the origin.
 *
 * Throws `CalibrationError` with a message meant to be shown; the caller does not
 * need to know why the numbers were unusable.
 */
export function commitCalibration(refDocA: Vec2, refDocB: Vec2, realLengthMm: number): void {
  const floor = activeFloor(useStore.getState());
  const bg = floor.background;
  if (!bg) return;

  // Validate before mutating: `applyCalibration` throws on a line too short to
  // measure, and a failed gate must leave the document untouched.
  const next = applyCalibration(bg, docToImage(bg, refDocA), docToImage(bg, refDocB), realLengthMm);
  mutateBackground('Calibrate floor plan', () => next);
}

/**
 * Opacity, coalesced.
 *
 * A range input fires `change` continuously, so one drag across the slider is
 * hundreds of calls. Without coalescing each is an undo entry, and moving the slider
 * once would push every wall you drew off a 200-deep history.
 */
export function setBackgroundOpacity(opacity: number): void {
  mutateBackground('Background opacity', (bg) => ({ ...bg, opacity: clampOpacity(opacity) }), {
    coalesce: true,
  });
}

export function setBackgroundLocked(locked: boolean): void {
  mutateBackground(locked ? 'Lock floor plan' : 'Unlock floor plan', (bg) => ({ ...bg, locked }));
}

export function moveBackground(position: Vec2): void {
  mutateBackground('Move floor plan', (bg) => ({
    ...bg,
    transform: { ...bg.transform, position },
  }));
}

/** Rotate about the raster centre, so squaring a crooked scan does not fling it away. */
export function nudgeBackgroundRotation(degrees: number): void {
  mutateBackground('Rotate floor plan', (bg) => rotateBackground(bg, degrees, backgroundCentre(bg)));
}

// ---------------------------------------------------------------------------
// Catalog (PLAN.md §4.3, §7)
// ---------------------------------------------------------------------------

/** Add an item to the inventory. Throws `CatalogError` with a message to show. */
export function addCatalogItem(draft: ItemDraft): CatalogItem {
  const item = createCatalogItem(draft, newId());
  useStore.getState().mutate(`Add ${item.name}`, (doc) => {
    doc.catalog.push(item);
  });
  return item;
}

/**
 * Edit an item in place, keeping its id.
 *
 * The id is what placements point at, so a rebuilt item must reuse it — replacing it
 * would orphan every placement of that thing, which is precisely the coupling the
 * catalog/placement split exists to make safe.
 */
export function updateCatalogItem(id: Id, draft: ItemDraft): CatalogItem {
  const item = createCatalogItem(draft, id);
  useStore.getState().mutate(`Edit ${item.name}`, (doc) => {
    const index = doc.catalog.findIndex((i) => i.id === id);
    if (index >= 0) doc.catalog[index] = item;
  });
  return item;
}

/** Remove an item and every placement of it — a placement with no item has no shape. */
export function removeCatalogItem(id: Id): void {
  const { doc } = useStore.getState();
  const item = doc.catalog.find((i) => i.id === id);
  if (!item) return;

  useStore.getState().mutate(`Remove ${item.name}`, (draft) => {
    draft.catalog = draft.catalog.filter((i) => i.id !== id);
    const removed = new Set<Id>();
    for (const floor of draft.floors) {
      for (const p of floor.placements) if (p.itemId === id) removed.add(p.id);
      floor.placements = floor.placements.filter((p) => p.itemId !== id);
      for (const p of floor.placements) {
        if (p.mount.kind === 'surface' && removed.has(p.mount.hostId)) {
          p.mount = { kind: 'floor' };
          p.elevation = 0;
        }
      }
    }
  });

  if (useStore.getState().placingItemId === id) useStore.getState().setPlacingItem(null);
}

export function setQuantityOwned(id: Id, quantity: number): void {
  const next = Math.max(0, Math.round(quantity));
  useStore.getState().mutate('Quantity owned', (draft) => {
    const item = draft.catalog.find((i) => i.id === id);
    if (item) item.quantityOwned = next;
  });
}

// ---------------------------------------------------------------------------
// Placements (PLAN.md §4.2, §9.1)
// ---------------------------------------------------------------------------

/**
 * The snap context for the active floor, minus the placement being dragged.
 *
 * Excluding it matters: an item is always inside its own outline, so a placement left
 * in the host list would surface-mount to itself the moment it moved.
 */
export function placementSnapContext(
  itemId: Id,
  options: { excludePlacementId?: Id; toleranceMm: number },
): PlacementSnapContext | null {
  const state = useStore.getState();
  const floor = activeFloor(state);
  const item = findItem(state.doc, itemId);
  if (!item) return null;

  const hosts = floor.placements
    .filter((p) => p.id !== options.excludePlacementId)
    .flatMap((p) => {
      const hostItem = findItem(state.doc, p.itemId);
      if (!hostItem) return [];
      return [
        { id: p.id, outline: worldOutline(p, hostItem), canHostSurface: hostItem.canHostSurface },
      ];
    });

  return {
    walls: floor.walls,
    hosts,
    footprint: item.footprint,
    gridMm: state.doc.gridMm,
    gridEnabled: state.gridEnabled,
    toleranceMm: options.toleranceMm,
    suppressed: state.snapSuppressed,
  };
}

/**
 * How high a wall-mounted item hangs when nothing more specific is known.
 *
 * Roughly the centre of a TV or the middle shelf of a run — high enough to read as
 * mounted rather than as sitting on the floor, and always editable in the panel.
 */
export const DEFAULT_WALL_MOUNT_MM = 1200;

/** How near a wall an item has to land for "wall-mounted" to mean anything. */
export const WALL_MOUNT_REACH_MM = 900;

/**
 * The mount an item lands on, honouring the default recorded on the catalog item.
 *
 * A wall mount with no wall within reach falls back to the floor and **says so** —
 * returning a reason rather than quietly storing a `wallId` it guessed. An item
 * attached to a wall the user did not choose is worse than one on the floor, because
 * moving that wall would then move the item.
 */
export function resolveDropMount(
  floor: ReturnType<typeof activeFloor>,
  item: CatalogItem,
  position: Vec2,
): { mount: Mount; elevation: number; notice: string | null } {
  switch (item.defaultMount) {
    case 'wall': {
      const wall = nearestWall(floor.walls, position, WALL_MOUNT_REACH_MM);
      if (!wall) {
        return {
          mount: { kind: 'floor' },
          elevation: 0,
          notice: `${item.name} is wall-mounted, but there is no wall here. It is on the floor — drop it against a wall, or set the mount in the panel.`,
        };
      }
      return {
        mount: { kind: 'wall', wallId: wall.id },
        elevation: DEFAULT_WALL_MOUNT_MM,
        notice: null,
      };
    }
    case 'ceiling':
      // Flush to the ceiling; the drop is the number the user then adjusts.
      return { mount: { kind: 'ceiling', drop: 0 }, elevation: 0, notice: null };
    default:
      return { mount: { kind: 'floor' }, elevation: 0, notice: null };
  }
}

/**
 * Change what a placement is attached to.
 *
 * Returns a reason when the mount could not be applied, for the panel to show.
 * Surface mounts are not settable here: a surface mount needs a specific host, which
 * is chosen by dragging the item onto it, not by picking a word from a list.
 */
export function setPlacementMount(placementId: Id, kind: Mount['kind']): string | null {
  const state = useStore.getState();
  const floor = activeFloor(state);
  const placement = floor.placements.find((p) => p.id === placementId);
  if (!placement) return null;

  let mount: Mount;
  let elevation = 0;

  if (kind === 'wall') {
    const wall = nearestWall(floor.walls, placement.position, WALL_MOUNT_REACH_MM);
    if (!wall) return 'There is no wall near enough to mount this on. Move it against one first.';
    mount = { kind: 'wall', wallId: wall.id };
    elevation = placement.elevation || DEFAULT_WALL_MOUNT_MM;
  } else if (kind === 'ceiling') {
    mount = { kind: 'ceiling', drop: 0 };
  } else if (kind === 'surface') {
    return 'Drag this onto the thing you want it to sit on.';
  } else {
    mount = { kind: 'floor' };
  }

  useStore.getState().mutate('Change mount', (draft) => {
    for (const f of draft.floors) {
      const target = f.placements.find((p) => p.id === placementId);
      if (!target) continue;
      target.mount = mount;
      target.elevation = elevation;
    }
  });
  return null;
}

/** How far a ceiling-mounted item hangs below the ceiling. */
export function setCeilingDrop(placementId: Id, dropMm: number): void {
  const next = Math.max(0, Math.round(dropMm));
  useStore.getState().mutate('Drop', (draft) => {
    for (const floor of draft.floors) {
      const placement = floor.placements.find((p) => p.id === placementId);
      if (placement?.mount.kind === 'ceiling') placement.mount = { kind: 'ceiling', drop: next };
    }
  });
}

// ---------------------------------------------------------------------------
// Saved views (PLAN.md 10.3)
// ---------------------------------------------------------------------------

/** Bookmark a camera. Document state — a bookmark travels with the file. */
export function addSavedView(name: string, camera: SpaceCamera): void {
  const { doc } = useStore.getState();
  const view = createSavedView(
    newId(),
    uniqueViewName(name.trim() || 'View', doc.savedViews),
    camera,
  );
  useStore.getState().mutate(`Save view ${view.name}`, (draft) => {
    draft.savedViews.push(view);
  });
}

export function removeSavedView(id: Id): void {
  useStore.getState().mutate('Remove view', (draft) => {
    draft.savedViews = draft.savedViews.filter((v) => v.id !== id);
  });
}

/**
 * Drop an item onto the plan.
 *
 * **This is where the calibration gate stops being decorative.** A floor whose plan
 * has no scale refuses, with the same sentence the validation panel shows, because
 * anything placed on an unscaled raster is placed at a size that means nothing.
 *
 * An item whose catalog entry says it is wall- or ceiling-mounted lands mounted, not
 * on the floor — `resolveDropMount` decides, and reports when it could not.
 */
export function addPlacement(
  itemId: Id,
  position: Vec2,
  options: { rotation?: number; mount?: Placement['mount'] } = {},
): Placement | null {
  const state = useStore.getState();
  const floor = activeFloor(state);
  assertAcceptsPlacements(floor);

  const item = findItem(state.doc, itemId);
  if (!item) return null;

  // An explicit mount wins over the item's own default: it means the gesture found
  // something specific — a surface to stand on — and that beats a preference recorded
  // when the item was created. Callers must not pass a floor mount just because they
  // have one to hand; absent means "use the item's default".
  const resolved = options.mount
    ? { mount: options.mount, elevation: 0, notice: null }
    : resolveDropMount(floor, item, position);
  useStore.getState().setNotice(resolved.notice);

  const placement: Placement = {
    id: newId(),
    itemId,
    floorId: floor.id,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    // Normalized on the way in: a wall snap solves an angle with atan2, which happily
    // returns -90, and nobody wants to read that in the properties panel.
    rotation: normalizeRotation(options.rotation ?? 0),
    mount: resolved.mount,
    elevation: resolved.elevation,
  };

  const floorId = floor.id;
  useStore.getState().mutate(`Place ${item.name}`, (draft) => {
    const target = draft.floors.find((f) => f.id === floorId);
    if (target) target.placements.push(placement);
  });
  return placement;
}

/** The geometry a placement drag currently previews, given the raw pointer position. */
export function previewPlacementTransform(
  transform: PlacementTransform,
  at: Vec2,
  ctx: PlacementSnapContext | null,
): PlacementTransform {
  if (transform.mode === 'rotate') {
    const dx = at.x - transform.origin.position.x;
    const dy = at.y - transform.origin.position.y;
    // The handle sticks out of the item's back, so a pointer directly above the
    // centre reads as rotation 0 — the same convention wall snap uses.
    const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const rotation = snapRotation(degrees, ctx?.suppressed ?? false);
    return { ...transform, rotation, hints: [] };
  }

  const raw = {
    x: transform.origin.position.x + (at.x - transform.grab.x),
    y: transform.origin.position.y + (at.y - transform.grab.y),
  };
  if (!ctx) return { ...transform, position: raw, hints: [] };

  const snapped = snapPlacement(raw, transform.rotation, ctx);
  return {
    ...transform,
    position: snapped.position,
    rotation: snapped.rotation,
    mount: draggedMount(transform.origin.mount, snapped.mount),
    hints: snapped.hints,
  };
}

/**
 * What a placement is attached to after being dragged.
 *
 * The snap only ever reports two things: a *surface* mount when the item landed on
 * something that can host it, and a floor mount otherwise. A floor mount from the
 * snap therefore means "no host here", **not** "put this on the floor" — a wall snap
 * seats the footprint against the wall and still reports floor. Letting it through
 * would drop a wall-mounted TV to the ground the moment it was nudged 5mm along its
 * own wall, silently, which is the same shadowing bug the drop path had.
 *
 * So: a host wins; otherwise a *surface* mount that found no host has genuinely been
 * dragged off its host and falls to the floor; and a wall or ceiling mount is left
 * alone, because moving a thing is not the same as detaching it.
 */
function draggedMount(origin: Mount, snapped: Mount): Mount {
  if (snapped.kind === 'surface') return snapped;
  if (origin.kind === 'surface') return { kind: 'floor' };
  return origin;
}

/**
 * Commit a placement drag. Called once on release, never during it.
 *
 * A press that never moved records nothing: immer patches an assignment even when the
 * value is deep-equal, so an unchanged placement is skipped here rather than filtered
 * out of the history later.
 */
export function commitPlacementTransform(transform: PlacementTransform): void {
  const position = { x: Math.round(transform.position.x), y: Math.round(transform.position.y) };
  const state = useStore.getState();
  const floor = activeFloor(state);
  const existing = floor.placements.find((p) => p.id === transform.placementId);
  if (!existing) return;

  const sameMount =
    existing.mount.kind === transform.mount.kind &&
    (existing.mount.kind !== 'surface' ||
      (transform.mount.kind === 'surface' && existing.mount.hostId === transform.mount.hostId));

  if (
    existing.position.x === position.x &&
    existing.position.y === position.y &&
    existing.rotation === normalizeRotation(transform.rotation) &&
    sameMount
  ) {
    return;
  }

  const label = transform.mode === 'rotate' ? 'Rotate item' : 'Move item';
  useStore.getState().mutate(label, (draft) => {
    for (const f of draft.floors) {
      const placement = f.placements.find((p) => p.id === transform.placementId);
      if (!placement) continue;
      placement.position = position;
      placement.rotation = normalizeRotation(transform.rotation);
      placement.mount = transform.mount;
      // Elevation is derived for surface mounts, so the stored value is only
      // meaningful on the floor and on a wall — and on the floor it is zero.
      if (transform.mount.kind !== 'wall') placement.elevation = 0;
    }
  });
}

/** Keep rotation in [0, 360) so the properties panel never shows −450°. */
function normalizeRotation(degrees: number): number {
  const d = degrees % 360;
  return d < 0 ? d + 360 : d;
}

export function rotatePlacementBy(placementId: Id, degrees: number): void {
  useStore.getState().mutate('Rotate item', (draft) => {
    for (const floor of draft.floors) {
      const placement = floor.placements.find((p) => p.id === placementId);
      if (placement) placement.rotation = normalizeRotation(placement.rotation + degrees);
    }
  });
}

export function setPlacementElevation(placementId: Id, elevationMm: number): void {
  const next = Math.max(0, Math.round(elevationMm));
  useStore.getState().mutate('Elevation', (draft) => {
    for (const floor of draft.floors) {
      const placement = floor.placements.find((p) => p.id === placementId);
      if (placement) placement.elevation = next;
    }
  });
}
