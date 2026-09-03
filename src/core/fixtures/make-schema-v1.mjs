/**
 * Generates `schema-v1.space`. **Run once, in September 2026. Do not run it again.**
 *
 * The file it produces is a frozen artifact: a schema-1 container as this application
 * shipped it, checked into the repository so that every future build can be made to
 * open it. That is the whole value. A fixture regenerated from today's code proves
 * only that today's writer agrees with today's reader, which is a tautology and
 * catches nothing — and regenerating it is exactly what a failing migration test will
 * tempt someone into doing.
 *
 * If `schema-v1.test.ts` fails, the answer is a migration, not a new fixture.
 *
 * The document below is hand-authored rather than produced by `createDocument` and
 * friends, for the same reason: it has to be able to disagree with the code. It
 * deliberately covers the parts of the model most likely to drift — a second floor at
 * a real elevation, a wall with an opening in it, a room with its own ceiling, a
 * catalog item with a cached footprint outline, a surface-mounted placement, a saved
 * 3D camera, a calibrated background, and an asset carried in the container.
 *
 *   node src/core/fixtures/make-schema-v1.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));

// A 1x1 transparent PNG — the smallest thing that is genuinely an image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const document = {
  schemaVersion: 1,
  id: 'doc-v1-fixture',
  title: 'Schema 1 fixture',
  createdAt: '2026-09-01T09:00:00.000Z',
  modifiedAt: '2026-09-01T09:30:00.000Z',
  displayUnit: 'ft-in',
  gridMm: 25,
  catalog: [
    {
      id: 'item-bed',
      name: 'Queen bed',
      category: 'bed',
      widthMm: 1524,
      depthMm: 2032,
      heightMm: 610,
      voidBelowMm: 250,
      canHostSurface: false,
      footprint: {
        generator: { kind: 'rect', w: 1524, d: 2032 },
        outline: {
          pts: [
            { x: 762, y: -1016 },
            { x: 762, y: 1016 },
            { x: -762, y: 1016 },
            { x: -762, y: -1016 },
          ],
        },
      },
      defaultMount: 'floor',
      color: '#8a7a68',
      quantityOwned: 1,
    },
    {
      id: 'item-lamp',
      name: 'Table lamp',
      category: 'lighting',
      widthMm: 220,
      depthMm: 220,
      heightMm: 420,
      voidBelowMm: 0,
      canHostSurface: false,
      footprint: {
        generator: { kind: 'circle', r: 110 },
        outline: {
          pts: [
            { x: 110, y: 0 },
            { x: 0, y: 110 },
            { x: -110, y: 0 },
            { x: 0, y: -110 },
          ],
        },
      },
      defaultMount: 'surface',
      color: '#d8cfc0',
      quantityOwned: 2,
    },
    {
      id: 'item-dresser',
      name: 'Dresser',
      category: 'storage',
      widthMm: 1200,
      depthMm: 450,
      heightMm: 810,
      voidBelowMm: 0,
      canHostSurface: true,
      footprint: {
        generator: { kind: 'rect', w: 1200, d: 450 },
        outline: {
          pts: [
            { x: 600, y: -225 },
            { x: 600, y: 225 },
            { x: -600, y: 225 },
            { x: -600, y: -225 },
          ],
        },
      },
      defaultMount: 'floor',
      clearances: [{ edge: 'front', depthMm: 600, reason: 'drawer pull' }],
      color: '#6b5c4b',
      quantityOwned: 1,
    },
  ],
  floors: [
    {
      id: 'floor-ground',
      name: 'Ground',
      index: 0,
      elevationMm: 0,
      defaultCeilingHeightMm: 2438,
      walls: [
        { id: 'w-n', a: { x: 0, y: 0 }, b: { x: 4200, y: 0 }, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 },
        { id: 'w-e', a: { x: 4200, y: 0 }, b: { x: 4200, y: 3600 }, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 },
        { id: 'w-s', a: { x: 4200, y: 3600 }, b: { x: 0, y: 3600 }, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 },
        { id: 'w-w', a: { x: 0, y: 3600 }, b: { x: 0, y: 0 }, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 },
      ],
      openings: [
        {
          id: 'o-door',
          wallId: 'w-s',
          offsetMm: 1600,
          widthMm: 813,
          heightMm: 2032,
          sillMm: 0,
          kind: 'door',
          swing: { hinge: 'a', into: 'front', angleDeg: 90 },
        },
        {
          id: 'o-window',
          wallId: 'w-n',
          offsetMm: 1800,
          widthMm: 1200,
          heightMm: 1200,
          sillMm: 914,
          kind: 'window',
        },
      ],
      rooms: [
        {
          id: 'room-bedroom',
          name: 'Bedroom',
          boundary: {
            pts: [
              { x: 0, y: 0 },
              { x: 4200, y: 0 },
              { x: 4200, y: 3600 },
              { x: 0, y: 3600 },
            ],
          },
          ceilingHeightMm: 2600,
          areaMm2: 15120000,
        },
      ],
      placements: [
        {
          id: 'p-bed',
          itemId: 'item-bed',
          floorId: 'floor-ground',
          position: { x: 2100, y: 1200 },
          rotation: 0,
          mount: { kind: 'floor' },
          elevation: 0,
        },
        {
          id: 'p-dresser',
          itemId: 'item-dresser',
          floorId: 'floor-ground',
          position: { x: 3500, y: 3200 },
          rotation: 180,
          mount: { kind: 'floor' },
          elevation: 0,
        },
        {
          id: 'p-lamp',
          itemId: 'item-lamp',
          floorId: 'floor-ground',
          position: { x: 3500, y: 3200 },
          rotation: 0,
          mount: { kind: 'surface', hostId: 'p-dresser' },
          elevation: 810,
        },
      ],
      background: {
        assetId: 'asset-plan',
        pageIndex: 0,
        pixelSize: { width: 1, height: 1 },
        calibration: {
          refA: { x: 0, y: 0 },
          refB: { x: 1, y: 0 },
          realLengthMm: 4200,
          mmPerPx: 4200,
        },
        transform: { position: { x: 0, y: 0 }, rotationDeg: 0 },
        opacity: 0.45,
        locked: true,
      },
    },
    {
      id: 'floor-upper',
      name: 'Upstairs',
      index: 1,
      elevationMm: 2738,
      defaultCeilingHeightMm: 2438,
      walls: [
        { id: 'w-u1', a: { x: 0, y: 0 }, b: { x: 4200, y: 0 }, thicknessMm: 114, heightMm: 2438, baseElevationMm: 0 },
      ],
      openings: [],
      rooms: [],
      placements: [],
    },
  ],
  activeFloorId: 'floor-ground',
  savedViews: [
    {
      id: 'view-corner',
      name: 'From the door',
      mode: 'space3d',
      camera: { px: 2100, py: 1600, pz: 3400, tx: 2100, ty: 1650, tz: 1200 },
    },
  ],
  assets: [
    { id: 'asset-plan', path: 'assets/asset-plan.png', mime: 'image/png', bytes: PNG.byteLength },
  ],
};

const manifest = {
  app: 'floorplan',
  appVersion: '0.1.0',
  schemaVersion: 1,
  title: document.title,
  createdAt: document.createdAt,
  modifiedAt: document.modifiedAt,
};

const bytes = zipSync(
  {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'document.json': strToU8(JSON.stringify(document, null, 2)),
    'assets/asset-plan.png': new Uint8Array(PNG),
  },
  { level: 6 },
);

const out = join(here, 'schema-v1.space');
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.byteLength} bytes)`);
