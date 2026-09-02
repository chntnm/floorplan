import { useShallow } from 'zustand/react/shallow';
import { structureIsEditable } from '../core/modes';
import {
  PLAN_TOOLS,
  PLAN_TOOL_KEYS,
  PLAN_TOOL_LABELS,
  SHAPE_KINDS,
  SHAPE_KIND_LABELS,
} from '../core/tools';
import { useStore } from '../state/store';

/**
 * The plan tool palette (PLAN.md §8).
 *
 * Disabled rather than hidden in furnish mode: a tool that vanishes leaves you
 * wondering whether it exists, where one that is visibly unavailable tells you the
 * mode is why.
 */
export function ToolPalette() {
  const { tool, shapeKind, editMode, gridEnabled, calibrating } = useStore(
    useShallow((s) => ({
      tool: s.tool,
      shapeKind: s.shapeKind,
      editMode: s.editMode,
      gridEnabled: s.gridEnabled,
      calibrating: s.calibrating,
    })),
  );

  // Disabled during the calibration gate as well as in furnish mode: a plan with no
  // scale produces walls whose lengths mean nothing, and nothing downstream can
  // correct them afterwards. See PLAN.md §6.1.
  const enabled = structureIsEditable(editMode) && !calibrating;

  return (
    <div className="palette">
      <div className="palette__row" role="group" aria-label="Plan tools">
        {PLAN_TOOLS.map((t) => (
          <button
            key={t}
            type="button"
            className="seg"
            data-active={t === tool}
            aria-pressed={t === tool}
            disabled={!enabled && (calibrating || t !== 'select')}
            title={`${PLAN_TOOL_LABELS[t]} (${PLAN_TOOL_KEYS[t].toUpperCase()})`}
            onClick={() => useStore.getState().setTool(t)}
          >
            {PLAN_TOOL_LABELS[t]}
          </button>
        ))}
      </div>

      {tool === 'shape' && enabled ? (
        <div className="palette__row" role="group" aria-label="Shape">
          {SHAPE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="seg seg--small"
              data-active={k === shapeKind}
              aria-pressed={k === shapeKind}
              onClick={() => useStore.getState().setShapeKind(k)}
            >
              {SHAPE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="palette__row palette__row--end">
        <button
          type="button"
          className="seg"
          data-active={gridEnabled}
          aria-pressed={gridEnabled}
          title="Snap to grid (G)"
          onClick={() => useStore.getState().setGridEnabled(!gridEnabled)}
        >
          Snap
        </button>
        <button
          type="button"
          className="seg"
          title="Zoom to fit"
          onClick={() => useStore.getState().zoomToFit()}
        >
          Fit
        </button>
      </div>
    </div>
  );
}
