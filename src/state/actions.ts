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
import { activeFloor, useStore, type SelectionRef } from './store';

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

/** Move a wall endpoint. Called once on drag release, never during the drag. */
export function moveWallEndpoint(wallId: string, end: 'a' | 'b', to: Vec2): void {
  const rounded = { x: Math.round(to.x), y: Math.round(to.y) };
  useStore.getState().mutate('Move wall end', (draft) => {
    for (const floor of draft.floors) {
      const wall = floor.walls.find((w) => w.id === wallId);
      if (wall) wall[end] = rounded;
    }
  });
}
