import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { rectFootprint } from './geometry/footprint';
import { polygon } from './geometry/polygon';
import { SCHEMA_VERSION, createDocument, type SpaceDocument } from './document';
import { MIGRATIONS, SchemaVersionError, migrate, migrateTo } from './migrations';
import {
  DOCUMENT_ENTRY,
  MANIFEST_ENTRY,
  SpaceFileError,
  isAssetFree,
  readSpace,
  readSpaceJson,
  writeSpace,
  writeSpaceJson,
} from './space-file';

/** A document exercising every part of the model — the round-trip fixture. */
function fixture(): SpaceDocument {
  const doc = createDocument({
    id: 'doc-1',
    floorId: 'floor-1',
    title: 'Test Apartment',
    now: '2026-09-01T12:00:00.000Z',
  });

  doc.catalog = [
    {
      id: 'item-sofa',
      name: 'Article Sven Sofa',
      category: 'seating',
      widthMm: 2134,
      depthMm: 902,
      heightMm: 838,
      voidBelowMm: 0,
      canHostSurface: false,
      footprint: rectFootprint(2134, 902),
      defaultMount: 'floor',
      color: '#6b7a5e',
      quantityOwned: 1,
      source: {
        url: 'https://example.com/sven-sofa',
        retrievedAt: '2026-09-01T11:00:00.000Z',
        confidence: 'confirmed',
        rawSnippet: '84"W x 35.5"D x 33"H',
      },
      clearances: [{ edge: 'front', depthMm: 900, reason: 'walkway', heightMm: 900 }],
    },
    {
      id: 'item-table',
      name: 'Dining table',
      category: 'table',
      widthMm: 1800,
      depthMm: 900,
      heightMm: 750,
      voidBelowMm: 720,
      surfaceHeightMm: 750,
      canHostSurface: true,
      footprint: rectFootprint(1800, 900),
      defaultMount: 'floor',
      color: '#8a6f4e',
      quantityOwned: 1,
    },
  ];

  const floor = doc.floors[0]!;
  floor.walls = [
    { id: 'w1', a: { x: 0, y: 0 }, b: { x: 5000, y: 0 }, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 },
  ];
  floor.openings = [
    {
      id: 'o1',
      wallId: 'w1',
      offsetMm: 1200,
      widthMm: 813,
      heightMm: 2032,
      sillMm: 0,
      kind: 'door',
      swing: { hinge: 'a', into: 'front', angleDeg: 90 },
    },
  ];
  floor.rooms = [
    {
      id: 'r1',
      name: 'Living',
      boundary: polygon([
        { x: 0, y: 0 },
        { x: 0, y: 4000 },
        { x: 5000, y: 4000 },
        { x: 5000, y: 0 },
      ]),
      ceilingHeightMm: 2438,
      areaMm2: 20_000_000,
    },
  ];
  floor.placements = [
    {
      id: 'p1',
      itemId: 'item-sofa',
      floorId: 'floor-1',
      position: { x: 2500, y: 500 },
      rotation: 0,
      mount: { kind: 'floor' },
      elevation: 0,
    },
    {
      id: 'p2',
      itemId: 'item-table',
      floorId: 'floor-1',
      position: { x: 2500, y: 2800 },
      rotation: 90,
      mount: { kind: 'floor' },
      elevation: 0,
      flipped: true,
      overrides: { label: 'Dad’s table' },
    },
  ];
  floor.background = {
    assetId: 'asset-bg',
    pageIndex: 0,
    calibration: {
      refA: { x: 100, y: 100 },
      refB: { x: 500, y: 100 },
      realLengthMm: 3000,
      mmPerPx: 7.5,
    },
    transform: { position: { x: 0, y: 0 }, rotationDeg: 0 },
    opacity: 0.45,
    locked: true,
  };

  doc.savedViews = [
    { id: 'v1', name: 'Doorway', mode: 'space3d', camera: { x: 1200, y: 300, z: 1650, tx: 2500, ty: 2500, tz: 1200 } },
  ];
  doc.assets = [
    { id: 'asset-bg', path: 'assets/bg-ground.png', mime: 'image/png', bytes: 4 },
  ];

  return doc;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('.space container', () => {
  it('round-trips a document with assets, deep-equal', () => {
    const doc = fixture();
    const bytes = writeSpace({ document: doc, assets: { 'assets/bg-ground.png': PNG } });
    const back = readSpace(bytes);

    expect(back.document).toEqual(doc);
    expect(back.assets['assets/bg-ground.png']).toEqual(PNG);
  });

  it('round-trips a thumbnail', () => {
    const bytes = writeSpace({ document: fixture(), assets: {}, thumbnail: PNG });
    expect(readSpace(bytes).thumbnail).toEqual(PNG);
  });

  it('writes a manifest that names the app and schema', () => {
    const bytes = writeSpace({ document: fixture(), assets: {} }, '0.1.0');
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)[MANIFEST_ENTRY]!));
    expect(manifest).toMatchObject({
      app: 'floorplan',
      appVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      title: 'Test Apartment',
    });
  });

  it('preserves integer millimetres exactly — no float drift through JSON', () => {
    const doc = fixture();
    const back = readSpace(writeSpace({ document: doc, assets: {} })).document;
    for (const p of back.floors[0]!.placements) {
      expect(Number.isInteger(p.position.x)).toBe(true);
      expect(Number.isInteger(p.position.y)).toBe(true);
    }
    expect(back.floors[0]!.placements[0]!.position).toEqual({ x: 2500, y: 500 });
  });

  it('rejects asset paths outside assets/', () => {
    expect(() =>
      writeSpace({ document: fixture(), assets: { 'sneaky.png': PNG } }),
    ).toThrow(SpaceFileError);
  });

  it('reports a non-zip file clearly', () => {
    expect(() => readSpace(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(SpaceFileError);
  });

  it('reports a container missing document.json', () => {
    const entries = unzipSync(writeSpace({ document: fixture(), assets: {} }));
    delete entries[DOCUMENT_ENTRY];
    expect(() => readSpace(zipSync(entries))).toThrow(/missing document\.json/);
  });
});

describe('plain JSON export', () => {
  it('round-trips an asset-free document', () => {
    const doc = createDocument({ id: 'd', floorId: 'f', now: '2026-09-01T00:00:00.000Z' });
    expect(isAssetFree(doc)).toBe(true);
    expect(readSpaceJson(writeSpaceJson(doc))).toEqual(doc);
  });

  it('knows when a document has assets and needs the container', () => {
    expect(isAssetFree(fixture())).toBe(false);
  });

  it('refuses to export a document whose assets it cannot carry', () => {
    // Otherwise the file reopens with a background pointing at an image that
    // does not exist — and only on the other person's machine.
    expect(() => writeSpaceJson(fixture())).toThrow(SpaceFileError);
    expect(() => writeSpaceJson(fixture())).toThrow(/Save it as \.space/);
  });

  it('allows deliberate model-only export', () => {
    const json = writeSpaceJson(fixture(), true);
    expect(readSpaceJson(json).assets).toHaveLength(1);
  });

  it('rejects malformed JSON', () => {
    expect(() => readSpaceJson('{nope')).toThrow(SpaceFileError);
    expect(() => readSpaceJson('[]')).toThrow();
  });
});

describe('migrations', () => {
  it('passes a current-version document through untouched', () => {
    const doc = fixture();
    expect(migrate(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('refuses a document from a newer app rather than partially parsing it', () => {
    expect(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 })).toThrow(SchemaVersionError);
    expect(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 })).toThrow(/newer version/);
  });

  it('refuses a file with no schemaVersion', () => {
    expect(() => migrate({})).toThrow(SchemaVersionError);
    expect(() => migrate({ schemaVersion: 'one' })).toThrow(SchemaVersionError);
  });

  it('runs a registered migration chain', () => {
    // Exercises the machinery before there is a real schema change to migrate.
    const original = MIGRATIONS[1];
    MIGRATIONS[1] = (d) => ({ ...d, schemaVersion: 2, ceilingHeightMm: 2438 });
    try {
      const out = migrateTo({ schemaVersion: 1, title: 'old' }, 2);
      expect(out).toMatchObject({ schemaVersion: 2, title: 'old', ceilingHeightMm: 2438 });
    } finally {
      if (original) MIGRATIONS[1] = original;
      else delete MIGRATIONS[1];
    }
  });

  it('reports a gap in the migration chain', () => {
    expect(() => migrateTo({ schemaVersion: 1 }, 3)).toThrow(/No migration registered/);
  });
});
