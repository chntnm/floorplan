import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { structureIsEditable } from '../core/modes';
import { formatArea, formatLength } from '../core/units';
import { wallAngleDeg, wallLength } from '../core/geometry/wall';
import { activeFloor, useStore } from '../state/store';
import {
  deleteSelection,
  nudgeBackgroundRotation,
  setCeilingDrop,
  setPlacementMount,
  updateOpening,
  removeBackground,
  rotatePlacementBy,
  setBackgroundLocked,
  setBackgroundOpacity,
  setPlacementElevation,
  setRoomName,
} from '../state/actions';
import { findItem, type Floor, type SpaceDocument } from '../core/document';
import { resolveElevation, roomAt, surfaceHeight } from '../core/placement';
import { ROTATION_STEP_DEG } from '../core/placement-snap';
import { validateFloor, type Issue } from '../core/validation';
import { backgroundExtentMm, isCalibrated } from '../core/calibration';
import {
  OPENING_KINDS,
  OPENING_KIND_LABELS,
  OPENING_DEFAULTS,
  openingRange,
  openingSpan,
} from '../core/openings';
import { hasAsset } from '../state/assets';
import { LengthInput } from './LengthField';
import type { MountKind, OpeningKind } from '../core/document';

const MOUNT_LABELS: Record<string, string> = {
  floor: 'On the floor',
  surface: 'On a surface',
  wall: 'Wall-mounted',
  ceiling: 'Hanging',
};

function hostName(doc: SpaceDocument, floor: Floor, hostId: string): string {
  const host = floor.placements.find((p) => p.id === hostId);
  const item = host ? findItem(doc, host.itemId) : undefined;
  return item?.name ?? 'something that is gone';
}

/** Select what an issue points at, so the panel is a way to find the problem. */
function selectIssue(issue: Issue): void {
  useStore.getState().setSelection(issue.refs.map((ref) => ({ kind: ref.kind, id: ref.id })));
}

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

  const wall = only?.kind === 'wall' ? floor.walls.find((w) => w.id === only.id) : undefined;
  const room = only?.kind === 'room' ? floor.rooms.find((r) => r.id === only.id) : undefined;
  const opening =
    only?.kind === 'opening' ? floor.openings.find((o) => o.id === only.id) : undefined;
  const openingWall = opening ? floor.walls.find((w) => w.id === opening.wallId) : undefined;
  const placement =
    only?.kind === 'placement' ? floor.placements.find((p) => p.id === only.id) : undefined;
  const placementItem = placement ? findItem(doc, placement.itemId) : undefined;
  const issues = validateFloor(doc, floor);

  // Held locally while typing so a rename is one undo step, not one per keystroke.
  const [draftName, setDraftName] = useState(room?.name ?? '');
  const [mountError, setMountError] = useState<string | null>(null);
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

      {opening ? (
        <div data-testid="opening-properties">
          <label className="field field--input">
            <span className="field__label">Kind</span>
            <select
              value={opening.kind}
              aria-label="Opening kind"
              onChange={(e) => {
                // Changing kind re-sizes to that kind's standard, unless the opening
                // has already been sized by hand — a door resized to 900 should not
                // silently snap back to 813 because it became a pocket door.
                const next = e.target.value as OpeningKind;
                const current = OPENING_DEFAULTS[opening.kind];
                const custom =
                  opening.widthMm !== current.widthMm ||
                  opening.heightMm !== current.heightMm ||
                  opening.sillMm !== current.sillMm;
                updateOpening(opening.id, custom ? { kind: next } : { kind: next, ...OPENING_DEFAULTS[next] });
              }}
            >
              {OPENING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {OPENING_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          <LengthInput
            label="Width"
            valueMm={opening.widthMm}
            unit={unit}
            onCommit={(mm) => updateOpening(opening.id, { widthMm: mm })}
            testId="opening-width"
          />
          <LengthInput
            label="Height"
            valueMm={opening.heightMm}
            unit={unit}
            onCommit={(mm) => updateOpening(opening.id, { heightMm: mm })}
          />
          <LengthInput
            label="Sill"
            valueMm={opening.sillMm}
            unit={unit}
            onCommit={(mm) => updateOpening(opening.id, { sillMm: mm })}
          />
          {/* Position along the wall, measured from its first end — the coordinate
              `offsetMm` is actually stored in, so the number here is the number in
              the file. */}
          <LengthInput
            label="From wall start"
            valueMm={opening.offsetMm}
            unit={unit}
            onCommit={(mm) => updateOpening(opening.id, { offsetMm: mm })}
          />
          <Field
            label="Wall"
            value={
              openingWall
                ? `${formatLength(wallLength(openingWall), unit)} long`
                : 'missing'
            }
          />
          {/* Head height — sill plus height. The number that decides whether you
              can walk under it, and the one that is easiest to get wrong by editing
              the sill of a window without touching its height. */}
          <Field label="Head" value={formatLength(openingSpan(opening).top, unit)} />
          <Field
            label="Ends at"
            value={formatLength(openingRange(opening).to, unit)}
          />
        </div>
      ) : null}

      {placement && placementItem ? (
        <div data-testid="placement-properties">
          <Field label="Item" value={placementItem.name} />
          <Field
            label="Size"
            value={`${formatLength(placementItem.widthMm, unit)} x ${formatLength(
              placementItem.depthMm,
              unit,
            )} x ${formatLength(placementItem.heightMm, unit)}`}
          />
          <Field
            label="Position"
            value={`${formatLength(placement.position.x, unit)}, ${formatLength(
              placement.position.y,
              unit,
            )}`}
          />
          <Field label="Room" value={roomAt(floor, placement.position)?.name ?? 'Unbounded'} />
          {/* Read back through `resolveElevation` rather than from the stored field:
              that field is only authoritative for floor and wall mounts, and a
              surface-mounted item takes its base from whatever it is sitting on. */}
          <Field label="Base" value={formatLength(resolveElevation(doc, placement), unit)} />
          <label className="field field--input">
            <span className="field__label">Mount</span>
            <select
              value={placement.mount.kind}
              aria-label="Mount"
              onChange={(e) => setMountError(setPlacementMount(placement.id, e.target.value as MountKind))}
            >
              <option value="floor">{MOUNT_LABELS.floor}</option>
              {/* A surface mount names a specific host, which is chosen by dragging
                  the item onto it — there is nothing sensible to pick from a list.
                  Shown as the current value, never as a destination. */}
              <option value="surface" disabled={placement.mount.kind !== 'surface'}>
                {MOUNT_LABELS.surface}
              </option>
              <option value="wall">{MOUNT_LABELS.wall}</option>
              <option value="ceiling">{MOUNT_LABELS.ceiling}</option>
            </select>
          </label>
          {mountError ? (
            <p className="panel__warn" role="alert" data-testid="mount-error">
              {mountError}
            </p>
          ) : null}
          {placement.mount.kind === 'surface' ? (
            <Field label="Sitting on" value={hostName(doc, floor, placement.mount.hostId)} />
          ) : null}
          {placement.mount.kind === 'wall' ? (
            <Field
              label="On wall"
              value={
                floor.walls.some((w) => placement.mount.kind === 'wall' && w.id === placement.mount.wallId)
                  ? 'yes'
                  : 'a wall that is gone'
              }
            />
          ) : null}

          <div className="panel__row panel__row--rotate">
            <button
              type="button"
              className="btn"
              aria-label="Rotate left"
              onClick={() => rotatePlacementBy(placement.id, -ROTATION_STEP_DEG)}
            >
              -{ROTATION_STEP_DEG}
            </button>
            <span className="field__value" data-testid="placement-rotation">
              {Math.round(placement.rotation)}&deg;
            </span>
            <button
              type="button"
              className="btn"
              aria-label="Rotate right"
              onClick={() => rotatePlacementBy(placement.id, ROTATION_STEP_DEG)}
            >
              +{ROTATION_STEP_DEG}
            </button>
          </div>

          {placement.mount.kind === 'wall' ? (
            <LengthInput
              label="Height above floor"
              valueMm={placement.elevation}
              unit={unit}
              onCommit={(mm) => setPlacementElevation(placement.id, mm)}
              testId="placement-elevation"
            />
          ) : null}

          {/* How far a pendant hangs below the ceiling. The base is derived from it
              rather than stored, which is why this edits the drop and the Base field
              above reads back through `resolveElevation`. */}
          {placement.mount.kind === 'ceiling' ? (
            <LengthInput
              label="Drop below ceiling"
              valueMm={placement.mount.drop}
              unit={unit}
              onCommit={(mm) => setCeilingDrop(placement.id, mm)}
              testId="placement-drop"
            />
          ) : null}

          {placementItem.canHostSurface ? (
            <p className="panel__note">
              Other items can sit on this, at{' '}
              {formatLength(surfaceHeight(placement, placementItem), unit)}.
            </p>
          ) : null}
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
      {issues.length === 0 ? (
        <p className="panel__empty" data-testid="no-issues">
          No issues. Clearance and door-swing checks arrive in phases 6 and 7.
        </p>
      ) : (
        <ul className="issues" data-testid="issue-list">
          {issues.map((issue, i) => (
            <li
              key={i}
              className="issue"
              data-severity={issue.severity}
              data-kind={issue.kind}
              data-testid={issue.kind === 'uncalibrated' ? 'placement-blocked' : 'issue'}
            >
              {/* Clicking an issue selects what it points at, so the panel is a way
                  to find the problem rather than only a way to hear about it. */}
              <button
                type="button"
                className="issue__button"
                disabled={issue.refs.length === 0}
                onClick={() => selectIssue(issue)}
              >
                {issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
