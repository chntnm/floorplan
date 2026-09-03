import { useEffect, useRef, useState } from 'react';
import { chooseRecovery, recoveryMessage, type RecoveryOffer } from '../core/recovery';
import { dropAutosave, listAutosaves, readAutosave } from '../state/autosave-db';
import { useStore } from '../state/store';

/**
 * "There is unsaved work in the database." See PLAN.md §5.
 *
 * Asked exactly once, at startup, and never again for the life of the page — an offer
 * that reappeared after you dismissed it would be a nag, and one that appeared
 * mid-session would be describing a database this session is itself writing to.
 *
 * Both buttons are terminal and both are safe. **Restore** replaces the open document,
 * which is why `chooseRecovery` refuses to offer when there is anything here to lose.
 * **Discard** deletes the record, because a recovery offer that can be dismissed
 * without resolving is one you dismiss forever.
 */
export function RecoveryBanner() {
  const [offer, setOffer] = useState<RecoveryOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    // StrictMode mounts effects twice in development; asking twice would race two
    // reads of the same database and could show the banner after it was dismissed.
    if (asked.current) return;
    asked.current = true;

    void (async () => {
      const records = await listAutosaves();
      const { doc, dirty } = useStore.getState();
      setOffer(chooseRecovery(records, doc, { dirty }));
    })();
  }, []);

  if (!offer) return null;

  const restore = async () => {
    setBusy(true);
    try {
      const found = await readAutosave(offer.record.documentId);
      if (!found) {
        // The record went away underneath us — another tab recovered or saved it.
        // Nothing to say: the work is not lost, it is just not ours to restore.
        setOffer(null);
        return;
      }
      // `dirty: true` — a recovered document has never been written to a file, and
      // letting it open clean would let the user close the tab a second time on the
      // same unsaved work.
      useStore.getState().loadDocument(found.document, found.assets, { dirty: true });
      useStore.getState().zoomToFit();
      setOffer(null);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await dropAutosave(offer.record.documentId);
      setOffer(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="recovery" role="alertdialog" aria-label="Recover unsaved work" data-testid="recovery-banner">
      <span className="recovery__text">{recoveryMessage(offer)}</span>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        data-testid="recovery-restore"
        onClick={() => void restore()}
      >
        Restore
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        data-testid="recovery-discard"
        onClick={() => void discard()}
      >
        Discard
      </button>
    </div>
  );
}
