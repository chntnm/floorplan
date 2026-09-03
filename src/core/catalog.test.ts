import { describe, expect, it } from 'vitest';
import {
  CATEGORY_DEFAULTS,
  CatalogError,
  MAX_DIMENSION_MM,
  createCatalogItem,
  draftFromItem,
  generatorShape,
  itemFootprint,
  itemGenerator,
  type ItemDraft,
} from './catalog';
import { PRESETS, findPreset } from './presets';
import { footprintDepth, footprintWidth } from './geometry/footprint';

const TABLE: ItemDraft = {
  name: 'Dining table',
  category: 'table',
  widthMm: 1830,
  depthMm: 910,
  heightMm: 760,
  shape: 'rect',
};

describe('itemGenerator', () => {
  it('builds every shape from a bounding box', () => {
    for (const shape of ['rect', 'rounded', 'circle', 'ellipse', 'lshape', 'ushape', 'trapezoid'] as const) {
      const footprint = itemFootprint(shape, 1200, 600);
      expect(footprint.outline.pts.length, shape).toBeGreaterThan(2);
    }
  });

  it('fits a rectangle to its stated size exactly', () => {
    const footprint = itemFootprint('rect', 1830, 910);
    expect(footprintWidth(footprint)).toBe(1830);
    expect(footprintDepth(footprint)).toBe(910);
  });

  it('inscribes a circle in the shorter side, so it never exceeds the box', () => {
    const footprint = itemFootprint('circle', 1200, 600);
    expect(footprintWidth(footprint)).toBeLessThanOrEqual(600);
  });

  it('refuses a dimension that is not one', () => {
    expect(() => itemGenerator('rect', 0, 600)).toThrow(CatalogError);
    expect(() => itemGenerator('rect', -5, 600)).toThrow(CatalogError);
    expect(() => itemGenerator('rect', Number.NaN, 600)).toThrow(CatalogError);
  });

  it('catches a decimal-point typo instead of building a 30m table', () => {
    expect(() => itemGenerator('rect', MAX_DIMENSION_MM + 1, 600)).toThrow(/check the units/);
  });
});

describe('createCatalogItem', () => {
  it('defaults the two fields people get wrong, from the category', () => {
    const item = createCatalogItem(TABLE, 'i1');
    expect(item.voidBelowMm).toBe(CATEGORY_DEFAULTS.table.voidBelowMm);
    expect(item.canHostSurface).toBe(true);
    expect(item.quantityOwned).toBe(1);
    expect(item.defaultMount).toBe('floor');
  });

  it('rounds every dimension onto the integer-millimetre grid', () => {
    const item = createCatalogItem({ ...TABLE, widthMm: 1830.4, heightMm: 760.6 }, 'i1');
    expect(item.widthMm).toBe(1830);
    expect(item.heightMm).toBe(761);
  });

  it('rejects a void as tall as the object', () => {
    // This is the one that matters: an inverted solid span makes the item collide
    // with nothing at all, so it quietly stops being checked.
    expect(() => createCatalogItem({ ...TABLE, voidBelowMm: 760 }, 'i1')).toThrow(CatalogError);
    expect(() => createCatalogItem({ ...TABLE, voidBelowMm: 900 }, 'i1')).toThrow(/less than the height/);
  });

  it('accepts a void just under the height', () => {
    expect(createCatalogItem({ ...TABLE, voidBelowMm: 759 }, 'i1').voidBelowMm).toBe(759);
  });

  it('rejects a negative void and a surface above the top', () => {
    expect(() => createCatalogItem({ ...TABLE, voidBelowMm: -1 }, 'i1')).toThrow(CatalogError);
    expect(() => createCatalogItem({ ...TABLE, surfaceHeightMm: 900 }, 'i1')).toThrow(CatalogError);
  });

  it('requires a name', () => {
    expect(() => createCatalogItem({ ...TABLE, name: '   ' }, 'i1')).toThrow(/name/);
  });

  it('rejects a fractional quantity', () => {
    expect(() => createCatalogItem({ ...TABLE, quantityOwned: 1.5 }, 'i1')).toThrow(CatalogError);
    expect(() => createCatalogItem({ ...TABLE, quantityOwned: -1 }, 'i1')).toThrow(CatalogError);
  });

  it('allows owning zero — a shopping list is a list of things you do not have', () => {
    expect(createCatalogItem({ ...TABLE, quantityOwned: 0 }, 'i1').quantityOwned).toBe(0);
  });
});

describe('draftFromItem', () => {
  it('round-trips an item back into the form that built it', () => {
    const item = createCatalogItem({ ...TABLE, shape: 'ellipse', voidBelowMm: 690 }, 'i1');
    const draft = draftFromItem(item);

    expect(draft.shape).toBe('ellipse');
    expect(draft.voidBelowMm).toBe(690);
    expect(createCatalogItem(draft, 'i1')).toEqual(item);
  });

  it('reports no shape for a hand-authored polygon', () => {
    expect(generatorShape({ kind: 'poly', pts: [] })).toBeNull();
  });

  it('distinguishes a rounded rectangle from a square one', () => {
    expect(generatorShape({ kind: 'rect', w: 10, d: 10 })).toBe('rect');
    expect(generatorShape({ kind: 'rect', w: 10, d: 10, cornerRadius: 1 })).toBe('rounded');
  });
});

describe('the preset library', () => {
  it('every preset builds a valid item', () => {
    for (const preset of PRESETS) {
      const { key: _key, group: _group, ...draft } = preset;
      expect(() => createCatalogItem(draft, preset.key), preset.key).not.toThrow();
    }
  });

  it('states voidBelowMm explicitly on every entry, including the zeroes', () => {
    // Inheriting it from the category default would put it one refactor away from
    // silently disappearing, and it is what stops a rug under a table warning.
    for (const preset of PRESETS) {
      expect(preset.voidBelowMm, preset.key).toBeTypeOf('number');
    }
  });

  it('gives tables enough clearance for a chair to tuck under', () => {
    const table = findPreset('dining-table-6');
    expect(table?.voidBelowMm).toBeGreaterThanOrEqual(650);
  });

  it('uses real published sizes', () => {
    // A US queen is 60 x 80 inches; a dishwasher bay is 24 inches.
    expect(findPreset('bed-queen')).toMatchObject({ widthMm: 1524, depthMm: 2032 });
    expect(findPreset('dishwasher')?.widthMm).toBe(610);
  });

  it('has unique keys', () => {
    expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
  });
});

describe('clearance zones on an item', () => {
  const ZONE = { edge: 'front' as const, depthMm: 900, reason: 'drawer pull' };

  function draft(over: Partial<ItemDraft> = {}): ItemDraft {
    return {
      name: 'Dresser',
      category: 'storage',
      shape: 'rect',
      widthMm: 1500,
      depthMm: 500,
      heightMm: 810,
      ...over,
    };
  }

  it('carries them onto the item', () => {
    const item = createCatalogItem(draft({ clearances: [ZONE] }), 'i1');
    expect(item.clearances).toEqual([ZONE]);
  });

  it('leaves the field off entirely when there are none', () => {
    // An empty array and an absent field mean the same thing; writing both into
    // files would make them diff differently for no reason.
    expect(createCatalogItem(draft(), 'i1').clearances).toBeUndefined();
    expect(createCatalogItem(draft({ clearances: [] }), 'i2').clearances).toBeUndefined();
  });

  it('copies the zones rather than aliasing what it was handed', () => {
    const zones = [{ ...ZONE }];
    const item = createCatalogItem(draft({ clearances: zones }), 'i1');
    zones[0]!.depthMm = 1;

    expect(item.clearances![0]!.depthMm).toBe(900);
  });

  it('round-trips through the edit form', () => {
    const item = createCatalogItem(draft({ clearances: [ZONE] }), 'i1');
    expect(draftFromItem(item).clearances).toEqual([ZONE]);
  });
});
