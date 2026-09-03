/**
 * The autosave database. See PLAN.md §5.
 *
 * IndexedDB, two object stores:
 *
 *   documents   keyed by document id   { documentId, title, savedAt, modifiedAt, document, assetIds }
 *   assets      keyed by asset id      { id, path, mime, bytes }
 *
 * ## Why assets get their own store
 *
 * An autosave that keeps only `document.json` recovers a space whose background is
 * gone — which is precisely the failure `assetMapFor` throws to prevent, reached
 * through a different door. But a floor plan raster is megabytes, and rewriting it
 * every twenty seconds to protect a document that is measured in kilobytes is absurd.
 *
 * The way out is that **an asset is immutable once stored**: `putAsset` mints a new id
 * for new bytes and never rewrites an existing one. So the assets an autosave needs
 * are written *by id, once*, and every tick after that writes the document record
 * alone. The tick cost does not depend on how big the background is.
 *
 * ## Failure is not an error here
 *
 * Every call resolves rather than rejecting when IndexedDB is unavailable, blocked by
 * a privacy setting, or over quota. Autosave is a safety net; a safety net that can
 * take down the application it is protecting is a worse bargain than no net. The
 * caller finds out through a `false` or a `null`, and the file-save path — the one the
 * user actually relies on — is untouched by any of it.
 */

import type { Id, SpaceDocument } from '../core/document';
import type { AutosaveSummary } from '../core/recovery';
import type { AssetMap } from '../core/space-file';
import type { StoredAsset } from './assets';

const DB_NAME = 'floorplan';
const DB_VERSION = 1;
const DOC_STORE = 'documents';
const ASSET_STORE = 'assets';

export type AutosaveRecord = AutosaveSummary & {
  document: SpaceDocument;
  assetIds: Id[];
};

type AssetRow = { id: Id; path: string; mime: string; bytes: Uint8Array };

/**
 * Read at call time, never captured at module load.
 *
 * The same rule as the save picker: a module-level snapshot cannot be replaced by a
 * test, and it decides for the life of the page based on whatever was true during the
 * first import.
 */
export function autosaveAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function open(): Promise<IDBDatabase | null> {
  if (!autosaveAvailable()) return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: 'documentId' });
      }
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked upgrade means another tab holds the old version. Give up rather than
    // hang: the other tab is autosaving perfectly well.
    request.onblocked = () => resolve(null);
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function finish(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** Every autosave in the database, newest first. Metadata only. */
export async function listAutosaves(): Promise<AutosaveSummary[]> {
  const db = await open();
  if (!db) return [];

  try {
    const tx = db.transaction(DOC_STORE, 'readonly');
    const rows = await wrap<AutosaveRecord[]>(tx.objectStore(DOC_STORE).getAll());
    return (rows ?? [])
      .map((r) => ({
        documentId: r.documentId,
        title: r.title,
        savedAt: r.savedAt,
        modifiedAt: r.modifiedAt,
      }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Write the document, and any of its assets not already stored.
 *
 * Returns false when nothing was written. The caller uses that to stop claiming a
 * document is protected when it is not.
 */
export async function writeAutosave(
  doc: SpaceDocument,
  assets: readonly StoredAsset[],
  now = new Date().toISOString(),
): Promise<boolean> {
  const db = await open();
  if (!db) return false;

  try {
    const tx = db.transaction([DOC_STORE, ASSET_STORE], 'readwrite');
    const assetStore = tx.objectStore(ASSET_STORE);

    // Only the ids that are not there yet. This is what keeps a tick cheap: the
    // background is written once, on the tick after it was imported, and never again.
    const known = new Set((await wrap<IDBValidKey[]>(assetStore.getAllKeys())) ?? []);
    for (const asset of assets) {
      if (known.has(asset.id)) continue;
      const row: AssetRow = {
        id: asset.id,
        path: asset.path,
        mime: asset.mime,
        // `bytes.buffer` may be a pooled ArrayBuffer larger than the data; slice so
        // the structured clone stores this asset and not whatever followed it.
        bytes: asset.bytes.slice(),
      };
      assetStore.put(row);
    }

    const record: AutosaveRecord = {
      documentId: doc.id,
      title: doc.title,
      savedAt: now,
      modifiedAt: doc.modifiedAt,
      document: doc,
      assetIds: doc.assets.map((a) => a.id),
    };
    tx.objectStore(DOC_STORE).put(record);

    return await finish(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** A stored autosave, with its assets in the shape `loadDocument` wants. */
export async function readAutosave(
  documentId: Id,
): Promise<{ document: SpaceDocument; assets: AssetMap } | null> {
  const db = await open();
  if (!db) return null;

  try {
    const tx = db.transaction([DOC_STORE, ASSET_STORE], 'readonly');
    const record = await wrap<AutosaveRecord | undefined>(
      tx.objectStore(DOC_STORE).get(documentId),
    );
    if (!record) return null;

    // Every request issued before the first await. A transaction stays alive across a
    // microtask but not across a macrotask, and awaiting each `get` in turn walks that
    // line for no benefit — these are independent lookups.
    const store = tx.objectStore(ASSET_STORE);
    const pending = record.assetIds.map((id) => wrap<AssetRow | undefined>(store.get(id)));

    const assets: AssetMap = {};
    for (const row of await Promise.all(pending)) {
      // A missing row is left out rather than faked. `missingAssets` is how the UI
      // finds out, and it says so — the same contract as opening a short container.
      if (row) assets[row.path] = row.bytes;
    }

    return { document: record.document, assets };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Forget a document's autosave, and any asset no remaining record references.
 *
 * Called when a document is saved to a file. That rule is what keeps the recovery
 * prompt meaningful: a surviving record means unsaved work, so the prompt appears
 * when something is genuinely at risk rather than on every clean reload. A prompt you
 * see every morning is one you dismiss without reading.
 */
export async function dropAutosave(documentId: Id): Promise<boolean> {
  const db = await open();
  if (!db) return false;

  try {
    const tx = db.transaction([DOC_STORE, ASSET_STORE], 'readwrite');
    const docs = tx.objectStore(DOC_STORE);
    docs.delete(documentId);

    // Sweep in the same transaction, so the read of what is still referenced cannot
    // race a concurrent write from another tab.
    const remaining = (await wrap<AutosaveRecord[]>(docs.getAll())) ?? [];
    const referenced = new Set(remaining.flatMap((r) => r.assetIds));

    const assets = tx.objectStore(ASSET_STORE);
    const keys = (await wrap<IDBValidKey[]>(assets.getAllKeys())) ?? [];
    for (const key of keys) {
      if (typeof key === 'string' && !referenced.has(key)) assets.delete(key);
    }

    return await finish(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Test and diagnostic use — drops the whole database. */
export async function clearAutosaves(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction([DOC_STORE, ASSET_STORE], 'readwrite');
    tx.objectStore(DOC_STORE).clear();
    tx.objectStore(ASSET_STORE).clear();
    await finish(tx);
  } catch {
    // Nothing to do — the caller is a test or a reset button.
  } finally {
    db.close();
  }
}
