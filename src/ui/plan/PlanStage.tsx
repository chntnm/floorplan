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
import { addRoomRect, addShapeRoom, addWallChain, deleteSelection } from '../../state/actions';
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

      const raw = screenToDoc(useStore.getState().viewport, pos);
      const state = useStore.getState();
      const ctx: SnapContext = {
        gridMm: documentGridMm(state.doc),
        gridEnabled: state.gridEnabled,
        points: snapCandidates,
        toleranceMm: pxToMm(state.viewport, DEFAULT_SNAP_TOLERANCE_PX),
        angleStepDeg: state.angleStepDeg,
        suppressed: state.snapSuppressed,
        ...(anchor ? { anchor } : {}),
      };
      return snapPoint(raw, ctx);
    },
    [snapCandidates],
  );

  // ---- pointer -----------------------------------------------------------
  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage();
    if (!stage) return;

    // Live state for the same reason as `draftAnchor` — clicks can outrun renders.
    const { tool, draft, shapeKind } = useStore.getState();
    const middle = e.evt.button === 1;
    const onEmptyCanvas = e.target === stage;

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

    const snapped = snapAt(stage, draftAnchor());
    if (!snapped) return;

    const store = useStore.getState();
    store.setCursor(snapped.point, snapped.hints);

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
        store.clearSelection();
        lastClickPx.current = null;
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
  const structureInteractive = structureIsEditable(editMode) && tool === 'select';
  const placementsInteractive = placementsAreEditable(editMode);

  const onSelect = (ref: SelectionRef, additive: boolean) => {
    const store = useStore.getState();
    if (additive) store.toggleSelection(ref);
    else store.setSelection([ref]);
  };

  return (
    <div
      ref={containerRef}
      className="planstage"
      data-cursor={DRAW_TOOLS.has(tool) ? 'draw' : 'select'}
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
          useStore.getState().setCursor(null);
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.evt.preventDefault()}
      >
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
          onSelect={onSelect}
        />

        <PlacementLayer
          doc={doc}
          floor={floor}
          viewport={viewport}
          theme={theme}
          selection={selection}
          interactive={placementsInteractive}
          onSelect={onSelect}
        />

        <DraftLayer
          draft={draft}
          measurement={measurement}
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
