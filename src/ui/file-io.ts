/**
 * Saving and opening `.space` files. See PLAN.md §5.
 *
 * Two ways out, one pipeline. The bytes are built identically for both — document,
 * assets, thumbnail — and only the last step differs: a retained File System Access
 * handle where the browser has one, an anchor and a blob URL where it does not.
 *
 * The download path is not a degraded mode to apologise for. It is what Firefox and
 * Safari get, it proved the portability requirement end to end through phases 3 to 8,
 * and it is still the fallback when a retained handle has lost permission.
 */

import { readSpace, writeSpace, SpaceFileError, type SpaceBundle } from '../core/space-file';
import type { SpaceDocument } from '../core/document';
import { assetMapFor } from '../state/assets';
import {
  SaveCancelled,
  currentTarget,
  ensureWritable,
  pickSaveTarget,
  setSaveTarget,
  supportsSaveInPlace,
  writeToTarget,
  type SaveHandle,
} from '../state/save-target';
import { renderThumbnail } from './thumbnail';

export const SPACE_EXTENSION = '.space';

export type SaveOutcome =
  | { kind: 'in-place'; name: string }
  | { kind: 'download'; name: string }
  | { kind: 'cancelled' };

/** A filesystem-safe filename derived from the document title. */
export function fileNameFor(doc: SpaceDocument): string {
  const base = doc.title.trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-') || 'untitled';
  return `${base}${SPACE_EXTENSION}`;
}

/**
 * The container bytes, thumbnail included.
 *
 * Asset bytes come from the runtime store, not from the document — the document
 * carries only the manifest. `assetMapFor` throws rather than writing a container
 * short of a file the document references, because that produces a `.space` which
 * opens with a blank background on the recipient's machine, which is the one failure
 * this format exists to prevent.
 */
export async function buildSpaceBytes(
  doc: SpaceDocument,
  appVersion?: string,
): Promise<Uint8Array> {
  let assets;
  try {
    assets = assetMapFor(doc);
  } catch (err) {
    throw new SpaceFileError(err instanceof Error ? err.message : 'Could not collect this space.');
  }

  // A thumbnail is a convenience for other people's file browsers and never a reason
  // to fail a save — `renderThumbnail` returns undefined rather than throwing, and
  // `writeSpace` treats the entry as optional.
  const thumbnail = await renderThumbnail(doc);
  const bundle: SpaceBundle = thumbnail
    ? { document: doc, assets, thumbnail }
    : { document: doc, assets };

  return writeSpace(bundle, appVersion);
}

function download(doc: SpaceDocument, bytes: Uint8Array): void {
  // `bytes.buffer` may be a pooled ArrayBuffer larger than the data; slice to the
  // exact range so the blob is not padded with whatever followed it.
  const blob = new Blob([bytes.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);

  const a = globalThis.document.createElement('a');
  a.href = url;
  a.download = fileNameFor(doc);
  a.style.display = 'none';
  globalThis.document.body.appendChild(a);
  a.click();
  a.remove();

  // Revoking synchronously can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Save, in place where the browser allows it.
 *
 * `chooseTarget` forces the picker — "Save as…". Without it a document that already
 * has a target writes straight to it, which is the entire point of holding the handle.
 *
 * Cancelling is a decision, not a failure: it returns `cancelled`, the caller shows
 * nothing, and the document stays dirty because it genuinely was not saved. Nothing
 * here marks the document clean — that is the caller's job and only on a resolved
 * write, or a dismissed dialog would quietly clear the dirty flag.
 */
export async function saveDocument(
  doc: SpaceDocument,
  options: { chooseTarget?: boolean } = {},
): Promise<SaveOutcome> {
  const bytes = await buildSpaceBytes(doc);

  if (supportsSaveInPlace()) {
    let handle: SaveHandle | null = options.chooseTarget ? null : currentTarget();
    if (!handle) {
      try {
        handle = await pickSaveTarget(fileNameFor(doc));
      } catch (err) {
        if (err instanceof SaveCancelled) return { kind: 'cancelled' };
        throw err;
      }
    }

    // Permission can be revoked between sessions or from the omnibox mid-session.
    // Refusing it drops to a download rather than failing: the work still lands
    // somewhere the user can find it, which is what saving is for.
    if (await ensureWritable(handle)) {
      await writeToTarget(handle, bytes);
      setSaveTarget(handle);
      return { kind: 'in-place', name: handle.name };
    }
  }

  download(doc, bytes);
  return { kind: 'download', name: fileNameFor(doc) };
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
