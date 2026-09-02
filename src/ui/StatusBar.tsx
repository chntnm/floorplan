import { useShallow } from 'zustand/react/shallow';
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

      <span className="statusbar__spacer" />

      <span data-testid="cursor-readout">
        {cursor
          ? `${formatLength(cursor.x, unit)}, ${formatLength(cursor.y, unit)}`
          : '—'}
      </span>
      <span data-testid="grid-readout">
        Grid {gridEnabled ? formatLength(step, unit) : 'off'}
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
