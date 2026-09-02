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
import { nearestWall, projectOntoWall } from '../core/geometry/wall';
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
    }
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
 * Drop an item onto the plan.
 *
 * **This is where the calibration gate stops being decorative.** A floor whose plan
 * has no scale refuses, with the same sentence the validation panel shows, because
 * anything placed on an unscaled raster is placed at a size that means nothing.
 *
 * Wall and ceiling mounts are not reachable from here yet — they need a wall to host
 * against and a ceiling to hang from, which is phase 5. A wall-mounted item dropped
 * on the plan lands on the floor and can be raised there.
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

  const placement: Placement = {
    id: newId(),
    itemId,
    floorId: floor.id,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    // Normalized on the way in: a wall snap solves an angle with atan2, which happily
    // returns -90, and nobody wants to read that in the properties panel.
    rotation: normalizeRotation(options.rotation ?? 0),
    mount: options.mount ?? { kind: 'floor' },
    elevation: 0,
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
    mount: snapped.mount,
    hints: snapped.hints,
  };
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
