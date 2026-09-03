/**
 * The runtime asset store.
 *
 * `SpaceDocument.assets` is a *manifest* — ids, paths, sizes. The bytes themselves
 * are not in the document, because putting megabytes of raster into the undo stack
 * would be absurd: immer would snapshot them on every mutation and a background
 * import would become the most expensive operation in the application.
 *
 * So the bytes live here, keyed by asset id, for exactly as long as the document is
 * open. Saving pulls them back out; opening puts them in. The document and this
 * store are two halves of one thing, which is why `loadDocument` and `newDocument`
 * reset both — a background that survived into the next document would be silently
 * written into that document's file.
 *
 * Object URLs are created lazily and revoked on reset. They are deliberately *not*
 * carried across a load: a `blob:` URL minted at import time looks correct until you
 * save, reload the page and reopen, at which point it points at nothing. Every URL
 * here is derived from bytes this store currently holds.
 */

import type { AssetRef, Id, SpaceDocument } from '../core/document';
import { assetPath, type ImportMime } from '../core/media';
import type { AssetMap } from '../core/space-file';

export type StoredAsset = {
  id: Id;
  path: string;
  mime: string;
  bytes: Uint8Array;
};

const store = new Map<Id, StoredAsset>();
const urls = new Map<Id, string>();

function canMintUrls(): boolean {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

/** Store bytes and return the manifest entry to put in the document. */
export function putAsset(params: {
  mime: ImportMime;
  bytes: Uint8Array;
  id?: Id;
}): AssetRef {
  const id = params.id ?? crypto.randomUUID();
  const path = assetPath(id, params.mime);
  store.set(id, { id, path, mime: params.mime, bytes: params.bytes });
  releaseUrl(id);
  return { id, path, mime: params.mime, bytes: params.bytes.byteLength };
}

export function getAsset(id: Id): StoredAsset | undefined {
  return store.get(id);
}

export function hasAsset(id: Id): boolean {
  return store.has(id);
}

/**
 * A URL the DOM can render this asset from, or `null` when the bytes are missing or
 * the environment has no `createObjectURL` (the node test environment).
 */
export function assetUrl(id: Id): string | null {
  const existing = urls.get(id);
  if (existing) return existing;

  const asset = store.get(id);
  if (!asset || !canMintUrls()) return null;

  // `bytes.buffer` may be a pooled ArrayBuffer larger than the data; slice to the
  // exact range so the blob is not padded with whatever followed it.
  const url = URL.createObjectURL(new Blob([asset.bytes.slice()], { type: asset.mime }));
  urls.set(id, url);
  return url;
}

function releaseUrl(id: Id): void {
  const url = urls.get(id);
  if (!url) return;
  if (canMintUrls()) URL.revokeObjectURL(url);
  urls.delete(id);
}

/** Drop everything. Called whenever the open document is replaced. */
export function clearAssets(): void {
  for (const id of [...urls.keys()]) releaseUrl(id);
  store.clear();
}

/**
 * Replace the store with the assets read out of a `.space` container.
 *
 * The container keys entries by path and the document keys them by id, so the
 * manifest is what joins them. An entry the container does not carry is skipped
 * rather than faked — `missingAssets` is how the UI finds out.
 */
export function adoptAssets(doc: SpaceDocument, assets: AssetMap): void {
  clearAssets();
  for (const ref of doc.assets) {
    const bytes = assets[ref.path];
    if (!bytes) continue;
    store.set(ref.id, { id: ref.id, path: ref.path, mime: ref.mime, bytes });
  }
}

/** Manifest entries whose bytes this store does not have. */
export function missingAssets(doc: SpaceDocument): AssetRef[] {
  return doc.assets.filter((ref) => !store.has(ref.id));
}

/**
 * The path-keyed map `writeSpace` wants.
 *
 * Throws when an asset is missing rather than writing a container short of a file
 * the document references: that produces a `.space` which opens with a blank
 * background on somebody else's machine, and it is the exact silent loss the format
 * exists to prevent.
 */
export function assetMapFor(doc: SpaceDocument): AssetMap {
  const map: AssetMap = {};
  const missing: string[] = [];

  for (const ref of doc.assets) {
    const asset = store.get(ref.id);
    if (!asset) {
      missing.push(ref.path);
      continue;
    }
    map[ref.path] = asset.bytes;
  }

  if (missing.length > 0) {
    throw new Error(
      `Cannot save: ${missing.length} file(s) this space references are no longer loaded ` +
        `(${missing.join(', ')}).`,
    );
  }
  return map;
}

/**
 * Every asset currently held.
 *
 * The autosave database wants the bytes by id, not by path; the `.space` writer wants
 * the reverse. Both views are cheap, and neither is the "real" one.
 */
export function allAssets(): StoredAsset[] {
  return [...store.values()];
}

/** Every id currently held. Test and diagnostic use. */
export function assetIds(): Id[] {
  return [...store.keys()];
}
