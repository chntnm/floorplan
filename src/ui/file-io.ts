/**
 * Saving and opening `.space` files.
 *
 * Phase 3 uses a download and a file input — universally supported, and enough to
 * prove the portability requirement end to end: import a plan, calibrate it, draw,
 * save, reload the page, open, and get the same space back with its background
 * intact. Save-in-place through the File System Access API and IndexedDB autosave
 * are phase 9.
 */

import { readSpace, writeSpace, SpaceFileError, type SpaceBundle } from '../core/space-file';
import type { SpaceDocument } from '../core/document';
import { assetMapFor } from '../state/assets';

export const SPACE_EXTENSION = '.space';

/** A filesystem-safe filename derived from the document title. */
export function fileNameFor(doc: SpaceDocument): string {
  const base = doc.title.trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-') || 'untitled';
  return `${base}${SPACE_EXTENSION}`;
}

export function saveDocument(doc: SpaceDocument, appVersion?: string): void {
  // Asset bytes come from the runtime store, not from the document — the document
  // carries only the manifest. `assetMapFor` throws rather than writing a container
  // short of a file the document references, because that produces a `.space` which
  // opens with a blank background on the recipient's machine, which is the one
  // failure this format exists to prevent.
  let assets;
  try {
    assets = assetMapFor(doc);
  } catch (err) {
    throw new SpaceFileError(err instanceof Error ? err.message : 'Could not collect this space.');
  }

  const bytes = writeSpace({ document: doc, assets }, appVersion);

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

/**
 * Read a `.space` file.
 *
 * Returns the whole bundle, not just the document: the caller has to hand the asset
 * bytes to the runtime store. An earlier version of this returned `.document` and
 * dropped `.assets` on the floor, which looked correct right up until a space with a
 * background was opened, saved and reopened with nothing behind the walls.
 */
export async function openDocumentFile(file: File): Promise<SpaceBundle> {
  const buffer = await file.arrayBuffer();
  try {
    return readSpace(new Uint8Array(buffer));
  } catch (err) {
    if (err instanceof SpaceFileError) throw err;
    throw new SpaceFileError(`Could not open ${file.name}.`);
  }
}
