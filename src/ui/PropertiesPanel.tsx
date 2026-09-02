import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { structureIsEditable } from '../core/modes';
import { formatArea, formatLength } from '../core/units';
import { wallAngleDeg, wallLength } from '../core/geometry/wall';
import { activeFloor, useStore } from '../state/store';
import { deleteSelection, setRoomName } from '../state/actions';

/** A labelled read-only field. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className="field__value">{value}</span>
    </div>
  );
}

/**
 * Selection inspector, and the placeholder for the validation list
 * (overlap / headroom / clearance / door swing — PLAN.md §9).
 */
export function PropertiesPanel() {
  const { doc, editMode, selection } = useStore(
    useShallow((s) => ({ doc: s.doc, editMode: s.editMode, selection: s.selection })),
  );

  const floor = activeFloor({ doc });
  const unit = doc.displayUnit;
  const only = selection.length === 1 ? selection[0] : null;

  const wall = only?.kind === 'wall' ? floor.walls.find((w) => w.id === only.id) : undefined;
  const room = only?.kind === 'room' ? floor.rooms.find((r) => r.id === only.id) : undefined;

  // Held locally while typing so a rename is one undo step, not one per keystroke.
  const [draftName, setDraftName] = useState(room?.name ?? '');
  useEffect(() => setDraftName(room?.name ?? ''), [room?.id, room?.name]);

  const commitName = () => {
    if (room && draftName.trim() && draftName !== room.name) setRoomName(room.id, draftName.trim());
  };

  return (
    <aside className="panel panel--right">
      <h2 className="panel__heading">Properties</h2>

      {selection.length === 0 ? (
        <p className="panel__empty">
          Nothing selected.{' '}
          {structureIsEditable(editMode)
            ? 'Walls, rooms and openings are editable.'
            : 'Structure is locked; furniture is editable.'}
        </p>
      ) : null}

      {wall ? (
        <div data-testid="wall-properties">
          <Field label="Type" value="Wall" />
          <Field label="Length" value={formatLength(wallLength(wall), unit)} />
          <Field label="Thickness" value={formatLength(wall.thicknessMm, unit)} />
          <Field label="Height" value={formatLength(wall.heightMm, unit)} />
          <Field label="Angle" value={`${wallAngleDeg(wall).toFixed(1)}°`} />
        </div>
      ) : null}

      {room ? (
        <div data-testid="room-properties">
          <label className="field field--input">
            <span className="field__label">Name</span>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </label>
          <Field label="Area" value={formatArea(room.areaMm2, unit)} />
          <Field label="Ceiling" value={formatLength(room.ceilingHeightMm, unit)} />
          <Field label="Vertices" value={String(room.boundary.pts.length)} />
        </div>
      ) : null}

      {selection.length > 1 ? (
        <p className="panel__empty" data-testid="multi-selection">
          {selection.length} items selected.
        </p>
      ) : null}

      {selection.length > 0 ? (
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => deleteSelection(selection)}
        >
          Delete
        </button>
      ) : null}

      <h2 className="panel__heading">Validation</h2>
      <p className="panel__empty">
        No issues. Overlap, headroom and clearance checks arrive with the inventory in
        phase 4.
      </p>
    </aside>
  );
}
