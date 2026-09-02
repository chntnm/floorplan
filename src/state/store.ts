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
import { bounds, type Bounds } from '../core/geometry/polygon';
import { wallOutline } from '../core/geometry/wall';
import type { Vec2 } from '../core/geometry/vec';
import type { AssetMap } from '../core/space-file';
import { adoptAssets, clearAssets } from './assets';

// immer 10 gates patch recording behind this plugin. Without it `produceWithPatches`
// throws at runtime — which neither typecheck nor lint can see.
enablePatches();

export type SelectionKind = 'wall' | 'room' | 'placement';
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
  loadDocument: (doc: SpaceDocument, assets?: AssetMap) => void;
  newDocument: () => void;
  markSaved: () => void;

  // -- editor slice --------------------------------------------------------
  editMode: EditMode;
  viewMode: ViewMode;
  tool: PlanTool;
  shapeKind: ShapeKind;
  viewport: Viewport;
  stageSize: Size;
  selection: SelectionRef[];
  draft: Draft | null;
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

  setEditMode: (mode: EditMode) => void;
  setViewMode: (mode: ViewMode) => void;
  setTool: (tool: PlanTool) => void;
  setShapeKind: (kind: ShapeKind) => void;
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
  setTransform: (t: WallTransform | null) => void;
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
    });
  },

  // The asset store is the other half of the document (see `state/assets.ts`), so
  // replacing one replaces the other. Leaving stale bytes behind would mean the next
  // save wrote a file carrying the previous document's background.
  loadDocument: (doc, assets) => {
    if (assets) adoptAssets(doc, assets);
    else clearAssets();
    set({
      doc,
      past: [],
      future: [],
      dirty: false,
      selection: [],
      draft: null,
      transform: null,
      measurement: null,
      cursor: null,
      snapHints: [],
      calibrating: false,
      calibrationRef: null,
    });
  },

  newDocument: () => {
    clearAssets();
    set({
      doc: freshDocument(),
      past: [],
      future: [],
      dirty: false,
      selection: [],
      draft: null,
      transform: null,
      measurement: null,
      cursor: null,
      snapHints: [],
      calibrating: false,
      calibrationRef: null,
      viewport: DEFAULT_VIEWPORT,
    });
  },

  markSaved: () => set({ dirty: false }),

  // -- editor --------------------------------------------------------------
  editMode: 'plan',
  viewMode: 'plan2d',
  tool: 'select',
  shapeKind: 'rect',
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
  transform: null,
  calibrating: false,
  calibrationRef: null,

  setEditMode: (editMode) =>
    // Structure tools have no meaning in furnish mode, and a half-drawn wall would
    // otherwise survive the switch and commit into a locked layer.
    set({
      editMode,
      draft: null,
      transform: null,
      selection: [],
      tool: editMode === 'plan' ? get().tool : 'select',
    }),

  setViewMode: (viewMode) => set({ viewMode }),
  setTool: (tool) => set({ tool, draft: null, transform: null, measurement: null }),
  setShapeKind: (shapeKind) => set({ shapeKind, tool: 'shape', draft: null }),
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
  setTransform: (transform) => set({ transform }),

  // Opening the gate cancels whatever was in flight: a half-drawn wall committed
  // against an uncalibrated plan is exactly the geometry the gate exists to stop.
  beginCalibration: () =>
    set({ calibrating: true, calibrationRef: null, draft: null, transform: null, selection: [] }),
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
