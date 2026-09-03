/**
 * The `.space` container. See PLAN.md §5.
 *
 *   myapartment.space
 *   ├── manifest.json     { schemaVersion, app, version, createdAt, modifiedAt, title }
 *   ├── document.json     the SpaceDocument
 *   ├── thumbnail.png     optional
 *   └── assets/…          floor plan rasters, product images, the original PDF
 *
 * Naked JSON fails the portability requirement the moment a document references a
 * local PDF — "another user opens the same space" has to include the assets. A plain
 * `.space.json` export stays valid for asset-free documents and is easier to diff.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { SCHEMA_VERSION, type SpaceDocument } from './document';
import { migrate } from './migrations';

export const APP_NAME = 'floorplan';
export const DOCUMENT_ENTRY = 'document.json';
export const MANIFEST_ENTRY = 'manifest.json';
export const THUMBNAIL_ENTRY = 'thumbnail.png';
export const ASSET_PREFIX = 'assets/';

export type Manifest = {
  app: string;
  appVersion: string;
  schemaVersion: number;
  title: string;
  createdAt: string;
  modifiedAt: string;
};

/** Binary payloads keyed by their path inside the container (`assets/bg.png`). */
export type AssetMap = Record<string, Uint8Array>;

export type SpaceBundle = {
  document: SpaceDocument;
  assets: AssetMap;
  thumbnail?: Uint8Array;
};

export class SpaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpaceFileError';
  }
}

function buildManifest(doc: SpaceDocument, appVersion: string): Manifest {
  return {
    app: APP_NAME,
    appVersion,
    schemaVersion: doc.schemaVersion,
    title: doc.title,
    createdAt: doc.createdAt,
    modifiedAt: doc.modifiedAt,
  };
}

/** Serialize a document and its assets to `.space` bytes. */
export function writeSpace(bundle: SpaceBundle, appVersion = '0.1.0'): Uint8Array {
  const { document: doc, assets, thumbnail } = bundle;

  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: strToU8(JSON.stringify(buildManifest(doc, appVersion), null, 2)),
    [DOCUMENT_ENTRY]: strToU8(JSON.stringify(doc, null, 2)),
  };

  if (thumbnail) entries[THUMBNAIL_ENTRY] = thumbnail;

  for (const [path, bytes] of Object.entries(assets)) {
    if (!path.startsWith(ASSET_PREFIX)) {
      throw new SpaceFileError(
        `asset path must start with "${ASSET_PREFIX}", got "${path}"`,
      );
    }
    entries[path] = bytes;
  }

  // Level 6 — PNG and JPEG assets are already compressed, and the JSON is small.
  return zipSync(entries, { level: 6 });
}

/** Read `.space` bytes back into a document and its assets, migrating if needed. */
export function readSpace(bytes: Uint8Array): SpaceBundle {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    const err = new SpaceFileError(
      'This file is not a readable .space container (it may be corrupt or not a floorplan file).',
    );
    err.cause = cause;
    throw err;
  }

  const docBytes = entries[DOCUMENT_ENTRY];
  if (!docBytes) {
    throw new SpaceFileError(`Container is missing ${DOCUMENT_ENTRY}.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(docBytes));
  } catch {
    throw new SpaceFileError(`${DOCUMENT_ENTRY} is not valid JSON.`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SpaceFileError(`${DOCUMENT_ENTRY} is not an object.`);
  }

  const document = migrate(raw as Record<string, unknown>);

  const assets: AssetMap = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path.startsWith(ASSET_PREFIX)) assets[path] = data;
  }

  const thumbnail = entries[THUMBNAIL_ENTRY];
  return thumbnail ? { document, assets, thumbnail } : { document, assets };
}

// ---------------------------------------------------------------------------
// Plain JSON export (asset-free documents only)
// ---------------------------------------------------------------------------

/**
 * Export a document as plain JSON.
 *
 * Refuses a document that references assets. The JSON carries the asset *manifest*
 * but not the bytes, so writing one would produce a file that reopens with a
 * background pointing at an image that does not exist — a silent data loss that
 * only shows up on the other person's machine. Use `writeSpace` for those.
 *
 * `allowAssetLoss` exists for the deliberate case: exporting the model alone for
 * diffing or version control, knowing the assets stay behind.
 */
export function writeSpaceJson(doc: SpaceDocument, allowAssetLoss = false): string {
  if (!allowAssetLoss && !isAssetFree(doc)) {
    throw new SpaceFileError(
      `This space references ${doc.assets.length} asset(s) that plain JSON cannot carry. ` +
        `Save it as .space instead, or pass allowAssetLoss to export the model alone.`,
    );
  }
  return JSON.stringify(doc, null, 2);
}

export function readSpaceJson(text: string): SpaceDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SpaceFileError('Not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new SpaceFileError('Not a JSON object.');
  }
  return migrate(raw as Record<string, unknown>);
}

/** Whether a document can be exported as plain JSON without losing anything. */
export function isAssetFree(doc: SpaceDocument): boolean {
  return doc.assets.length === 0;
}

export { SCHEMA_VERSION };
