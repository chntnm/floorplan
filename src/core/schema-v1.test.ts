import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSpace, writeSpace } from './space-file';
import { findFloor, findItem, findPlacement } from './document';
import { SCHEMA_VERSION } from './document';

/**
 * The frozen fixture. See `fixtures/make-schema-v1.mjs`.
 *
 * `schema-v1.space` was written once and committed. Nothing in this file regenerates
 * it, and nothing should: a fixture produced by the same build that reads it asserts
 * only that today's writer agrees with today's reader.
 *
 * When a second schema version arrives, these tests do not change. They keep asserting
 * that a schema-1 file opens — through whatever migration chain is by then required —
 * and the correct response to a failure is a migration, not a new fixture.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schema-v1.space');
const bytes = () => new Uint8Array(readFileSync(FIXTURE));

describe('a schema-1 container written before this build', () => {
  it('opens', () => {
    const { document } = readSpace(bytes());
    expect(document.title).toBe('Schema 1 fixture');
    expect(document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(document.floors).toHaveLength(2);
    expect(document.catalog).toHaveLength(3);
  });

  it('carries the asset bytes, not just the manifest entry', () => {
    // The failure this guards is silent and remote: a container that opens fine here
    // and shows a blank background on the recipient's machine.
    const { document, assets } = readSpace(bytes());
    const ref = document.assets[0];
    expect(ref?.path).toBe('assets/asset-plan.png');
    expect(assets[ref!.path]).toBeInstanceOf(Uint8Array);
    expect(assets[ref!.path]!.byteLength).toBe(ref!.bytes);
  });

  it('keeps integer millimetres exactly', () => {
    const { document } = readSpace(bytes());
    const wall = findFloor(document, 'floor-ground')?.walls.find((w) => w.id === 'w-e');
    expect(wall?.b).toEqual({ x: 4200, y: 3600 });
    expect(wall?.thicknessMm).toBe(114);
    expect(findItem(document, 'item-bed')?.widthMm).toBe(1524);
  });

  it('still resolves a surface mount to its host', () => {
    const { document } = readSpace(bytes());
    const lamp = findPlacement(document, 'p-lamp');
    expect(lamp?.mount).toEqual({ kind: 'surface', hostId: 'p-dresser' });
    expect(findPlacement(document, 'p-dresser')).toBeDefined();
  });

  it('keeps an opening attached to its wall, at its offset', () => {
    const { document } = readSpace(bytes());
    const ground = findFloor(document, 'floor-ground');
    const door = ground?.openings.find((o) => o.id === 'o-door');
    expect(door?.wallId).toBe('w-s');
    expect(door?.offsetMm).toBe(1600);
    expect(door?.swing).toEqual({ hinge: 'a', into: 'front', angleDeg: 90 });
    // A window's sill is measured from the floor datum, not the wall base — the kind
    // of field that reads plausibly whichever way a future refactor moves it.
    expect(ground?.openings.find((o) => o.id === 'o-window')?.sillMm).toBe(914);
  });

  it('keeps the upper floor off the ground', () => {
    const { document } = readSpace(bytes());
    const upper = findFloor(document, 'floor-upper');
    expect(upper?.index).toBe(1);
    expect(upper?.elevationMm).toBe(2738);
    expect(upper?.defaultCeilingHeightMm).toBe(2438);
  });

  it('keeps a calibrated background calibrated', () => {
    const { document } = readSpace(bytes());
    const bg = findFloor(document, 'floor-ground')?.background;
    expect(bg?.calibration?.mmPerPx).toBe(4200);
    expect(bg?.locked).toBe(true);
    expect(bg?.pixelSize).toEqual({ width: 1, height: 1 });
  });

  it('survives a trip through the writer this build ships, unchanged', () => {
    const first = readSpace(bytes());
    const again = readSpace(writeSpace(first));
    expect(again.document).toEqual(first.document);
    expect(again.assets).toEqual(first.assets);
  });
});
