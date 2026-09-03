import { describe, expect, it } from 'vitest';
import {
  THUMBNAIL_PX,
  thumbnailBounds,
  thumbnailFit,
  thumbnailShapes,
} from './thumbnail';
import { createDocument, createFloor, type CatalogItem, type SpaceDocument } from './document';
import { polygon } from './geometry/polygon';
import { rectFootprint } from './geometry/footprint';

function doc(): SpaceDocument {
  return createDocument({ id: 'd', floorId: 'ground', now: '2026-01-01T00:00:00.000Z' });
}

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'i',
    name: 'Dresser',
    category: 'storage',
    widthMm: 1200,
    depthMm: 400,
    heightMm: 800,
    voidBelowMm: 0,
    canHostSurface: true,
    footprint: rectFootprint(1200, 400),
    defaultMount: 'floor',
    color: '#888',
    quantityOwned: 1,
    ...over,
  };
}

function wall(id: string, ax: number, ay: number, bx: number, by: number) {
  return {
    id,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    thicknessMm: 114,
    heightMm: 2438,
    baseElevationMm: 0,
  };
}

describe('framing the picture', () => {
  it('fits a wide plan by its width and centres it vertically', () => {
    const fit = thumbnailFit({ minX: 0, minY: 0, maxX: 8000, maxY: 2000 }, 512, 16);

    // 480 available pixels over 8000mm.
    expect(fit.scale).toBeCloseTo(480 / 8000, 10);
    expect(fit.x).toBeCloseTo(16, 6);
    // 2000mm at that scale is 120px, so 196px of margin above and below.
    expect(fit.y).toBeCloseTo((512 - 120) / 2, 6);
  });

  it('keeps proportions rather than filling the square', () => {
    const fit = thumbnailFit({ minX: 0, minY: 0, maxX: 8000, maxY: 2000 });
    const w = 8000 * fit.scale;
    const h = 2000 * fit.scale;
    expect(w / h).toBeCloseTo(4, 6);
  });

  it('does not divide by zero on a single wall', () => {
    // One horizontal wall has no vertical extent at all. Rendering it as a line is
    // fine; throwing here would fail the save, and a thumbnail is never worth that.
    const fit = thumbnailFit({ minX: 0, minY: 500, maxX: 4000, maxY: 500 });
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(fit.scale).toBeGreaterThan(0);
  });

  it('places the extent inside the padding, both corners', () => {
    const box = { minX: -3000, minY: -1000, maxX: 1000, maxY: 5000 };
    const fit = thumbnailFit(box, 512, 16);

    const topLeft = { x: box.minX * fit.scale + fit.x, y: box.minY * fit.scale + fit.y };
    const bottomRight = { x: box.maxX * fit.scale + fit.x, y: box.maxY * fit.scale + fit.y };

    // Negative document coordinates are the case a naive `scale`-only transform gets
    // wrong: the plan is drawn off the top-left of the canvas and the file ships a
    // blank square that looks like a rendering bug rather than a maths one.
    for (const p of [topLeft, bottomRight]) {
      expect(p.x).toBeGreaterThanOrEqual(16 - 0.001);
      expect(p.y).toBeGreaterThanOrEqual(16 - 0.001);
      expect(p.x).toBeLessThanOrEqual(THUMBNAIL_PX - 16 + 0.001);
      expect(p.y).toBeLessThanOrEqual(THUMBNAIL_PX - 16 + 0.001);
    }
  });
});

describe('what goes in the picture', () => {
  it('has nothing to draw on an empty floor', () => {
    const d = doc();
    expect(thumbnailBounds(d, d.floors[0]!)).toBeNull();
  });

  it('frames furniture that stands outside the walls', () => {
    // An inventory-first document — items placed before any structure exists — has a
    // perfectly good picture and no walls at all. Framing on `floorBounds`, which
    // covers rooms and walls only, would produce nothing for it.
    const d = doc();
    d.catalog.push(item());
    d.floors[0]!.placements.push({
      id: 'p',
      itemId: 'i',
      floorId: 'ground',
      position: { x: 6000, y: 6000 },
      rotation: 0,
      mount: { kind: 'floor' },
      elevation: 0,
    });

    const box = thumbnailBounds(d, d.floors[0]!);
    expect(box).not.toBeNull();
    expect(box!.maxX).toBeGreaterThan(6000);
  });

  it('draws rooms, walls and placements, each as a closed ring', () => {
    const d = doc();
    const floor = d.floors[0]!;
    floor.walls.push(wall('w', 0, 0, 4000, 0));
    floor.rooms.push({
      id: 'r',
      name: 'Room',
      boundary: polygon([
        { x: 0, y: 0 },
        { x: 4000, y: 0 },
        { x: 4000, y: 3000 },
        { x: 0, y: 3000 },
      ]),
      ceilingHeightMm: 2438,
      areaMm2: 12_000_000,
    });
    d.catalog.push(item());
    floor.placements.push({
      id: 'p',
      itemId: 'i',
      floorId: 'ground',
      position: { x: 2000, y: 1500 },
      rotation: 0,
      mount: { kind: 'floor' },
      elevation: 0,
    });

    const fit = thumbnailFit(thumbnailBounds(d, floor)!);
    const shapes = thumbnailShapes(d, floor, fit);

    expect(shapes.rooms).toHaveLength(1);
    expect(shapes.walls).toHaveLength(1);
    expect(shapes.placements).toHaveLength(1);
    for (const ring of [...shapes.rooms, ...shapes.walls, ...shapes.placements]) {
      expect(ring.length).toBeGreaterThanOrEqual(3);
      for (const p of ring) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it('skips a placement whose catalog item is gone', () => {
    // Not reachable through the UI, but a hand-edited or partially-migrated file can
    // hold one, and a save that throws on it is a document you cannot get out.
    const d = doc();
    d.floors[0]!.placements.push({
      id: 'p',
      itemId: 'missing',
      floorId: 'ground',
      position: { x: 0, y: 0 },
      rotation: 0,
      mount: { kind: 'floor' },
      elevation: 0,
    });

    expect(thumbnailBounds(d, d.floors[0]!)).toBeNull();
    const fit = thumbnailFit({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    expect(thumbnailShapes(d, d.floors[0]!, fit).placements).toHaveLength(0);
  });

  it('draws one floor, not the storey below it', () => {
    const d = doc();
    const ground = d.floors[0]!;
    ground.walls.push(wall('w1', 0, 0, 4000, 0));

    const upper = createFloor('upper', 'Upstairs', 1);
    upper.walls.push(wall('w2', 0, 0, 1000, 0));
    d.floors.push(upper);

    // A small upstairs framed on the whole building would render at the scale of the
    // floor beneath it, which is the ghost underlay leaking into the file.
    const box = thumbnailBounds(d, upper)!;
    expect(box.maxX).toBeLessThan(1200);
  });
});
