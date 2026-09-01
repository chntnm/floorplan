import { EDIT_MODE_LABELS, VIEW_MODE_LABELS, type EditMode, type ViewMode } from '../core/modes';

type Props = {
  editMode: EditMode;
  viewMode: ViewMode;
};

/**
 * Placeholder for the two renderers.
 *
 *   plan2d  → Konva <Stage> with a structure layer and a placement layer (phase 2)
 *   space3d → react-three-fiber <Canvas> with walk/orbit cameras (phase 5)
 *
 * Both read the same document; neither is authoritative.
 */
export function Viewport({ editMode, viewMode }: Props) {
  return (
    <main className="viewport" data-view={viewMode} data-edit={editMode}>
      <div className="viewport__placeholder">
        <p className="viewport__title">{VIEW_MODE_LABELS[viewMode]} view</p>
        <p className="viewport__sub">
          {viewMode === 'plan2d'
            ? 'Konva stage — phase 2'
            : 'three.js scene, arrow-key traversal — phase 5'}
        </p>
        <p className="viewport__mode">{EDIT_MODE_LABELS[editMode]}</p>
      </div>
    </main>
  );
}
