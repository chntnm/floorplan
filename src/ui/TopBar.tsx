import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  EDIT_MODES,
  EDIT_MODE_LABELS,
  VIEW_MODES,
  VIEW_MODE_LABELS,
} from '../core/modes';
import { useStore } from '../state/store';
import { renameDocument } from '../state/actions';
import { openDocumentFile, saveDocument, SPACE_EXTENSION } from './file-io';
import { ImportButton } from './ImportButton';

export function TopBar() {
  const fileInput = useRef<HTMLInputElement>(null);

  const { doc, editMode, viewMode, dirty, canUndo, canRedo, calibrating } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      editMode: s.editMode,
      viewMode: s.viewMode,
      dirty: s.dirty,
      canUndo: s.past.length > 0,
      canRedo: s.future.length > 0,
      calibrating: s.calibrating,
    })),
  );

  // Held locally while typing so a rename is one undo step, not one per keystroke —
  // and so the filename a save produces is the one you actually named it.
  const [draftTitle, setDraftTitle] = useState(doc.title);
  useEffect(() => setDraftTitle(doc.title), [doc.id, doc.title]);

  const commitTitle = () => {
    const next = draftTitle.trim();
    if (next && next !== doc.title) renameDocument(next);
    else setDraftTitle(doc.title);
  };

  const onSave = () => {
    try {
      saveDocument(doc);
      useStore.getState().markSaved();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not save this space.');
    }
  };

  const onOpen = async (file: File) => {
    try {
      // The assets travel with the document into the runtime store; passing only
      // `.document` here is what made a reopened background render as nothing.
      const bundle = await openDocumentFile(file);
      useStore.getState().loadDocument(bundle.document, bundle.assets);
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
        <span className="topbar__title">floorplan</span>
        <input
          className="topbar__doc"
          data-testid="doc-title"
          aria-label="Space name"
          value={draftTitle}
          size={Math.max(12, draftTitle.length + 1)}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setDraftTitle(doc.title);
              e.currentTarget.blur();
            }
          }}
        />
        <span className="topbar__dirty" data-testid="dirty-flag">
          {dirty ? '•' : ''}
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
        <ImportButton disabled={calibrating} />
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
          disabled={!canUndo || calibrating}
          title="Undo (Ctrl+Z)"
          onClick={() => useStore.getState().undo()}
        >
          Undo
        </button>
        <button
          type="button"
          className="seg"
          disabled={!canRedo || calibrating}
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
            disabled={calibrating}
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
            disabled={calibrating}
            onClick={() => useStore.getState().setViewMode(mode)}
          >
            {VIEW_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
    </header>
  );
}
