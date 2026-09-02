import { Suspense, lazy } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { CalibrationGate } from './CalibrationGate';
import { PlanStage } from './plan/PlanStage';
import { StatusBar } from './StatusBar';
import { ToolPalette } from './ToolPalette';

/**
 * three.js and drei are 900kB of the bundle, and most sessions never leave the plan.
 * Split out for the same reason pdfjs is: the editor should be interactive before a
 * renderer nobody has asked for has finished downloading.
 */
const SpaceView = lazy(() =>
  import('./space/SpaceView').then((m) => ({ default: m.SpaceView })),
);

/**
 * The viewport frame: tool palette, renderer, status line.
 *
 *   plan2d  -> the Konva stage
 *   space3d -> the three.js scene
 *
 * Both read the same document; neither is authoritative, and both derive their
 * geometry from the same core functions rather than keeping parallel scene state.
 */
export function Viewport() {
  const { editMode, viewMode } = useStore(
    useShallow((s) => ({ editMode: s.editMode, viewMode: s.viewMode })),
  );

  return (
    <main className="viewport" data-view={viewMode} data-edit={editMode}>
      {viewMode === 'plan2d' ? (
        <>
          <ToolPalette />
          <CalibrationGate />
          <PlanStage />
          <StatusBar />
        </>
      ) : (
        <Suspense
          fallback={
            <div className="viewport__placeholder">
              <p className="viewport__title">Space view</p>
              <p className="viewport__sub">Starting the renderer…</p>
            </div>
          }
        >
          <SpaceView />
        </Suspense>
      )}
    </main>
  );
}
