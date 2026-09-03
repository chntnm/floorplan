import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  EDIT_MODES,
  EDIT_MODE_LABELS,
  VIEW_MODES,
  VIEW_MODE_LABELS,
} from '../core/modes';
import { orderedFloors } from '../core/floors';
import { useStore } from '../state/store';
import { renameDocument } from '../state/actions';
import { saveDocument, SPACE_EXTENSION } from './file-io';
import { openSpace } from './file-actions';
import { forgetAutosave } from '../state/autosave';
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

  const [saving, setSaving] = useState(false);
  // A ref, not the state above: the Ctrl+S handler is registered once and would
  // otherwise close over whatever `saving` was on the render that installed it.
  const inFlight = useRef(false);

  /**
   * Save, and only then say it is saved.
   *
   * Three outcomes, and they are not the same event. A write that resolves marks the
   * document clean and drops its autosave — that drop is what keeps the recovery
   * prompt meaningful. A **cancelled** picker does neither and shows nothing: the
   * user changed their mind, and a dialog saying so, or a cleared dirty flag, would
   * both be lies. Only a genuine failure gets an alert.
   */
  const onSave = async (chooseTarget = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      // Read the document at call time: the keyboard handler outlives this render.
      const current = useStore.getState().doc;
      const outcome = await saveDocument(current, { chooseTarget });
      if (outcome.kind === 'cancelled') return;
      useStore.getState().markSaved();
      forgetAutosave(current.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not save this space.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  // Ctrl+S lives here rather than in the plan stage because it has to work in the 3D
  // view too, where that stage is not mounted. Shift is "save as" — the only way back
  // to the picker once a handle is held.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      // Without this the browser's own "save page" dialog opens over the app.
      e.preventDefault();
      void onSave(e.shiftKey);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // Registered once. Everything it reads comes from `getState()` at fire time.
  }, []);

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
        <button
          type="button"
          className="seg"
          data-testid="save-file"
          disabled={saving}
          title="Save (Ctrl+S)"
          onClick={() => void onSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="seg"
          data-testid="save-file-as"
          disabled={saving}
          title="Save as… (Ctrl+Shift+S)"
          onClick={() => void onSave(true)}
        >
          Save as…
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
            if (file) void openSpace(file);
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

      {/* Switching floors is navigation, not a property, so it lives with the view
          controls rather than in the properties panel — where the floor's own name,
          elevation and ceiling are edited. */}
      <div className="topbar__group" role="group" aria-label="Floor">
        <select
          className="seg seg--select"
          aria-label="Active floor"
          data-testid="floor-picker"
          value={doc.activeFloorId}
          disabled={calibrating}
          onChange={(e) => useStore.getState().setActiveFloor(e.target.value)}
        >
          {/* Top of the list is the top of the building, the way a lift panel reads. */}
          {[...orderedFloors(doc)].reverse().map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
        </select>
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
