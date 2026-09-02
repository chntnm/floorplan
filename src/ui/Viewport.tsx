import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { PlanStage } from './plan/PlanStage';
import { StatusBar } from './StatusBar';
import { ToolPalette } from './ToolPalette';

/**
 * The viewport frame: tool palette, renderer, status line.
 *
 *   plan2d  -> the Konva stage
 *   space3d -> the three.js scene, phase 5
 *
 * Both read the same document; neither is authoritative.
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
          <PlanStage />
          <StatusBar />
        </>
      ) : (
        <div className="viewport__placeholder">
          <p className="viewport__title">Space view</p>
          <p className="viewport__sub">three.js scene, arrow-key traversal — phase 5</p>
        </div>
      )}
    </main>
  );
}
