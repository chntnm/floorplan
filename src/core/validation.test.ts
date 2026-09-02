import { describe, expect, it } from 'vitest';
import { createCatalogItem, type ItemDraft } from './catalog';
import { createBackground } from './calibration';
import {
  createDocument,
  type Placement,
  type SpaceDocument,
} from './document';
import { flaggedPlacements, validateFloor } from './validation';

function doc(): SpaceDocument {
  return createDocument({ id: 'd', floorId: 'f', now: '2026-01-01T00:00:00.000Z' });
}

const DRAFTS: Record<string, ItemDraft> = {
  // 720mm of open air beneath — the field the whole 3D collision model turns on.
  table: { name: 'Table', category: 'table', shape: 'rect', widthMm: 1800, depthMm: 900, heightMm: 760, voidBelowMm: 720 },
  rug: { name: 'Rug', category: 'rug', shape: 'rect', widthMm: 2400, depthMm: 1600, heightMm: 10, voidBelowMm: 0 },
  dresser: { name: 'Dresser', category: 'storage', shape: 'rect', widthMm: 1500, depthMm: 500, heightMm: 810, voidBelowMm: 0 },
  bookcase: { name: 'Bookcase', category: 'storage', shape: 'rect', widthMm: 800, depthMm: 300, heightMm: 3000, voidBelowMm: 0 },
};

function withItems(keys: (keyof typeof DRAFTS)[]): SpaceDocument {
  const d = doc();
  for (const key of keys) d.catalog.push(createCatalogItem(DRAFTS[key]!, key));
  return d;
}

function place(itemId: string, at: { x: number; y: number }, id = `p-${itemId}`): Placement {
  return {
    id,
    itemId,
    floorId: 'f',
    position: at,
    rotation: 0,
    mount: { kind: 'floor' },
    elevation: 0,
  };
}

describe('validateFloor', () => {
  it('reports nothing for an empty floor', () => {
    const d = doc();
    expect(validateFloor(d, d.floors[0]!)).toEqual([]);
  });

  it('does not call a rug under a table a collision', () => {
    // The case that makes the vertical axis worth having: footprints overlap
    // completely, solid spans do not — the rug is [0,10] and the table is [720,760].
    const d = withItems(['table', 'rug']);
    d.floors[0]!.placements = [place('rug', { x: 0, y: 0 }), place('table', { x: 0, y: 0 })];

    expect(validateFloor(d, d.floors[0]!)).toEqual([]);
  });

  it('reports two solid objects in the same place', () => {
    const d = withItems(['dresser']);
    d.floors[0]!.placements = [
      place('dresser', { x: 0, y: 0 }, 'a'),
      place('dresser', { x: 200, y: 0 }, 'b'),
    ];

    const issues = validateFloor(d, d.floors[0]!);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('overlap');
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.refs.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('warns rather than blocks — nothing here refuses an edit', () => {
    const d = withItems(['dresser']);
    d.floors[0]!.placements = [
      place('dresser', { x: 0, y: 0 }, 'a'),
      place('dresser', { x: 100, y: 0 }, 'b'),
    ];
    expect(validateFloor(d, d.floors[0]!).every((i) => i.severity === 'warning')).toBe(true);
  });

  it('catches an item taller than the ceiling above it', () => {
    const d = withItems(['bookcase']);
    d.floors[0]!.placements = [place('bookcase', { x: 0, y: 0 })];

    const issues = validateFloor(d, d.floors[0]!);
    expect(issues.map((i) => i.kind)).toContain('headroom');
    // 3000mm bookcase under a 2438mm ceiling.
    expect(issues.find((i) => i.kind === 'headroom')!.message).toContain('562mm');
  });

  it('reports a placement whose item is gone', () => {
    const d = doc();
    d.floors[0]!.placements = [place('vanished', { x: 0, y: 0 })];

    const issues = validateFloor(d, d.floors[0]!);
    expect(issues.map((i) => i.kind)).toEqual(['missing-item']);
  });

  it('reports something sitting on a host that no longer exists', () => {
    const d = withItems(['dresser']);
    d.floors[0]!.placements = [
      { ...place('dresser', { x: 0, y: 0 }), mount: { kind: 'surface', hostId: 'gone' } },
    ];

    const issues = validateFloor(d, d.floors[0]!);
    expect(issues.map((i) => i.kind)).toContain('broken-mount');
  });

  it('reports a surface-mount cycle instead of blowing the stack', () => {
    const d = withItems(['dresser']);
    d.floors[0]!.placements = [
      { ...place('dresser', { x: 0, y: 0 }, 'a'), mount: { kind: 'surface', hostId: 'b' } },
      { ...place('dresser', { x: 3000, y: 0 }, 'b'), mount: { kind: 'surface', hostId: 'a' } },
    ];

    const issues = validateFloor(d, d.floors[0]!);
    expect(issues.filter((i) => i.kind === 'broken-mount').length).toBeGreaterThan(0);
  });

  it('leads with the calibration gate, which is the only blocking issue', () => {
    const d = withItems(['dresser']);
    d.floors[0]!.background = createBackground({
      assetId: 'a',
      pixelSize: { width: 1000, height: 800 },
    });
    d.floors[0]!.placements = [
      place('dresser', { x: 0, y: 0 }, 'a'),
      place('dresser', { x: 100, y: 0 }, 'b'),
    ];

    const issues = validateFloor(d, d.floors[0]!);
    expect(issues[0]!.kind).toBe('uncalibrated');
    expect(issues[0]!.severity).toBe('blocking');
    expect(issues.filter((i) => i.severity === 'blocking')).toHaveLength(1);
  });
});

describe('flaggedPlacements', () => {
  it('collects every placement any issue points at', () => {
    const d = withItems(['dresser']);
    d.floors[0]!.placements = [
      place('dresser', { x: 0, y: 0 }, 'a'),
      place('dresser', { x: 100, y: 0 }, 'b'),
    ];

    expect([...flaggedPlacements(validateFloor(d, d.floors[0]!))].sort()).toEqual(['a', 'b']);
  });

  it('is empty when the only issue points at nothing', () => {
    const d = doc();
    d.floors[0]!.background = createBackground({
      assetId: 'a',
      pixelSize: { width: 100, height: 100 },
    });
    expect(flaggedPlacements(validateFloor(d, d.floors[0]!)).size).toBe(0);
  });
});
