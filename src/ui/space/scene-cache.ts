import type { Floor, SpaceDocument } from '../../core/document';
import { blockersOf, buildScene, type SceneModel } from '../../core/scene';
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

export function blockersFor(doc: SpaceDocument, floor: Floor): Volume[] {
  const scene = sceneFor(doc, floor);
  cachedBlockers ??= blockersOf(scene);
  return cachedBlockers;
}
