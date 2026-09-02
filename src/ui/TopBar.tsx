import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  EDIT_MODES,
  EDIT_MODE_LABELS,
  VIEW_MODES,
  VIEW_MODE_LABELS,
} from '../core/modes';
import { useStore } from '../state/store';
import { openDocumentFile, saveDocument, SPACE_EXTENSION } from './file-io';

export function TopBar() {
  const fileInput = useRef<HTMLInputElement>(null);

  const { doc, editMode, viewMode, dirty, canUndo, canRedo } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      editMode: s.editMode,
      viewMode: s.viewMode,
      dirty: s.dirty,
      canUndo: s.past.length > 0,
      canRedo: s.future.length > 0,
    })),
  );

  const onSave = () => {
    saveDocument(doc);
    useStore.getState().markSaved();
  };

  const onOpen = async (file: File) => {
    try {
      useStore.getState().loadDocument(await openDocumentFile(file));
      useStore.getState().zoomToFit();
    } catch (err) {
      // A bad file is the user's problem to fix, not a crash to swallow: say what
      // went wrong and leave the document they already have untouched.
      window.alert(err instanceof Error ? err.message : 'Could not open that file.');
    }
  };

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true" />
        <span className="topbar__title">roomplan</span>
        <span className="topbar__doc" data-testid="doc-title">
          {doc.title}
          {dirty ? ' •' : ''}
        </span>
      </div>

      <div className="topbar__group" role="group" aria-label="File">
        <button type="button" className="seg" onClick={() => useStore.getState().newDocument()}>
          New
        </button>
        <button type="button" className="seg" onClick={() => fileInput.current?.click()}>
          Open
        </button>
        <button type="button" className="seg" onClick={onSave}>
          Save
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={SPACE_EXTENSION}
          className="visually-hidden"
          aria-label="Open a .space file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clear the input so re-opening the same file fires change again.
            e.target.value = '';
            if (file) void onOpen(file);
          }}
        />
      </div>

      <div className="topbar__group" role="group" aria-label="History">
        <button
          type="button"
          className="seg"
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          onClick={() => useStore.getState().undo()}
        >
          Undo
        </button>
        <button
          type="button"
          className="seg"
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          onClick={() => useStore.getState().redo()}
        >
          Redo
        </button>
      </div>

      <div className="topbar__group" role="group" aria-label="Edit mode">
        {EDIT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="seg"
            data-active={mode === editMode}
            aria-pressed={mode === editMode}
            onClick={() => useStore.getState().setEditMode(mode)}
          >
            {EDIT_MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      <div className="topbar__group" role="group" aria-label="View">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="seg"
            data-active={mode === viewMode}
            aria-pressed={mode === viewMode}
            onClick={() => useStore.getState().setViewMode(mode)}
          >
            {VIEW_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
    </header>
  );
}
