import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { structureIsEditable } from '../core/modes';
import { formatArea, formatLength } from '../core/units';
import { wallAngleDeg, wallLength } from '../core/geometry/wall';
import { activeFloor, useStore } from '../state/store';
import {
  deleteSelection,
  nudgeBackgroundRotation,
  removeBackground,
  setBackgroundLocked,
  setBackgroundOpacity,
  setRoomName,
} from '../state/actions';
import {
  backgroundExtentMm,
  isCalibrated,
  placementBlockReason,
} from '../core/calibration';
import { hasAsset } from '../state/assets';

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

  const background = floor.background;
  // The gate's consequence, stated where a consequence belongs. Shipping the reason
  // rather than a bare refusal is the whole point: "no" with no explanation reads as
  // a bug, and phase 4 will surface exactly this string when it rejects a placement.
  const blocked = placementBlockReason(floor);

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

      {background ? (
        <div data-testid="background-properties">
          <h2 className="panel__heading">Floor plan</h2>

          {!hasAsset(background.assetId) ? (
            <p className="panel__warn" data-testid="background-missing">
              The image for this plan is not loaded. It was probably opened from a
              file saved without it.
            </p>
          ) : null}

          <Field
            label="Scale"
            value={
              isCalibrated(background)
                ? `${formatLength(backgroundExtentMm(background).width, unit)} wide`
                : 'Not calibrated'
            }
          />
          <Field label="Source" value={`${background.pixelSize.width} × ${background.pixelSize.height} px`} />

          <label className="field field--input">
            <span className="field__label">Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(background.opacity * 100)}
              aria-label="Background opacity"
              data-testid="background-opacity"
              onChange={(e) => setBackgroundOpacity(Number(e.target.value) / 100)}
            />
          </label>

          <label className="field field--input">
            <span className="field__label">Locked</span>
            <input
              type="checkbox"
              checked={background.locked}
              aria-label="Lock the floor plan in place"
              data-testid="background-locked"
              onChange={(e) => setBackgroundLocked(e.target.checked)}
            />
          </label>

          <div className="panel__row">
            <button type="button" className="btn" onClick={() => nudgeBackgroundRotation(-0.5)}>
              Rotate −0.5°
            </button>
            <button type="button" className="btn" onClick={() => nudgeBackgroundRotation(0.5)}>
              Rotate +0.5°
            </button>
          </div>

          <div className="panel__row">
            <button
              type="button"
              className="btn"
              data-testid="recalibrate"
              onClick={() => useStore.getState().beginCalibration()}
            >
              Recalibrate
            </button>
            <button type="button" className="btn btn--danger" onClick={() => removeBackground()}>
              Remove plan
            </button>
          </div>
        </div>
      ) : null}

      <h2 className="panel__heading">Validation</h2>
      {blocked ? (
        <p className="panel__warn" role="alert" data-testid="placement-blocked">
          {blocked}
        </p>
      ) : (
        <p className="panel__empty">
          No issues. Overlap, headroom and clearance checks arrive with the inventory
          in phase 4.
        </p>
      )}
    </aside>
  );
}
