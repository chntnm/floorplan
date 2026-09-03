/**
 * Saved views. See PLAN.md §10.3.
 *
 * `SavedView.camera` is typed `Record<string, number>` in the document, which is
 * flexible enough to hold any camera and loose enough that a future version could
 * write a shape this one cannot read. So the key set is pinned here, in one place,
 * with an explicit encode and a **total** decode: every field has a defined fallback,
 * and an unrecognised or truncated record produces a usable camera rather than a
 * `NaN` that propagates silently into a matrix and blanks the screen.
 *
 * Camera mode travels as an index into `CAMERA_MODES` because the field is numeric.
 * That is the one place the encoding is not self-describing, which is why the decode
 * clamps it rather than indexing blindly.
 */

import type { Id, SavedView } from './document';
import type { DocPoint3 } from './units';
import { CAMERA_MODES, type CameraMode } from './walk';

/** A camera pose in document millimetres, Z-up — the same space as everything else. */
export type SpaceCamera = {
  position: DocPoint3;
  target: DocPoint3;
  mode: CameraMode;
};

export const DEFAULT_CAMERA: SpaceCamera = {
  position: { x: 0, y: 0, z: 1650 },
  target: { x: 0, y: -1000, z: 1650 },
  mode: 'orbit',
};

export function encodeCamera(camera: SpaceCamera): Record<string, number> {
  return {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    tx: camera.target.x,
    ty: camera.target.y,
    tz: camera.target.z,
    m: CAMERA_MODES.indexOf(camera.mode),
  };
}

/** A finite number from the record, or the fallback. Rejects `NaN` and `Infinity`. */
function num(record: Record<string, number>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function decodeCamera(record: Record<string, number>): SpaceCamera {
  const position = {
    x: num(record, 'x', DEFAULT_CAMERA.position.x),
    y: num(record, 'y', DEFAULT_CAMERA.position.y),
    z: num(record, 'z', DEFAULT_CAMERA.position.z),
  };
  const target = {
    x: num(record, 'tx', DEFAULT_CAMERA.target.x),
    y: num(record, 'ty', DEFAULT_CAMERA.target.y),
    z: num(record, 'tz', DEFAULT_CAMERA.target.z),
  };
  const index = Math.round(num(record, 'm', 0));
  const mode = CAMERA_MODES[index] ?? DEFAULT_CAMERA.mode;

  // A camera whose target is its own position has no direction and produces a
  // degenerate view matrix. Nudge it rather than handing three.js a zero vector.
  if (position.x === target.x && position.y === target.y && position.z === target.z) {
    target.y -= 1000;
  }
  return { position, target, mode };
}

export function createSavedView(id: Id, name: string, camera: SpaceCamera): SavedView {
  return { id, name, mode: 'space3d', camera: encodeCamera(camera) };
}

/** Space views only — a plan bookmark is a different feature and does not exist yet. */
export function spaceViews(views: readonly SavedView[]): SavedView[] {
  return views.filter((v) => v.mode === 'space3d');
}

/**
 * A name that is not already taken, so two bookmarks are never ambiguous in the list.
 *
 * Suffixes rather than refuses: the point of the button is that pressing it saves
 * where you are standing, and stopping to argue about a name defeats it.
 */
export function uniqueViewName(base: string, existing: readonly SavedView[]): string {
  const taken = new Set(existing.map((v) => v.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
