import { useEffect, useState } from 'react';
import { acceptFile } from './file-actions';
import { useStore } from '../state/store';

/**
 * Drag a file anywhere onto the window. See PLAN.md §5.
 *
 * Listeners go on `window`, not on a div: the point is that there is no target to
 * aim at. The overlay is feedback, not a hit area, and is `pointer-events: none` so
 * it cannot become one — an overlay that swallowed the drop would make the feature
 * work only where it was not covering anything.
 *
 * ## Why `dragover` must call `preventDefault`
 *
 * Without it the browser treats the page as a non-drop-target and navigates to the
 * file instead, discarding the open document with no prompt. The default behaviour of
 * a drop is the destructive one, which is worth stating because the two lines that
 * prevent it look like ceremony.
 *
 * Drops are ignored while the calibration gate is open. That gate is modal for a
 * reason — a background with no scale accepts nothing — and letting a drop replace
 * the very file being calibrated would leave the modal describing something else.
 */
export function DropZone() {
  const [over, setOver] = useState(false);
  const calibrating = useStore((s) => s.calibrating);

  useEffect(() => {
    if (calibrating) {
      setOver(false);
      return;
    }

    // `dragenter`/`dragleave` fire per element crossed, so a naive pair flickers the
    // overlay on every child boundary. Counting entries against leaves is the usual
    // fix; `relatedTarget === null` is the cheaper one — it is the only leave that
    // means the pointer actually left the window.
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer.files.item(0);
      // One file. A multi-file drop of two floor plans has no meaning this
      // application can act on, and picking the first silently is at least legible.
      if (file) void acceptFile(file);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [calibrating]);

  if (!over) return null;

  return (
    <div className="dropzone" data-testid="drop-overlay" aria-hidden="true">
      <span className="dropzone__label">Drop a .space file, a PDF or an image</span>
    </div>
  );
}
