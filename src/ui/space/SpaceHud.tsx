import { useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CAMERA_MODES, CAMERA_MODE_LABELS } from '../../core/walk';
import { spaceViews, type SpaceCamera } from '../../core/views';
import { roomAt } from '../../core/placement';
import { formatLength } from '../../core/units';
import { activeFloor, useStore } from '../../state/store';
import { addSavedView, removeSavedView } from '../../state/actions';

/** Per mode, the keys worth knowing. Shown rather than hidden behind a help icon. */
const HELP: Record<string, string> = {
  orbit: 'Drag to orbit · scroll to zoom · Tab for walk mode',
  walk: '↑↓ walk · ←→ turn · A/D strafe · Shift run · C crouch · Space step up · drag to look',
  fly: '↑↓ fly · ←→ turn · R/F up and down · no collision · Tab to return to orbit',
};

/**
 * The heads-up display over the 3D view.
 *
 * Plain DOM, and outside the WebGL error boundary on purpose. It reads the walker
 * from the store rather than from the camera, so where you are standing is legible —
 * and assertable in a test — whether or not a canvas ever came up. That is the same
 * reasoning as the status bar under the plan: a renderer that draws to a bitmap needs
 * a surface where its state becomes readable.
 */
export function SpaceHud({ poseRef }: { poseRef: RefObject<SpaceCamera | null> }) {
  const { doc, cameraMode, walker, showCeilings } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      cameraMode: s.cameraMode,
      walker: s.walker,
      showCeilings: s.showCeilings,
    })),
  );
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const floor = activeFloor({ doc });
  const unit = doc.displayUnit;
  const views = spaceViews(doc.savedViews);
  const room = walker ? roomAt(floor, walker.position) : undefined;

  const save = () => {
    // The camera pose if there is a renderer to ask, and the walker's own if there is
    // not — a bookmark should not be a thing you can only make when WebGL works.
    const pose: SpaceCamera | null =
      poseRef.current ??
      (walker
        ? {
            position: { x: walker.position.x, y: walker.position.y, z: 1650 },
            target: { x: walker.position.x, y: walker.position.y - 1000, z: 1650 },
            mode: cameraMode,
          }
        : null);
    if (!pose) return;

    addSavedView(name || (room ? room.name : 'View'), pose);
    setName('');
    setNaming(false);
  };

  return (
    <div className="hud">
      <div className="hud__row" role="group" aria-label="Camera mode">
        {CAMERA_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="seg"
            data-active={mode === cameraMode}
            aria-pressed={mode === cameraMode}
            data-testid={`camera-${mode}`}
            onClick={() => useStore.getState().setCameraMode(mode)}
          >
            {CAMERA_MODE_LABELS[mode]}
          </button>
        ))}
        <button
          type="button"
          className="seg"
          data-active={showCeilings}
          aria-pressed={showCeilings}
          title="Ceilings are hidden by default so you can see into the space"
          onClick={() => useStore.getState().setShowCeilings(!showCeilings)}
        >
          Ceilings
        </button>
      </div>

      <div className="hud__row hud__row--readout">
        <span data-testid="walker-readout">
          {walker
            ? `${formatLength(Math.round(walker.position.x), unit)}, ${formatLength(
                Math.round(walker.position.y),
                unit,
              )}`
            : 'Not placed'}
        </span>
        <span data-testid="walker-room">{room ? room.name : 'Unbounded'}</span>
        {walker && walker.elevation > 0 ? (
          <span data-testid="walker-elevation">
            standing on {formatLength(walker.elevation, unit)}
          </span>
        ) : null}
        {walker?.crouching ? <span data-testid="walker-crouching">crouching</span> : null}
      </div>

      <div className="hud__row hud__row--views">
        {views.map((view) => (
          <span key={view.id} className="hud__view">
            <button
              type="button"
              className="seg seg--small"
              onClick={() => useStore.getState().applySavedView(view)}
            >
              {view.name}
            </button>
            <button
              type="button"
              className="seg seg--small"
              aria-label={`Remove view ${view.name}`}
              onClick={() => removeSavedView(view.id)}
            >
              ×
            </button>
          </span>
        ))}

        {naming ? (
          <>
            <input
              autoFocus
              value={name}
              aria-label="Name for this view"
              placeholder={room ? room.name : 'View'}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setNaming(false);
              }}
            />
            <button type="button" className="seg seg--small" data-testid="confirm-view" onClick={save}>
              Save view
            </button>
          </>
        ) : (
          <button
            type="button"
            className="seg seg--small"
            data-testid="save-view"
            onClick={() => setNaming(true)}
          >
            Save this view
          </button>
        )}
      </div>

      <p className="hud__help" data-testid="hud-help">
        {HELP[cameraMode]}
      </p>
    </div>
  );
}
