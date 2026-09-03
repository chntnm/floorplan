/**
 * Application state. See PLAN.md §8.
 *
 * Two slices, and the split is the whole design:
 *
 *   **document** — the `SpaceDocument`, and nothing else. Every change goes through
 *   `mutate`, which records an immer patch pair. This is what undo walks.
 *
 *   **editor** — tool, draft, cursor, hover, selection, viewport, modes. Records
 *   nothing and is not undoable.
 *
 * A drag lives entirely in the editor slice and touches the document exactly once, on
 * release. Without that split a three-segment wall chain would leave several hundred
 * mousemove-sized entries on the undo stack and Ctrl+Z would do nothing visible.
 *
 * Mode switches are deliberately not undoable either (PLAN.md §8) — undo restores
 * what you drew, not where you were looking.
 */

import { create } from 'zustand';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import {
  DEFAULT_GRID_MM,
  createDocument,
  findFloor,
  type Floor,
  type Id,
  type SpaceDocument,
} from '../core/document';
import { DEFAULT_VIEWPORT, fitBounds, type Size, type Viewport } from '../core/viewport';
import { DEFAULT_ANGLE_STEP_DEG, type SnapHint } from '../core/snapping';
import {
  DEFAULT_WALL_DEFAULTS,
  type Draft,
  type PlanTool,
  type ShapeKind,
  type WallDefaults,
} from '../core/tools';
import type { EditMode, ViewMode } from '../core/modes';
import type { FloorVisibility } from '../core/floors';
import { bounds, type Bounds } from '../core/geometry/polygon';
import { wallOutline } from '../core/geometry/wall';
import type { Vec2 } from '../core/geometry/vec';
import type { Mount, OpeningKind, SavedView } from '../core/document';
import type { CameraMode, Walker } from '../core/walk';
import { decodeCamera, type SpaceCamera } from '../core/views';
import { toDegrees } from '../core/geometry/vec';
import type { PlacementSnapHint } from '../core/placement-snap';
import type { AssetMap } from '../core/space-file';
import type { Inspection } from '../core/media';
import { adoptAssets, clearAssets } from './assets';
import { clearSaveTarget } from './save-target';

// immer 10 gates patch recording behind this plugin. Without it `produceWithPatches`
// throws at runtime — which neither typecheck nor lint can see.
enablePatches();

export type SelectionKind = 'wall' | 'room' | 'opening' | 'placement';
export type SelectionRef = { kind: SelectionKind; id: Id };

export type MutateOptions = {
  /**
   * Fold this change into the previous entry when that entry has the same label.
   *
   * For continuous controls — an opacity slider fires `change` on every pixel of the
   * drag — where the alternative is a hundred history entries for one edit, and a
   * 200-deep stack erased by moving a slider once.
   *
   * Only safe for recipes that write an **absolute** value at a fixed path, which is
   * what makes replaying the newest patches over the oldest inverse correct. Do not
   * set it on anything that splices an array.
   */
  coalesce?: boolean;
  /**
   * Write the document without recording history.
   *
   * For a document field that records *where you are*, not what the space is —
   * `activeFloorId` is the only one. Undo has to walk back the edits you made; having
   * it teleport you between storeys instead would make the stack unusable. The change
   * still marks the document dirty, because it still has to be saved: reopening a
   * three-storey house on the floor you left it is the whole reason the field is in
   * the document rather than in the editor.
   *
   * Only safe for an **absolute write at a fixed path**, the same constraint
   * `coalesce` carries, and for the same reason: the patches already on the stack are
   * replayed against whatever the document is now, so a silent write that spliced an
   * array would leave every one of them pointing at the wrong index.
   */
  silent?: boolean;
};

export type HistoryEntry = {
  label: string;
  patches: Patch[];
  inverse: Patch[];
};

/** Deep enough to cover a working session; bounded so a long one cannot grow forever. */
export const HISTORY_LIMIT = 200;

export type Measurement = { from: { x: number; y: number }; to: { x: number; y: number } };

/**
 * The reference line drawn during the calibration gate, in **document mm**.
 *
 * Document rather than image pixels because that is what the stage produces and what
 * the draft layer draws; it is converted to image pixels once, at commit, through
 * the background's current (provisional) transform. Keeping it here rather than in
 * the document means an abandoned calibration leaves no undo entry behind.
 */
export type CalibrationRef = { a: Vec2; b: Vec2 };

/**
 * A placement being dragged or turned, held as preview state in the editor slice.
 *
 * Exactly the same shape of solution as `WallTransform`, and for the same reason: the
 * document keeps the original until the pointer is released, so a drag across the
 * whole plan is one undo step rather than four hundred. `origin` makes a move
 * absolute — deriving each frame from the last accumulates the error the snap keeps
 * correcting.
 */
export type PlacementTransform = {
  placementId: Id;
  mode: 'move' | 'rotate';
  /** Where the drag started, in document mm. */
  grab: Vec2;
  /**
   * The placement as it was when the drag began.
   *
   * `mount` is part of it because the snap reports a *floor* mount for anything that
   * is not a surface-host match — a wall snap seats the footprint against the wall
   * but never claims a wall mount. Without the original to fall back on, nudging a
   * wall-mounted TV along its own wall would drop it to the floor.
   */
  origin: { position: Vec2; rotation: number; mount: Mount };
  position: Vec2;
  rotation: number;
  mount: Mount;
  hints: PlacementSnapHint[];
};

/**
 * A wall being dragged, held as preview geometry in the editor slice.
 *
 * The document keeps the original until the pointer is released, so a drag across the
 * whole plan is still one undo step. `end` is which handle is moving; `'both'` is a
 * body move.
 */
export type WallTransform = {
  wallId: Id;
  end: 'a' | 'b' | 'both';
  /** Where the drag started, in document mm — the reference for a body move. */
  grab: { x: number; y: number };
  /** The wall as it was when the drag began, so a body move is always absolute. */
  origin: { a: { x: number; y: number }; b: { x: number; y: number } };
  a: { x: number; y: number };
  b: { x: number; y: number };
};

/** Extra instruction for `loadDocument`. */
export type LoadOptions = {
  /**
   * Whether the loaded document counts as having unsaved changes.
   *
   * False for a file that was just opened — it is on disk exactly as it is in memory.
   * True for a recovered autosave, which by definition was never written anywhere the
   * user can find it; marking it clean would let them close the tab a second time on
   * the same unsaved work.
   */
  dirty?: boolean;
};

export type StoreState = {
  // -- document slice ------------------------------------------------------
  doc: SpaceDocument;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** True once the document has changed since it was created, loaded or saved. */
  dirty: boolean;

  mutate: (label: string, recipe: (draft: SpaceDocument) => void, options?: MutateOptions) => void;
  undo: () => void;
  redo: () => void;
  loadDocument: (doc: SpaceDocument, assets?: AssetMap, options?: LoadOptions) => void;
  newDocument: () => void;
  markSaved: () => void;

  // -- editor slice --------------------------------------------------------
  editMode: EditMode;
  viewMode: ViewMode;
  tool: PlanTool;
  shapeKind: ShapeKind;
  /** Which kind of opening the opening tool drops. */
  openingKind: OpeningKind;
  viewport: Viewport;
  stageSize: Size;
  selection: SelectionRef[];
  draft: Draft | null;
  /**
   * A multi-page PDF waiting for its page to be chosen.
   *
   * Editor state: it is a half-finished gesture, like a draft wall chain, and it
   * carries the file's bytes — which have no business on the undo stack.
   */
  pendingImport: Inspection | null;
  /** Snapped cursor position in document mm, or null when the pointer is outside. */
  cursor: { x: number; y: number } | null;
  snapHints: SnapHint[];
  gridEnabled: boolean;
  angleStepDeg: number;
  /** Alt held — suppresses snapping for as long as it is down. */
  snapSuppressed: boolean;
  wallDefaults: WallDefaults;
  /** The last completed measurement, held until the next one or a tool change. */
  measurement: Measurement | null;
  /**
   * The walkway probe's path, in document mm.
   *
   * Editor state, not document state, for the same reason a measurement is: it is a
   * *question* asked of the plan, not a part of it. Storing the path rather than the
   * answer means moving a chair re-answers it, because the narrowest gap is derived
   * from the document every time it is read.
   */
  walkway: Vec2[] | null;
  /** The wall drag in flight, if any. */
  transform: WallTransform | null;
  /**
   * True while the calibration gate is open (PLAN.md §6.1).
   *
   * Blocking: the tools and the mode switches are unavailable until the background
   * has a scale, because tracing an uncalibrated plan produces walls whose lengths
   * mean nothing and which nothing later can correct.
   */
  calibrating: boolean;
  /** The reference line being drawn, or the finished one awaiting its real length. */
  calibrationRef: CalibrationRef | null;
  /** The placement drag in flight, if any. */
  placementTransform: PlacementTransform | null;

  // -- space view (PLAN.md §10) --------------------------------------------
  cameraMode: CameraMode;
  /**
   * The walker, or null before they have been put anywhere.
   *
   * Null rather than an origin default: a plan traced from an imported raster can sit
   * anywhere, so a walker at 0,0 would routinely start outside the building. The view
   * seeds this from `defaultStandpoint` the first time it is needed.
   *
   * Editor state, not document state. Where you are standing is not something undo
   * should take away, and a walk across a room would otherwise be several hundred
   * history entries.
   */
  walker: Walker | null;
  /** Ceilings hide by default — a dollhouse you cannot see into is not useful. */
  showCeilings: boolean;
  /** Which floors the space view draws. Display only — collision is always the active floor. */
  floorVisibility: FloorVisibility;
  /**
   * A camera pose the 3D view should jump to, consumed once and cleared.
   *
   * Orbit controls own their own camera state internally, so "go here" cannot be
   * expressed by setting a value and leaving it — the next drag would fight it. A
   * one-shot instruction the renderer picks up and clears says exactly what is meant.
   */
  pendingCamera: SpaceCamera | null;
  /** A transient one-line message, shown until the next action replaces it. */
  notice: string | null;
  /**
   * The catalog item armed for placing — the next click on the plan drops one.
   *
   * Held rather than entered as a tool because the gesture starts in the inventory
   * list: you pick the thing you want, then you point at where it goes.
   */
  placingItemId: Id | null;

  setEditMode: (mode: EditMode) => void;
  setViewMode: (mode: ViewMode) => void;
  setTool: (tool: PlanTool) => void;
  setShapeKind: (kind: ShapeKind) => void;
  setOpeningKind: (kind: OpeningKind) => void;
  setViewport: (viewport: Viewport) => void;
  setStageSize: (size: Size) => void;
  setSelection: (selection: SelectionRef[]) => void;
  toggleSelection: (ref: SelectionRef) => void;
  clearSelection: () => void;
  setDraft: (draft: Draft | null) => void;
  setCursor: (cursor: { x: number; y: number } | null, hints?: SnapHint[]) => void;
  setGridEnabled: (on: boolean) => void;
  setSnapSuppressed: (on: boolean) => void;
  setMeasurement: (m: Measurement | null) => void;
  setWalkway: (path: Vec2[] | null) => void;
  setTransform: (t: WallTransform | null) => void;
  setPlacementTransform: (t: PlacementTransform | null) => void;
  setPlacingItem: (itemId: Id | null) => void;
  setCameraMode: (mode: CameraMode) => void;
  setWalker: (walker: Walker | null) => void;
  setShowCeilings: (on: boolean) => void;
  setFloorVisibility: (visibility: FloorVisibility) => void;
  setActiveFloor: (floorId: Id) => void;
  clearFloorScopedState: () => void;
  setPendingCamera: (camera: SpaceCamera | null) => void;
  setNotice: (notice: string | null) => void;
  setPendingImport: (inspection: Inspection | null) => void;
  applySavedView: (view: SavedView) => void;
  beginCalibration: () => void;
  setCalibrationRef: (ref: CalibrationRef | null) => void;
  endCalibration: () => void;
  zoomToFit: () => void;
};

function freshDocument(): SpaceDocument {
  return createDocument({ id: crypto.randomUUID(), floorId: crypto.randomUUID() });
}

/** The floor everything in the 2D editor is currently addressing. */
export function activeFloor(state: Pick<StoreState, 'doc'>): Floor {
  const floor = findFloor(state.doc, state.doc.activeFloorId);
  // The document model guarantees at least one floor and an id that resolves; if that
  // ever fails, falling back beats rendering nothing with no explanation.
  return floor ?? state.doc.floors[0]!;
}

/** Drop selection entries whose entity no longer exists — after undo, or a delete. */
function pruneSelection(doc: SpaceDocument, selection: SelectionRef[]): SelectionRef[] {
  const live = new Set<string>();
  for (const floor of doc.floors) {
    for (const w of floor.walls) live.add(`wall:${w.id}`);
    for (const r of floor.rooms) live.add(`room:${r.id}`);
    for (const o of floor.openings) live.add(`opening:${o.id}`);
    for (const p of floor.placements) live.add(`placement:${p.id}`);
  }
  const kept = selection.filter((s) => live.has(`${s.kind}:${s.id}`));
  return kept.length === selection.length ? selection : kept;
}

/** The extent of everything drawn on a floor, or null when it is empty. */
export function floorBounds(floor: Floor): Bounds | null {
  const boxes: Bounds[] = [];
  for (const room of floor.rooms) boxes.push(bounds(room.boundary));
  for (const wall of floor.walls) {
    try {
      boxes.push(bounds(wallOutline(wall)));
    } catch {
      // A degenerate wall contributes no extent; it should not stop the fit.
    }
  }
  if (boxes.length === 0) return null;

  return boxes.reduce((acc, b) => ({
    minX: Math.min(acc.minX, b.minX),
    minY: Math.min(acc.minY, b.minY),
    maxX: Math.max(acc.maxX, b.maxX),
    maxY: Math.max(acc.maxY, b.maxY),
  }));
}

export const useStore = create<StoreState>((set, get) => ({
  // -- document ------------------------------------------------------------
  doc: freshDocument(),
  past: [],
  future: [],
  dirty: false,

  mutate: (label, recipe, options) => {
    const state = get();
    const [next, patches, inverse] = produceWithPatches(state.doc, (draft) => {
      recipe(draft);
      draft.modifiedAt = new Date().toISOString();
    });

    // The timestamp always changes, so it cannot be the test for "did anything
    // happen" — a recipe that turned out to be a no-op must not land on the stack.
    if (patches.every((p) => p.path[0] === 'modifiedAt')) return;

    if (options?.silent) {
      set({ doc: next, dirty: true, selection: pruneSelection(next, state.selection) });
      return;
    }

    const previous = state.past[state.past.length - 1];
    // Keep the older entry's inverse: undo has to reach the state before the whole
    // gesture, not before its last frame.
    const past =
      options?.coalesce && previous?.label === label
        ? [
            ...state.past.slice(0, -1),
            { label, patches: [...patches], inverse: previous.inverse },
          ]
        : [...state.past, { label, patches: [...patches], inverse: [...inverse] }];
    set({
      doc: next,
      past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
      future: [],
      dirty: true,
      selection: pruneSelection(next, state.selection),
    });
  },

  undo: () => {
    const { doc, past, future, selection } = get();
    const entry = past[past.length - 1];
    if (!entry) return;

    const next = applyPatches(doc, entry.inverse);
    set({
      doc: next,
      past: past.slice(0, -1),
      future: [entry, ...future],
      dirty: true,
      selection: pruneSelection(next, selection),
      draft: null,
      transform: null,
      placementTransform: null,
      // The notice describes what the last action did; undoing it leaves a sentence
      // about something that no longer happened.
      notice: null,
      pendingImport: null,
    });
  },

  redo: () => {
    const { doc, past, future, selection } = get();
    const entry = future[0];
    if (!entry) return;

    const next = applyPatches(doc, entry.patches);
    set({
      doc: next,
      past: [...past, entry],
      future: future.slice(1),
      dirty: true,
      selection: pruneSelection(next, selection),
      draft: null,
      transform: null,
      notice: null,
      pendingImport: null,
    });
  },

  // The asset store and the save target are the other halves of the open document
  // (see `state/assets.ts`, `state/save-target.ts`), so replacing one replaces all
  // three. Stale bytes would mean the next save wrote a file carrying the previous
  // document's background; a stale handle would write it into the previous
  // document's *file*, which has no warning and no undo.
  loadDocument: (doc, assets, options) => {
    if (assets) adoptAssets(doc, assets);
    else clearAssets();
    clearSaveTarget();
    set({
      doc,
      past: [],
      future: [],
      // A recovered autosave has never been written to a file, so it arrives dirty.
      // Loading a `.space` does not: that file is on disk and matches what is open.
      dirty: options?.dirty ?? false,
      selection: [],
      draft: null,
      transform: null,
      measurement: null,
      walkway: null,
      cursor: null,
      snapHints: [],
      calibrating: false,
      calibrationRef: null,
      placementTransform: null,
      placingItemId: null,
      walker: null,
      pendingCamera: null,
      notice: null,
      pendingImport: null,
    });
  },

  newDocument: () => {
    clearAssets();
    clearSaveTarget();
    set({
      doc: freshDocument(),
      past: [],
      future: [],
      dirty: false,
      selection: [],
      draft: null,
      transform: null,
      measurement: null,
      walkway: null,
      cursor: null,
      snapHints: [],
      calibrating: false,
      calibrationRef: null,
      placementTransform: null,
      placingItemId: null,
      viewport: DEFAULT_VIEWPORT,
      walker: null,
      pendingCamera: null,
      notice: null,
      pendingImport: null,
    });
  },

  markSaved: () => set({ dirty: false }),

  // -- editor --------------------------------------------------------------
  editMode: 'plan',
  viewMode: 'plan2d',
  tool: 'select',
  shapeKind: 'rect',
  openingKind: 'door',
  viewport: DEFAULT_VIEWPORT,
  stageSize: { width: 800, height: 600 },
  selection: [],
  draft: null,
  cursor: null,
  snapHints: [],
  gridEnabled: true,
  angleStepDeg: DEFAULT_ANGLE_STEP_DEG,
  snapSuppressed: false,
  wallDefaults: DEFAULT_WALL_DEFAULTS,
  measurement: null,
  walkway: null,
  transform: null,
  calibrating: false,
  calibrationRef: null,
  placementTransform: null,
  placingItemId: null,
  cameraMode: 'orbit',
  walker: null,
  showCeilings: false,
  floorVisibility: 'active',
  pendingCamera: null,
  notice: null,
  pendingImport: null,

  setEditMode: (editMode) =>
    // Structure tools have no meaning in furnish mode, and a half-drawn wall would
    // otherwise survive the switch and commit into a locked layer.
    set({
      editMode,
      draft: null,
      transform: null,
      placementTransform: null,
      placingItemId: null,
      selection: [],
      notice: null,
      pendingImport: null,
      tool: editMode === 'plan' ? get().tool : 'select',
    }),

  setViewMode: (viewMode) => set({ viewMode, notice: null }),
  setTool: (tool) =>
    // The walkway survives a tool change, unlike a measurement: it is a route you
    // are working against while you move furniture, and losing it every time you
    // pick up the select tool would make it useless for the one job it has.
    set({ tool, draft: null, transform: null, placementTransform: null, measurement: null }),
  setShapeKind: (shapeKind) => set({ shapeKind, tool: 'shape', draft: null }),
  setOpeningKind: (openingKind) => set({ openingKind, tool: 'opening', draft: null }),
  setViewport: (viewport) => set({ viewport }),
  setStageSize: (stageSize) => set({ stageSize }),
  setSelection: (selection) => set({ selection }),

  toggleSelection: (ref) => {
    const selection = get().selection;
    const has = selection.some((s) => s.kind === ref.kind && s.id === ref.id);
    set({
      selection: has
        ? selection.filter((s) => !(s.kind === ref.kind && s.id === ref.id))
        : [...selection, ref],
    });
  },

  clearSelection: () => set({ selection: [] }),
  setDraft: (draft) => set({ draft }),
  setCursor: (cursor, hints) => set({ cursor, snapHints: hints ?? [] }),
  setGridEnabled: (gridEnabled) => set({ gridEnabled }),
  setSnapSuppressed: (snapSuppressed) => set({ snapSuppressed }),
  setMeasurement: (measurement) => set({ measurement }),
  setWalkway: (walkway) => set({ walkway }),
  setTransform: (transform) => set({ transform }),
  setPlacementTransform: (placementTransform) => set({ placementTransform }),
  // Arming an item cancels a selection drag and vice versa: the next click cannot
  // both drop a new item and grab an existing one.
  setPlacingItem: (placingItemId) => set({ placingItemId, placementTransform: null }),

  setCameraMode: (cameraMode) => set({ cameraMode }),
  setWalker: (walker) => set({ walker }),
  setShowCeilings: (showCeilings) => set({ showCeilings }),
  setFloorVisibility: (floorVisibility) => set({ floorVisibility }),

  /**
   * Change which floor everything is addressing.
   *
   * Silent, so undo walks back edits rather than storeys. A *bare* switch is not an
   * edit; a switch that rides along with one — adding a floor, deleting the one you
   * are standing on — is written inside that edit's own recipe instead, so undoing it
   * puts you back where you were rather than leaving `activeFloorId` naming a floor
   * the inverse patch has just removed.
   */
  setActiveFloor: (floorId) => {
    const { doc } = get();
    if (doc.activeFloorId === floorId) return;
    if (!doc.floors.some((f) => f.id === floorId)) return;

    get().mutate(
      'Active floor',
      (draft) => {
        draft.activeFloorId = floorId;
      },
      { silent: true },
    );
    get().clearFloorScopedState();
  },

  /**
   * Drop everything in the editor that names something on a particular floor.
   *
   * A selection, a half-drawn wall chain, a drag in progress, a walkway route measured
   * through rooms you are no longer looking at. `pruneSelection` alone would not do
   * it — it drops what no longer *exists*, and a wall on the floor below still exists
   * perfectly well; nothing prunes the route at all.
   *
   * Separate from `setActiveFloor` because the actions that change floors as part of a
   * document edit write `activeFloorId` inside their own recipe, which makes
   * `setActiveFloor` a no-op by the time they could call it. Deleting a floor is every
   * one of those, so folding this into the switch left the route from the deleted
   * floor alive and re-answering against geometry that had nothing to do with it.
   */
  clearFloorScopedState: () =>
    set({
      selection: [],
      draft: null,
      transform: null,
      placementTransform: null,
      placingItemId: null,
      walkway: null,
      walker: null,
      cursor: null,
      snapHints: [],
    }),
  setPendingCamera: (pendingCamera) => set({ pendingCamera }),
  setNotice: (notice) => set({ notice }),
  setPendingImport: (pendingImport) => set({ pendingImport }),

  /**
   * Jump to a bookmarked view.
   *
   * Editor state only — a bookmark records where you looked from, and using one is
   * not an edit to the space. Adding and removing bookmarks *is* a document change,
   * and lives in `actions.ts` with everything else that touches the document.
   *
   * In walk and fly the walker is moved directly, so the pose survives the next frame
   * of input; in orbit the pose goes to `pendingCamera` for the controls to adopt.
   */
  applySavedView: (view) => {
    const camera = decodeCamera(view.camera);
    const dx = camera.target.x - camera.position.x;
    const dy = camera.target.y - camera.position.y;
    const dz = camera.target.z - camera.position.z;
    const horizontal = Math.hypot(dx, dy);

    set({
      cameraMode: camera.mode,
      pendingCamera: camera,
      ...(camera.mode === 'orbit'
        ? {}
        : {
            walker: {
              position: { x: camera.position.x, y: camera.position.y },
              // The inverse of `forwardVector`: a bearing, not a maths angle.
              heading: horizontal === 0 ? 0 : toDegrees(Math.atan2(dx, -dy)),
              pitch: horizontal === 0 ? 0 : toDegrees(Math.atan2(dz, horizontal)),
              elevation: 0,
              crouching: false,
            },
          }),
    });
  },

  // Opening the gate cancels whatever was in flight: a half-drawn wall committed
  // against an uncalibrated plan is exactly the geometry the gate exists to stop.
  beginCalibration: () =>
    set({
      calibrating: true,
      calibrationRef: null,
      draft: null,
      transform: null,
      placementTransform: null,
      placingItemId: null,
      selection: [],
    }),
  setCalibrationRef: (calibrationRef) => set({ calibrationRef }),
  endCalibration: () => set({ calibrating: false, calibrationRef: null }),

  zoomToFit: () => {
    const state = get();
    const box = floorBounds(activeFloor(state));
    set({ viewport: box ? fitBounds(box, state.stageSize) : DEFAULT_VIEWPORT });
  },
}));

/** Grid step of the active document, in mm. */
export function documentGridMm(doc: SpaceDocument): number {
  return doc.gridMm > 0 ? doc.gridMm : DEFAULT_GRID_MM;
}
