/**
 * What to do with an autosave found at startup. See PLAN.md §5.
 *
 * §5 says "if an autosave is newer than the opened file, offer recovery", which
 * answers the easy half. The case that actually matters after a crash is the one it
 * does not describe: **there is no opened file**. The tab died with an hour of drawing
 * in it, the page comes back on a fresh empty document, and the autosave belongs to a
 * document id the new session has never heard of.
 *
 * So there are two offers, and they are distinguished because they are not equally
 * safe:
 *
 * - `newer` — an autosave for *this* document, holding a later edit than the file
 *   that was opened. Comparison is on the document's own `modifiedAt`, not on when
 *   the autosave ran: the question is which state is further along, not which write
 *   happened last.
 * - `orphan` — the current document is untouched, so there is nothing to lose, and an
 *   autosave for some other document exists. The most recently written one is offered.
 *
 * ## Why this is not noisy
 *
 * An autosave record is **deleted the moment its document is saved to a file**. A
 * record surviving therefore means one thing: that document had unsaved changes when
 * the tab went away. Without that rule every clean reload would greet you with an
 * offer to recover work you had already saved, and the prompt would be trained out of
 * you long before the one time it mattered.
 *
 * Pure — no IndexedDB, no store. The database lives in `state/autosave-db.ts`.
 */

import type { Id, SpaceDocument } from './document';

/** The metadata a recovery decision needs. The document bytes are not required. */
export type AutosaveSummary = {
  documentId: Id;
  title: string;
  /** When the autosave was written. */
  savedAt: string;
  /** The document's own `modifiedAt` at that moment. */
  modifiedAt: string;
};

export type RecoveryReason = 'newer' | 'orphan';

export type RecoveryOffer = {
  record: AutosaveSummary;
  reason: RecoveryReason;
};

/**
 * Whether a document holds nothing a person put there.
 *
 * The test for "safe to replace without asking twice". Deliberately structural rather
 * than `dirty`: a fresh document is not dirty either, and a document can be
 * un-dirtied by saving while plainly holding an apartment. Title and grid are not
 * counted — renaming an empty space is not work worth protecting, and the alternative
 * is refusing to offer recovery to someone who typed a name before the crash.
 */
export function isUntouched(doc: SpaceDocument): boolean {
  if (doc.catalog.length > 0) return false;
  if (doc.assets.length > 0) return false;
  if (doc.savedViews.length > 0) return false;

  return doc.floors.every(
    (f) =>
      f.walls.length === 0 &&
      f.rooms.length === 0 &&
      f.placements.length === 0 &&
      f.openings.length === 0 &&
      f.background === undefined,
  );
}

function time(iso: string): number {
  const t = Date.parse(iso);
  // An unparseable timestamp sorts oldest rather than throwing. A corrupt record
  // should cost you a recovery offer, not the ability to open the app.
  return Number.isNaN(t) ? -Infinity : t;
}

/** The most recently written record, or undefined. */
function mostRecent(records: readonly AutosaveSummary[]): AutosaveSummary | undefined {
  return [...records].sort((a, b) => time(b.savedAt) - time(a.savedAt))[0];
}

/**
 * Decide whether to offer a recovery, and which one.
 *
 * `dirty` short-circuits everything: if the session already has unsaved changes, this
 * is not a startup, and a prompt whose accept path replaces the open document would
 * be offering to destroy the very work it claims to protect.
 */
export function chooseRecovery(
  records: readonly AutosaveSummary[],
  current: SpaceDocument,
  opts: { dirty: boolean },
): RecoveryOffer | null {
  if (opts.dirty) return null;
  if (records.length === 0) return null;

  const mine = records.filter((r) => r.documentId === current.id);
  const ahead = mostRecent(mine.filter((r) => time(r.modifiedAt) > time(current.modifiedAt)));
  if (ahead) return { record: ahead, reason: 'newer' };

  // Someone else's document, and nothing here to lose by offering it.
  if (!isUntouched(current)) return null;
  const orphan = mostRecent(records.filter((r) => r.documentId !== current.id));
  return orphan ? { record: orphan, reason: 'orphan' } : null;
}

/** The sentence the recovery prompt shows. */
export function recoveryMessage(offer: RecoveryOffer): string {
  const when = new Date(offer.record.savedAt);
  const stamp = Number.isNaN(when.getTime()) ? 'earlier' : when.toLocaleString();

  return offer.reason === 'newer'
    ? `This space has unsaved changes from ${stamp} that are newer than the file you opened.`
    : `“${offer.record.title}” has unsaved changes from ${stamp} that were never saved to a file.`;
}
