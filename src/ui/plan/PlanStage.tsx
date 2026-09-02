import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Layer, Rect, Stage } from 'react-konva';
import type Konva from 'konva';
import { useShallow } from 'zustand/react/shallow';
import { placementsAreEditable, structureIsEditable } from '../../core/modes';
import {
  snapPoint,
  DEFAULT_SNAP_TOLERANCE_PX,
  type SnapContext,
  type SnapResult,
} from '../../core/snapping';
import { wallEndpoints } from '../../core/geometry/wall';
import type { Vec2 } from '../../core/geometry/vec';
import { PLAN_TOOL_KEYS, PLAN_TOOLS, type PlanTool } from '../../core/tools';
import { panBy, pxToMm, screenToDoc, zoomAt } from '../../core/viewport';
import { activeFloor, documentGridMm, useStore, type SelectionRef } from '../../state/store';
import {
  addOpening,
  addPlacement,
  addRoomRect,
  addShapeRoom,
  addWallChain,
  commitPlacementTransform,
  commitWallTransform,
  deleteSelection,
  placementSnapContext,
  previewPlacementTransform,
  previewWallTransform,
  rotatePlacementBy,
} from '../../state/actions';
import { PlacementBlockedError } from '../../core/calibration';
import { OpeningError } from '../../core/openings';
import { flaggedPlacements, validateFloor } from '../../core/validation';
import { ROTATION_STEP_DEG, snapPlacement } from '../../core/placement-snap';
import { BackgroundLayer } from './BackgroundLayer';
import { DraftLayer } from './DraftLayer';
import { GridLayer } from './GridLayer';
import { PlacementLayer } from './PlacementLayer';
import { StructureLayer } from './StructureLayer';
import { usePlanTheme } from './theme';

/** Wheel notch → zoom factor. 1.0015^deltaY tracks a trackpad as smoothly as a mouse. */
const ZOOM_SENSITIVITY = 1.0015;

const DRAW_TOOLS: ReadonlySet<PlanTool> = new Set<PlanTool>(['wall', 'room', 'shape', 'dimension']);

/**
 * How close two consecutive clicks must be, in screen pixels, to read as "click the
 * same point again" and finish a wall chain.
 *
 * Konva's own `dblclick` is not usable for this: it fires on any two clicks inside
 * `Konva.dblClickWindow` (400ms) with **no distance check at all**, so drawing two
 * wall points quickly — which is how anyone draws — would end the chain at the second
 * point. Same-place is the gesture people actually mean, and it needs no timer.
 */
const REPEAT_CLICK_PX = 6;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
  );
}

/**
 * The Konva plan editor.
 *
 * Pointer work here writes only to the editor slice of the store; the document is
 * touched exactly once per completed gesture, through the actions in
 * `state/actions.ts`. That is what makes one drawn wall equal one press of Ctrl+Z.
 */
export function PlanStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const lastClickPx = useRef<{ x: number; y: number } | null>(null);
  const calDrag = useRef(false);
  const theme = usePlanTheme();

  const {
    doc,
    viewport,
    stageSize,
    editMode,
    tool,
    draft,
    cursor,
    snapHints,
    selection,
    measurement,
    transform,
    calibrating,
    calibrationRef,
    placementTransform,
    placingItemId,
  } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      viewport: s.viewport,
      stageSize: s.stageSize,
      editMode: s.editMode,
      tool: s.tool,
      draft: s.draft,
      cursor: s.cursor,
      snapHints: s.snapHints,
      selection: s.selection,
      measurement: s.measurement,
      transform: s.transform,
      calibrating: s.calibrating,
      calibrationRef: s.calibrationRef,
      placementTransform: s.placementTransform,
      placingItemId: s.placingItemId,
    })),
  );

  // Snap settings are read from `getState()` at pointer time rather than subscribed:
  // nothing in this render depends on them, and a Konva stage should not re-render
  // because a checkbox moved.
  const floor = activeFloor({ doc });

  // ---- sizing ------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const apply = () =>
      useStore.getState().setStageSize({
        width: Math.max(1, el.clientWidth),
        height: Math.max(1, el.clientHeight),
      });

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The validation pass is the only thing here that walks every placement against
  // every other, so it is memoized on the document rather than run per render.
  const flagged = useMemo(() => flaggedPlacements(validateFloor(doc, floor)), [doc, floor]);

  // ---- snapping ----------------------------------------------------------
  const snapCandidates = useMemo(() => {
    const pts: Vec2[] = wallEndpoints(floor.walls);
    for (const room of floor.rooms) pts.push(...room.boundary.pts);
    return pts;
  }, [floor.walls, floor.rooms]);

  /**
   * The anchor for the angle constraint: the point the current gesture grew from.
   *
   * Read from `getState()`, not the subscribed `draft`. Two clicks in quick
   * succession can both land before React has committed a re-render, and a handler
   * closed over a stale draft silently drops the first point of a chain.
   */
  const draftAnchor = (): Vec2 | undefined => {
    const current = useStore.getState().draft;
    if (!current) return undefined;
    if (current.tool === 'wall') return current.points[current.points.length - 1];
    if (current.tool === 'dimension') return current.start;
    return undefined; // rect drags read better unconstrained
  };

  const snapAt = useCallback(
    (stage: Konva.Stage, anchor: Vec2 | undefined): SnapResult | null => {
      const pos = stage.getPointerPosition();
      if (!pos) return null;

      const state = useStore.getState();
      const raw = screenToDoc(state.viewport, pos);

      // The draft's own points are snap targets too. Without them, closing a wall
      // loop only works when the final click happens to land in the same grid cell
      // as the start — and never at all with the grid off or Alt held.
      const inFlight =
        state.draft?.tool === 'wall' ? [...snapCandidates, ...state.draft.points] : snapCandidates;

      const ctx: SnapContext = {
        gridMm: documentGridMm(state.doc),
        gridEnabled: state.gridEnabled,
        points: inFlight,
        toleranceMm: pxToMm(state.viewport, DEFAULT_SNAP_TOLERANCE_PX),
        angleStepDeg: state.angleStepDeg,
        suppressed: state.snapSuppressed,
        ...(anchor ? { anchor } : {}),
      };
      return snapPoint(raw, ctx);
    },
    [snapCandidates],
  );

  // ---- transform ---------------------------------------------------------
  /** Begin a wall drag. The document is untouched until the pointer is released. */
  const beginTransform = (wallId: string, end: 'a' | 'b' | 'both') => {
    const state = useStore.getState();
    const wall = activeFloor(state).walls.find((w) => w.id === wallId);
    const grab = state.cursor;
    if (!wall || !grab) return;

    state.setTransform({
      wallId,
      end,
      grab,
      origin: { a: wall.a, b: wall.b },
      a: wall.a,
      b: wall.b,
    });
  };

  /** The raw (unsnapped) document point under the pointer. */
  const rawAt = (stage: Konva.Stage): Vec2 | null => {
    const pos = stage.getPointerPosition();
    return pos ? screenToDoc(useStore.getState().viewport, pos) : null;
  };

  /** The snap context for whichever item a placement gesture concerns. */
  const snapCtxFor = (itemId: string, excludePlacementId?: string) =>
    placementSnapContext(itemId, {
      toleranceMm: pxToMm(useStore.getState().viewport, DEFAULT_SNAP_TOLERANCE_PX),
      ...(excludePlacementId ? { excludePlacementId } : {}),
    });

  /** Begin a placement drag. The document is untouched until the pointer is released. */
  const beginPlacementTransform = (placementId: string, mode: 'move' | 'rotate') => {
    const state = useStore.getState();
    const placement = activeFloor(state).placements.find((p) => p.id === placementId);
    const grab = state.cursor;
    if (!placement || !grab) return;
    // A placement whose item is gone has no footprint to snap with, and its snap
    // context would come back null — which would quietly ignore Alt for the whole
    // drag. It also has nothing rendered to grab, so this is belt and braces; stating
    // it here keeps that a rule rather than a coincidence.
    if (!snapCtxFor(placement.itemId, placement.id)) return;

    state.setPlacementTransform({
      placementId,
      mode,
      grab,
      origin: { position: placement.position, rotation: placement.rotation },
      position: placement.position,
      rotation: placement.rotation,
      mount: placement.mount,
      hints: [],
    });
  };

  /**
   * Drop the armed item where the pointer is.
   *
   * The gate is enforced here rather than in the UI so it cannot be routed around:
   * `addPlacement` throws, and the message it throws is the same sentence the
   * validation panel shows.
   */
  const dropArmedItem = (stage: Konva.Stage) => {
    const state = useStore.getState();
    const itemId = state.placingItemId;
    if (!itemId) return;

    const raw = rawAt(stage);
    if (!raw) return;

    const ctx = snapCtxFor(itemId);
    const snapped = ctx ? snapPlacement(raw, 0, ctx) : null;

    try {
      const placement = addPlacement(itemId, snapped?.position ?? raw, {
        rotation: snapped?.rotation ?? 0,
        ...(snapped ? { mount: snapped.mount } : {}),
      });
      if (placement) state.setSelection([{ kind: 'placement', id: placement.id }]);
    } catch (err) {
      if (err instanceof PlacementBlockedError) {
        window.alert(err.message);
        state.setPlacingItem(null);
        return;
      }
      throw err;
    }
  };

  /**
   * Put an opening in the wall under the pointer.
   *
   * Deliberately uses the *raw* point rather than the snapped one. Grid snapping
   * moves a click by up to half a cell, which is enough to push it off a 114mm wall
   * entirely — and the position along the wall is decided by projection onto the
   * centreline anyway, so the grid has nothing useful to contribute here.
   */
  const dropOpening = (stage: Konva.Stage) => {
    const state = useStore.getState();
    const raw = rawAt(stage);
    if (!raw) return;

    try {
      const opening = addOpening(
        raw,
        state.openingKind,
        pxToMm(state.viewport, DEFAULT_SNAP_TOLERANCE_PX),
      );
      if (opening) state.setSelection([{ kind: 'opening', id: opening.id }]);
    } catch (err) {
      // A wall too short to hold the opening. The message names the sizes, and the
      // document is untouched — `createOpening` throws before the mutation.
      if (err instanceof OpeningError) {
        window.alert(err.message);
        return;
      }
      throw err;
    }
  };

  // ---- pointer -----------------------------------------------------------
  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage();
    if (!stage) return;

    // Live state for the same reason as `draftAnchor` — clicks can outrun renders.
    const { tool, draft, shapeKind } = useStore.getState();
    const middle = e.evt.button === 1;
    const onEmptyCanvas = e.target === stage;

    // The gate takes the whole stage. Snapping is deliberately off for this drag:
    // the reference has to land on the feature in the raster the user is pointing
    // at, and quantising it to the grid quantises the scale that comes out of it.
    if (useStore.getState().calibrating && !middle) {
      if (e.evt.button !== 0) return;
      const pos = stage.getPointerPosition();
      if (!pos) return;
      const at = screenToDoc(useStore.getState().viewport, pos);
      calDrag.current = true;
      useStore.getState().setCalibrationRef({ a: at, b: at });
      return;
    }

    // An armed item drops on the next left click anywhere on the canvas. Checked
    // before the pan branch, because a click on empty canvas with Select is
    // otherwise read as the start of a pan.
    if (e.evt.button === 0 && useStore.getState().placingItemId) {
      dropArmedItem(stage);
      return;
    }

    // An opening is a single click on a wall rather than a draft, so it is handled
    // before the draw-tool switch below. A click that lands on no wall does nothing.
    if (e.evt.button === 0 && tool === 'opening') {
      dropOpening(stage);
      return;
    }

    // Middle-drag always pans; so does a left-drag on empty canvas with Select, which
    // is the gesture most people reach for before finding a pan key.
    if (middle || (onEmptyCanvas && tool === 'select')) {
      if (middle) e.evt.preventDefault();
      pan.current = { active: true, x: e.evt.clientX, y: e.evt.clientY };
      if (!middle) useStore.getState().clearSelection();
      return;
    }

    if (e.evt.button !== 0 || !DRAW_TOOLS.has(tool)) return;

    const snapped = snapAt(stage, draftAnchor());
    if (!snapped) return;
    const p = snapped.point;
    const store = useStore.getState();

    switch (tool) {
      case 'wall': {
        const pos = stage.getPointerPosition();
        const previous = lastClickPx.current;
        if (pos) lastClickPx.current = { x: pos.x, y: pos.y };

        if (!draft || draft.tool !== 'wall') {
          store.setDraft({ tool: 'wall', points: [p], cursor: p });
          return;
        }

        // Clicking the same spot again finishes the chain — this is what a real
        // double-click resolves to as well, without depending on how fast it was.
        const repeated =
          pos && previous && Math.hypot(pos.x - previous.x, pos.y - previous.y) <= REPEAT_CLICK_PX;
        if (repeated) {
          addWallChain(draft.points);
          store.setDraft(null);
          lastClickPx.current = null;
          return;
        }

        const points = [...draft.points, p];
        // Clicking the start point closes the loop and finishes the chain.
        const start = draft.points[0]!;
        if (points.length > 2 && start.x === p.x && start.y === p.y) {
          addWallChain(points);
          store.setDraft(null);
          lastClickPx.current = null;
          return;
        }
        store.setDraft({ tool: 'wall', points, cursor: p });
        return;
      }
      case 'room':
        store.setDraft({ tool: 'room', start: p, cursor: p });
        return;
      case 'shape':
        store.setDraft({ tool: 'shape', kind: shapeKind, start: p, cursor: p });
        return;
      case 'dimension':
        store.setMeasurement(null);
        store.setDraft({ tool: 'dimension', start: p, cursor: p });
        return;
      default:
        return;
    }
  };

  const onMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage();
    if (!stage) return;

    if (pan.current.active) {
      const dx = e.evt.clientX - pan.current.x;
      const dy = e.evt.clientY - pan.current.y;
      pan.current = { active: true, x: e.evt.clientX, y: e.evt.clientY };
      useStore.getState().setViewport(panBy(useStore.getState().viewport, dx, dy));
      return;
    }

    const store = useStore.getState();

    if (calDrag.current) {
      const pos = stage.getPointerPosition();
      const ref = store.calibrationRef;
      if (pos && ref) store.setCalibrationRef({ a: ref.a, b: screenToDoc(store.viewport, pos) });
      return;
    }
    if (store.calibrating) return;

    const moving = store.placementTransform;
    if (moving) {
      const raw = rawAt(stage);
      if (!raw) return;
      const placement = activeFloor(store).placements.find((p) => p.id === moving.placementId);
      const ctx = placement ? snapCtxFor(placement.itemId, placement.id) : null;
      store.setCursor(raw);
      store.setPlacementTransform(previewPlacementTransform(moving, raw, ctx));
      return;
    }

    const dragging = store.transform;
    const snapped = snapAt(stage, dragging && dragging.end !== 'both' ? undefined : draftAnchor());
    if (!snapped) return;

    store.setCursor(snapped.point, snapped.hints);

    if (dragging) {
      store.setTransform(previewWallTransform(dragging, snapped.point));
      return;
    }

    const current = store.draft;
    if (current) store.setDraft({ ...current, cursor: snapped.point });
  };

  const finishPan = () => {
    pan.current = { active: false, x: 0, y: 0 };
  };

  const onMouseUp = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (pan.current.active) {
      finishPan();
      return;
    }

    const store = useStore.getState();

    if (calDrag.current) {
      calDrag.current = false;
      // A click without a drag is not a reference line; drop it so the gate keeps
      // asking rather than accepting a zero-length one it would only reject later.
      const ref = store.calibrationRef;
      if (ref && ref.a.x === ref.b.x && ref.a.y === ref.b.y) store.setCalibrationRef(null);
      return;
    }
    if (store.calibrating) return;

    const moving = store.placementTransform;
    if (moving) {
      commitPlacementTransform(moving);
      store.setPlacementTransform(null);
      return;
    }

    const dragging = store.transform;
    if (dragging) {
      commitWallTransform(dragging);
      store.setTransform(null);
      return;
    }

    const current = store.draft;
    if (!current) return;

    const stage = e.target.getStage();
    const snapped = stage ? snapAt(stage, draftAnchor()) : null;
    const end = snapped?.point ?? ('cursor' in current ? current.cursor : null);
    if (!end) return;

    switch (current.tool) {
      case 'room': {
        const room = addRoomRect(current.start, end);
        store.setDraft(null);
        if (room) store.setSelection([{ kind: 'room', id: room.id }]);
        return;
      }
      case 'shape': {
        const room = addShapeRoom(current.kind, current.start, end);
        store.setDraft(null);
        if (room) store.setSelection([{ kind: 'room', id: room.id }]);
        return;
      }
      case 'dimension': {
        store.setMeasurement({ from: current.start, to: end });
        store.setDraft(null);
        return;
      }
      default:
        // The wall chain persists across mouse-ups; it ends on Enter, a double-click
        // or by closing the loop.
        return;
    }
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    const factor = Math.pow(ZOOM_SENSITIVITY, -e.evt.deltaY);
    useStore.getState().setViewport(zoomAt(useStore.getState().viewport, pos, factor));
  };

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const store = useStore.getState();

      // The gate is blocking, so the shortcuts are too. Undoing past an import while
      // the gate is open would leave it prompting for a background that is gone, and
      // a tool key would arm a tool the palette is showing as unavailable.
      if (store.calibrating) {
        if (e.key === 'Escape') store.setCalibrationRef(null);
        return;
      }

      if (e.key === 'Alt') {
        store.setSnapSuppressed(true);
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }
      if (mod) return;

      if (e.key === 'Escape') {
        store.setDraft(null);
        store.setTransform(null);
        store.setPlacementTransform(null);
        store.setPlacingItem(null);
        store.clearSelection();
        lastClickPx.current = null;
        return;
      }
      // Rotating from the keyboard, because the handle is a fine gesture and a poor
      // way to hit exactly 90°.
      if (e.key === '[' || e.key === ']') {
        const selected = store.selection.filter((s) => s.kind === 'placement');
        if (selected.length > 0) {
          e.preventDefault();
          const step = e.key === ']' ? ROTATION_STEP_DEG : -ROTATION_STEP_DEG;
          for (const ref of selected) rotatePlacementBy(ref.id, step);
        }
        return;
      }
      if (e.key === 'Enter') {
        const current = store.draft;
        if (current?.tool === 'wall') {
          addWallChain(current.points);
          store.setDraft(null);
        }
        lastClickPx.current = null;
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selection.length > 0) {
          e.preventDefault();
          deleteSelection(store.selection);
        }
        return;
      }
      if (e.key.toLowerCase() === 'g') {
        store.setGridEnabled(!store.gridEnabled);
        return;
      }

      if (structureIsEditable(store.editMode)) {
        const match = PLAN_TOOLS.find((t) => PLAN_TOOL_KEYS[t] === e.key.toLowerCase());
        if (match) store.setTool(match);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') useStore.getState().setSnapSuppressed(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ---- render ------------------------------------------------------------
  // Mode drives `listening`, which is the layer toggle from the brief. The tool
  // drives `selectable`, which the shape handlers read — because flipping
  // `listening` only takes effect on Konva's next draw, and a click that arrives in
  // the same frame lands on a layer that is still deaf.
  const structureInteractive = structureIsEditable(editMode) && !calibrating;
  const structureSelectable = structureInteractive && tool === 'select';
  const placementsInteractive = placementsAreEditable(editMode) && !calibrating;
  // The background only accepts a drag when it has been deliberately unlocked, and
  // never while the gate is open — dragging the plan out from under the reference
  // line you are drawing on it is not a gesture anyone means.
  const backgroundInteractive =
    structureSelectable && floor.background?.locked === false;

  const onSelect = (ref: SelectionRef, additive: boolean) => {
    const store = useStore.getState();
    if (additive) store.toggleSelection(ref);
    else store.setSelection([ref]);
  };

  return (
    <div
      ref={containerRef}
      className="planstage"
      data-cursor={calibrating || placingItemId || DRAW_TOOLS.has(tool) ? 'draw' : 'select'}
      data-testid="plan-stage"
    >
      <Stage
        width={stageSize.width}
        height={stageSize.height}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          finishPan();
          const store = useStore.getState();
          // Commit rather than discard: the pointer leaving the canvas is not a
          // cancel, and silently reverting a drag the user finished off-screen
          // would look like the app dropped it.
          if (store.transform) {
            commitWallTransform(store.transform);
            store.setTransform(null);
          }
          if (store.placementTransform) {
            commitPlacementTransform(store.placementTransform);
            store.setPlacementTransform(null);
          }
          store.setCursor(null);
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        <BackgroundLayer
          background={floor.background}
          viewport={viewport}
          interactive={backgroundInteractive}
        />

        <GridLayer
          viewport={viewport}
          size={stageSize}
          gridMm={documentGridMm(doc)}
          theme={theme}
        />

        {/* An invisible full-stage rect so clicks on empty canvas still reach a
            shape — Konva reports the Stage as the target either way, but this keeps
            the hit graph consistent when layers below are not listening. */}
        <Layer listening={false}>
          <Rect x={0} y={0} width={stageSize.width} height={stageSize.height} />
        </Layer>

        <StructureLayer
          floor={floor}
          viewport={viewport}
          theme={theme}
          displayUnit={doc.displayUnit}
          selection={selection}
          interactive={structureInteractive}
          selectable={structureSelectable}
          transform={transform}
          onSelect={onSelect}
          onGrabWall={(wallId) => beginTransform(wallId, 'both')}
          onGrabEndpoint={(wallId, end) => beginTransform(wallId, end)}
        />

        <PlacementLayer
          doc={doc}
          floor={floor}
          viewport={viewport}
          theme={theme}
          selection={selection}
          interactive={placementsInteractive}
          selectable={placementsInteractive && !placingItemId}
          transform={placementTransform}
          flagged={flagged}
          onSelect={onSelect}
          onGrab={beginPlacementTransform}
        />

        <DraftLayer
          draft={draft}
          measurement={measurement}
          calibrationRef={calibrationRef}
          snapHints={snapHints}
          cursor={cursor}
          viewport={viewport}
          theme={theme}
          displayUnit={doc.displayUnit}
        />
      </Stage>
    </div>
  );
}
