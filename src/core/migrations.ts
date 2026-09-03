/**
 * Schema migrations. See PLAN.md §5.
 *
 * The registry ships at version 1 with nothing in it. That is deliberate — the
 * machinery exists before it is needed, so the first real schema change is a
 * one-file addition rather than a retrofit across the loader.
 */

import { SCHEMA_VERSION, type SpaceDocument } from './document';

/** A migration takes the document shape at `from` and returns the shape at `from + 1`. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * Keyed by the version being migrated *from*.
 *
 * To add one: write `MIGRATIONS[1] = (doc) => ({ ...doc, schemaVersion: 2, ... })`,
 * bump `SCHEMA_VERSION`, and check in a fixture at the old version.
 */
export const MIGRATIONS: Record<number, Migration> = {};

export class SchemaVersionError extends Error {
  constructor(
    public readonly found: number,
    public readonly supported: number,
    message: string,
  ) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/**
 * Bring a document up to `SCHEMA_VERSION`.
 *
 * A newer-than-supported document fails with a clear message rather than being
 * partially parsed — silently dropping fields the app doesn't understand would
 * corrupt the file on the next save.
 */
export function migrate(raw: Record<string, unknown>): SpaceDocument {
  return migrateTo(raw, SCHEMA_VERSION);
}

/**
 * Migrate to an explicit target version.
 *
 * `migrate` is the caller-facing entry point; this seam exists so the chain can be
 * exercised by tests before there is a second schema version to migrate between.
 */
export function migrateTo(
  raw: Record<string, unknown>,
  target: number,
): SpaceDocument {
  const found = raw['schemaVersion'];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    throw new SchemaVersionError(
      typeof found === 'number' ? found : NaN,
      target,
      'This file is missing a valid schemaVersion and cannot be read as a floorplan space.',
    );
  }

  if (found > target) {
    throw new SchemaVersionError(
      found,
      target,
      `This space was saved by a newer version of floorplan (schema ${found}; ` +
        `this build supports up to ${target}). Update the app to open it.`,
    );
  }

  let doc = raw;
  for (let v = found; v < target; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new SchemaVersionError(
        found,
        target,
        `No migration registered from schema ${v} to ${v + 1}.`,
      );
    }
    doc = step(doc);
  }

  return doc as unknown as SpaceDocument;
}
