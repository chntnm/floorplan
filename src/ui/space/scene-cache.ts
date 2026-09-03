import type { Floor, SpaceDocument } from '../../core/document';
import { blockersOf, buildScene, buildStack, type SceneModel } from '../../core/scene';
import { visibleFloors, type FloorVisibility } from '../../core/floors';
import type { Volume } from '../../core/geometry/collision';

/**
 * One built scene per document version.
 *
 * The walk loop needs collision geometry sixty times a second, and rebuilding every
 * wall segment and placement outline each frame is the difference between a target of
 * 500 placements and a slideshow. The cache lives here rather than in `core/scene.ts`
 * because a module-level mutable cache is not something a pure geometry module should
 * own — and because the correctness argument depends on the *store*: zustand replaces
 * `doc` with a new object on every mutation, so reference equality is an exact test
 * for "has anything changed".
 *
 * Deliberately one entry deep. Two documents are never live at once, and a growing
 * cache would pin every intermediate document version an undo stack has produced.
 */
let cachedDoc: SpaceDocument | null = null;
let cachedFloorId: string | null = null;
let cachedScene: SceneModel | null = null;
let cachedBlockers: Volume[] | null = null;

export function sceneFor(doc: SpaceDocument, floor: Floor): SceneModel {
  if (cachedDoc === doc && cachedFloorId === floor.id && cachedScene) return cachedScene;

  cachedScene = buildScene(doc, floor);
  cachedBlockers = null;
  cachedDoc = doc;
  cachedFloorId = floor.id;
  return cachedScene;
}

let cachedStackDoc: SpaceDocument | null = null;
let cachedStackKey: string | null = null;
let cachedStack: SceneModel | null = null;

/**
 * The stacked scene the space view draws.
 *
 * Kept apart from `sceneFor` rather than replacing it, because the walker must keep
 * being fed the **active floor alone**: collision that followed a display setting
 * would have you walking into walls you had only chosen to look at. Two consumers,
 * two scenes, and `blockersFor` is untouched.
 */
export function stackFor(doc: SpaceDocument, visibility: FloorVisibility): SceneModel {
  const key = visibility + ':' + doc.activeFloorId;
  if (cachedStackDoc === doc && cachedStackKey === key && cachedStack) return cachedStack;

  cachedStack = buildStack(doc, visibleFloors(doc, visibility), doc.activeFloorId);
  cachedStackDoc = doc;
  cachedStackKey = key;
  return cachedStack;
}

export function blockersFor(doc: SpaceDocument, floor: Floor): Volume[] {
  const scene = sceneFor(doc, floor);
  cachedBlockers ??= blockersOf(scene);
  return cachedBlockers;
}
