import { useShallow } from 'zustand/react/shallow';
import { backgroundExtentMm, isCalibrated } from '../core/calibration';
import { formatLength } from '../core/units';
import { DEFAULT_SCALE, gridStepMm } from '../core/viewport';
import { activeFloor, documentGridMm, useStore } from '../state/store';

/**
 * The status line under the viewport.
 *
 * It exists first because it is genuinely useful — the counts, the cursor readout and
 * the live grid step are what you check while drawing — and second because it is the
 * one place the canvas state becomes readable DOM. Konva renders to a bitmap, so
 * without a surface like this an end-to-end test can only assert that pixels changed.
 */
export function StatusBar() {
  const { doc, viewport, cursor, gridEnabled, past, future, dirty } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      viewport: s.viewport,
      cursor: s.cursor,
      gridEnabled: s.gridEnabled,
      past: s.past,
      future: s.future,
      dirty: s.dirty,
    })),
  );

  const floor = activeFloor({ doc });
  const unit = doc.displayUnit;
  const step = gridStepMm(viewport, documentGridMm(doc));

  return (
    <div className="statusbar">
      <span data-testid="count-walls">
        Walls <b>{floor.walls.length}</b>
      </span>
      <span data-testid="count-rooms">
        Rooms <b>{floor.rooms.length}</b>
      </span>
      <span data-testid="count-placements">
        Items <b>{floor.placements.length}</b>
      </span>

      {/* The plan's width is the honest readout of a calibration: it is the number
          that changes when a scale is applied, and the one a person can sanity-check
          against a room they have stood in. `mmPerPx` is true but unreadable. */}
      {floor.background ? (
        <span data-testid="background-readout">
          {isCalibrated(floor.background)
            ? `Plan ${formatLength(backgroundExtentMm(floor.background).width, unit)} wide`
            : 'Plan uncalibrated'}
        </span>
      ) : null}

      <span className="statusbar__spacer" />

      <span data-testid="cursor-readout">
        {cursor
          ? `${formatLength(cursor.x, unit)}, ${formatLength(cursor.y, unit)}`
          : '—'}
      </span>
      {/* The flag gates snapping, not grid drawing — the grid stays on screen as a
          reference either way, so the readout says "Snap" like the palette button. */}
      <span data-testid="grid-readout">
        Snap {gridEnabled ? formatLength(step, unit) : 'off'}
      </span>
      {/* 100% is the scale a fresh document opens at, not one pixel per millimetre —
          the latter would read as 5% on first load and mean nothing to anyone. */}
      <span data-testid="zoom-readout">{Math.round((viewport.scale / DEFAULT_SCALE) * 100)}%</span>
      <span data-testid="history-readout">
        {past.length} undo · {future.length} redo{dirty ? ' · unsaved' : ''}
      </span>
    </div>
  );
}
