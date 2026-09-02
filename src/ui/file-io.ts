/**
 * Saving and opening `.space` files.
 *
 * Phase 2 uses a download and a file input — universally supported, and enough to
 * prove the portability requirement end to end: draw, save, reload the page, open,
 * get the same space back. Save-in-place through the File System Access API and
 * IndexedDB autosave are phase 9.
 */

import { readSpace, writeSpace, SpaceFileError } from '../core/space-file';
import type { SpaceDocument } from '../core/document';

export const SPACE_EXTENSION = '.space';

/** A filesystem-safe filename derived from the document title. */
export function fileNameFor(doc: SpaceDocument): string {
  const base = doc.title.trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-') || 'untitled';
  return `${base}${SPACE_EXTENSION}`;
}

export function saveDocument(doc: SpaceDocument, appVersion?: string): void {
  // Nothing creates assets yet, so there is nowhere to read their bytes from. The
  // moment PDF import lands in phase 3 this becomes reachable, and writing `{}` would
  // silently produce a file that reopens with a background pointing at an image that
  // is not in it — the same hole `writeSpaceJson` already refuses. Fail loudly here
  // instead, and wire the real asset store when phase 3 creates one.
  if (doc.assets.length > 0) {
    throw new SpaceFileError(
      `Saving assets is not implemented yet: this space references ${doc.assets.length} ` +
        `file(s) that would be lost. (Phase 3 wires the asset store.)`,
    );
  }

  const bytes = writeSpace({ document: doc, assets: {} }, appVersion);

  // `bytes.buffer` may be a pooled ArrayBuffer larger than the data; slice to the
  // exact range so the blob is not padded with whatever followed it.
  const blob = new Blob([bytes.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(doc);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoking synchronously can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function openDocumentFile(file: File): Promise<SpaceDocument> {
  const buffer = await file.arrayBuffer();
  try {
    return readSpace(new Uint8Array(buffer)).document;
  } catch (err) {
    if (err instanceof SpaceFileError) throw err;
    throw new SpaceFileError(`Could not open ${file.name}.`);
  }
}
