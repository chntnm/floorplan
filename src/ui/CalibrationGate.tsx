import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CalibrationError, effectiveMmPerPx, isCalibrated } from '../core/calibration';
import { distance } from '../core/geometry/vec';
import { formatLength, parseLength } from '../core/units';
import { commitCalibration, removeBackground } from '../state/actions';
import { activeFloor, useStore } from '../state/store';

/**
 * The calibration gate. PLAN.md calls this "the single most important step in the
 * application", and it is the reason this is a gate rather than a settings field.
 *
 * A floor plan raster carries no scale. Trace one without calibrating and every wall
 * comes out a plausible-looking wrong length — the failure mode that survives all the
 * way to somebody ordering a sofa that does not fit. So until a scale exists the
 * tools are unavailable, and there are exactly two ways out: give it one, or discard
 * the plan.
 *
 * It is *not* a modal over the canvas, because the gesture it asks for happens on the
 * canvas. The stage stays live and takes only the reference drag; everything else is
 * disabled. Re-openable later from the properties panel, because people do get the
 * first attempt wrong.
 */
export function CalibrationGate() {
  const { calibrating, calibrationRef, doc } = useStore(
    useShallow((s) => ({
      calibrating: s.calibrating,
      calibrationRef: s.calibrationRef,
      doc: s.doc,
    })),
  );

  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const floor = activeFloor({ doc });
  const background = floor.background;
  const first = !isCalibrated(background);

  // A fresh line is a fresh attempt: clearing the entry stops a rejected length from
  // sitting in the box looking like it was accepted.
  useEffect(() => {
    setError(null);
  }, [calibrationRef]);

  if (!calibrating || !background) return null;

  const lengthMm = calibrationRef ? distance(calibrationRef.a, calibrationRef.b) : 0;

  const onSubmit = () => {
    if (!calibrationRef) return;
    const realLengthMm = parseLength(text, doc.displayUnit);
    if (realLengthMm === null) {
      setError('Enter a length — 3m, 10ft, 3000, 9′ 10″ all work.');
      return;
    }
    try {
      commitCalibration(calibrationRef.a, calibrationRef.b, realLengthMm);
      useStore.getState().endCalibration();
      setText('');
    } catch (err) {
      setError(
        err instanceof CalibrationError ? err.message : 'That scale could not be applied.',
      );
    }
  };

  const onCancel = () => {
    // Backing out of a *first* calibration discards the import: keeping an
    // uncalibrated plan around would leave the document permanently unable to accept
    // placements, with no obvious way to see why. Backing out of a recalibration
    // just leaves the existing scale alone.
    if (first) removeBackground();
    useStore.getState().endCalibration();
    setText('');
  };

  return (
    <div className="gate" role="dialog" aria-label="Calibrate floor plan" data-testid="calibration-gate">
      <div className="gate__head">
        <h2 className="gate__title">{first ? 'Set the scale' : 'Recalibrate'}</h2>
        <p className="gate__sub">
          Drag a line across something you know the real size of — a stated room width,
          a doorway, a printed scale bar — then type that length.
        </p>
      </div>

      {/*
        Always rendered, disabled until a line exists, because the gate's height must
        not change while the user is drawing on the canvas below it. An earlier
        version swapped a one-line prompt for this row on mousedown; the band grew,
        the stage shifted down under the pointer, and the line committed was not the
        line drawn — a 3000mm reference came out 3048mm and every dimension traced
        afterwards inherited the error.
      */}
      <div className="gate__form">
        <span className="gate__ref" data-testid={calibrationRef ? 'calibration-ref' : 'calibration-prompt'}>
          {calibrationRef ? formatLength(lengthMm, doc.displayUnit) : 'Drag a line…'}
        </span>
        <label className="gate__field">
          <span>is really</span>
          <input
            data-testid="calibration-length"
            aria-label="Real length of the reference line"
            disabled={!calibrationRef}
            value={text}
            placeholder={doc.displayUnit === 'ft-in' ? "10' 0\"" : '3m'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit();
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!calibrationRef}
          onClick={onSubmit}
        >
          Set scale
        </button>
        <button
          type="button"
          className="btn"
          disabled={!calibrationRef}
          onClick={() => useStore.getState().setCalibrationRef(null)}
        >
          Redraw
        </button>
      </div>

      {/* Reserved whether or not there is an error, for the same reason. */}
      <p className="gate__error" role="alert" data-testid="calibration-error" data-empty={!error}>
        {error ?? ''}
      </p>

      <div className="gate__foot">
        {/* Static text. The measured length belongs in the fixed-width slot above,
            not here: a string that grows once a line is drawn can rewrap this row
            and change the gate's height while the pointer is still down. */}
        <span className="gate__scale" data-testid="calibration-current">
          {isCalibrated(background)
            ? `Scale ${effectiveMmPerPx(background).toFixed(2)} mm per pixel`
            : 'Not calibrated'}
        </span>
        <button type="button" className="btn btn--danger" onClick={onCancel}>
          {first ? 'Discard plan' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
