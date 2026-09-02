/**
 * Document actions — every write to the document goes through one of these.
 *
 * Each is a single `mutate` call, so each is a single undo step. Keeping them here
 * rather than inside components means a wall chain committed from the Konva stage and
 * one committed from a test take exactly the same path.
 */

import type { Room, Wall } from '../core/document';
import { commitRoomRect, commitShapeRoom, commitWallChain, type ShapeKind } from '../core/tools';
import type { Vec2 } from '../core/geometry/vec';
import { activeFloor, useStore, type SelectionRef, type WallTransform } from './store';

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
 * Openings hosted on a deleted wall go with it — an opening with a dangling `wallId`
 * has no position, no host to cut and nothing that could render it.
 */
export function deleteSelection(selection: readonly SelectionRef[]): void {
  if (selection.length === 0) return;

  const wallIds = new Set(selection.filter((s) => s.kind === 'wall').map((s) => s.id));
  const roomIds = new Set(selection.filter((s) => s.kind === 'room').map((s) => s.id));
  const placementIds = new Set(selection.filter((s) => s.kind === 'placement').map((s) => s.id));

  const label = selection.length === 1 ? `Delete ${selection[0]!.kind}` : `Delete ${selection.length} items`;

  useStore.getState().mutate(label, (draft) => {
    for (const floor of draft.floors) {
      floor.walls = floor.walls.filter((w) => !wallIds.has(w.id));
      floor.openings = floor.openings.filter((o) => !wallIds.has(o.wallId));
      floor.rooms = floor.rooms.filter((r) => !roomIds.has(r.id));
      floor.placements = floor.placements.filter((p) => !placementIds.has(p.id));
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
