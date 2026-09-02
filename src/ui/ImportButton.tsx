import { useRef, useState } from 'react';
import { IMPORT_ACCEPT } from '../core/media';
import { attachPlan, inspectFile, type Inspection } from './import/plan-import';
import { useStore } from '../state/store';

/**
 * "Import plan" — the entry point to PLAN.md §6.1.
 *
 * The page picker only appears for a multi-page PDF. Asking which page to use when
 * there is exactly one is a dialog whose only correct answer is the one already
 * selected, and every user has to dismiss it.
 */
export function ImportButton({ disabled }: { disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Inspection | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) => {
    window.alert(err instanceof Error ? err.message : 'That file could not be imported.');
  };

  const onPick = async (file: File) => {
    setBusy(true);
    try {
      const inspection = await inspectFile(file);
      if (inspection.kind === 'pdf' && inspection.pageCount > 1) {
        setPage(1);
        setPending(inspection);
        return;
      }
      await attachPlan(inspection);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const onConfirmPage = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await attachPlan(pending, page - 1);
      setPending(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="seg"
        disabled={disabled || busy}
        title="Import a floor plan (PDF or image)"
        onClick={() => input.current?.click()}
      >
        {busy ? 'Importing…' : 'Import plan'}
      </button>
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        className="visually-hidden"
        aria-label="Import a floor plan"
        data-testid="import-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Clear the input so picking the same file again fires change.
          e.target.value = '';
          if (file) void onPick(file);
        }}
      />

      {pending?.kind === 'pdf' ? (
        <div className="pagepick" role="dialog" aria-label="Choose a page" data-testid="page-picker">
          <span className="pagepick__label">
            {pending.fileName} has {pending.pageCount} pages. Trace which one?
          </span>
          <input
            type="number"
            min={1}
            max={pending.pageCount}
            value={page}
            aria-label="Page number"
            data-testid="page-number"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setPage(Math.min(pending.pageCount, Math.max(1, Math.round(n))));
            }}
          />
          <button type="button" className="btn btn--primary" disabled={busy} onClick={onConfirmPage}>
            {busy ? 'Rendering…' : 'Import page'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setPending(null);
              // Nothing was attached, so nothing needs undoing — the gate never opened.
              useStore.getState().endCalibration();
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}
