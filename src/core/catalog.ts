/**
 * Building and validating catalog items. See PLAN.md §4.3 and §7.1.
 *
 * The catalog is what you *own*; placements are where those things *are*. Six
 * identical dining chairs are one catalog entry and six placements, which is the only
 * way "I own 6, 4 are placed, 2 unplaced" stays expressible.
 *
 * The interesting field is `voidBelowMm`. A table is not a solid prism — it is a top
 * and four legs with ~720mm of open air beneath, and without that number a rug under
 * a table registers as a collision, so does a bin under a desk, and the validation
 * panel is noise from the first real room. Manual entry defaults it per category
 * rather than leaving it at zero, because a user typing in a dining table should not
 * have to know why the app is about to shout at them.
 *
 * Pure — no DOM, no store.
 */

import type {
  Category,
  CatalogItem,
  ClearanceZone,
  Id,
  MountKind,
  ProductSource,
} from './document';
import { makeFootprint, type Footprint } from './geometry/footprint';
import type { FootprintGenerator } from './geometry/generators';
import type { ShapeKind } from './tools';

export const CATEGORIES: readonly Category[] = [
  'seating',
  'table',
  'storage',
  'bed',
  'appliance',
  'fixture',
  'lighting',
  'decor',
  'rug',
  'other',
] as const;

export const CATEGORY_LABELS: Record<Category, string> = {
  seating: 'Seating',
  table: 'Table',
  storage: 'Storage',
  bed: 'Bed',
  appliance: 'Appliance',
  fixture: 'Fixture',
  lighting: 'Lighting',
  decor: 'Decor',
  rug: 'Rug',
  other: 'Other',
};

/**
 * Per-category defaults for the two fields people get wrong.
 *
 * `voidBelow` is the open air beneath the object and `hosts` is whether other things
 * can sit on top. Both are guesses the form pre-fills and the user can override; both
 * are far better guesses than zero and false.
 */
export const CATEGORY_DEFAULTS: Record<
  Category,
  { voidBelowMm: number; canHostSurface: boolean; color: string }
> = {
  seating: { voidBelowMm: 0, canHostSurface: false, color: '#7a6a58' },
  table: { voidBelowMm: 700, canHostSurface: true, color: '#8a6f4e' },
  storage: { voidBelowMm: 0, canHostSurface: true, color: '#6f6152' },
  bed: { voidBelowMm: 250, canHostSurface: false, color: '#5f6b7a' },
  appliance: { voidBelowMm: 0, canHostSurface: false, color: '#6b7078' },
  fixture: { voidBelowMm: 0, canHostSurface: false, color: '#6e7a76' },
  lighting: { voidBelowMm: 0, canHostSurface: false, color: '#9a8b52' },
  decor: { voidBelowMm: 0, canHostSurface: false, color: '#7d6a72' },
  rug: { voidBelowMm: 0, canHostSurface: false, color: '#8a7a6a' },
  other: { voidBelowMm: 0, canHostSurface: false, color: '#70707a' },
};

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** Nothing real is smaller than this, and it keeps degenerate footprints out. */
export const MIN_DIMENSION_MM = 1;
/** 30m — larger than any single object in a home, and a decimal-point typo catcher. */
export const MAX_DIMENSION_MM = 30_000;

export type ItemDraft = {
  name: string;
  category: Category;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  shape: ShapeKind;
  voidBelowMm?: number;
  surfaceHeightMm?: number;
  canHostSurface?: boolean;
  defaultMount?: MountKind;
  /** Space this item needs kept clear around it. See `core/clearance.ts`. */
  clearances?: ClearanceZone[];
  color?: string;
  quantityOwned?: number;
  notes?: string;
  /** Where the numbers came from, when they were not typed. See PLAN.md §7.2. */
  source?: ProductSource;
};

/**
 * A footprint generator from a bounding box and a shape choice.
 *
 * The same `ShapeKind` vocabulary the plan's shape tool uses — "account for all
 * common shapes" is one list, not two — parameterised by W × D rather than by a drag,
 * because that is how a person describes furniture.
 */
export function itemGenerator(shape: ShapeKind, widthMm: number, depthMm: number): FootprintGenerator {
  requireDimension('width', widthMm);
  requireDimension('depth', depthMm);

  switch (shape) {
    case 'rect':
      return { kind: 'rect', w: widthMm, d: depthMm };
    case 'rounded':
      // A tenth of the short side reads as "rounded" at any size without turning a
      // small object into a lozenge.
      return { kind: 'rect', w: widthMm, d: depthMm, cornerRadius: Math.min(widthMm, depthMm) / 10 };
    case 'circle':
      return { kind: 'circle', r: Math.min(widthMm, depthMm) / 2 };
    case 'ellipse':
      return { kind: 'ellipse', rx: widthMm / 2, ry: depthMm / 2 };
    case 'lshape':
      return { kind: 'lshape', w: widthMm, d: depthMm, cutW: widthMm / 2, cutD: depthMm / 2, corner: 'ne' };
    case 'ushape':
      return { kind: 'ushape', w: widthMm, d: depthMm, armW: widthMm / 4, openSide: 'n' };
    case 'trapezoid':
      return { kind: 'trapezoid', wTop: widthMm / 2, wBottom: widthMm, d: depthMm };
  }
}

export function itemFootprint(shape: ShapeKind, widthMm: number, depthMm: number): Footprint {
  return makeFootprint(itemGenerator(shape, widthMm, depthMm));
}

function requireDimension(name: string, value: number): void {
  if (!Number.isFinite(value) || value < MIN_DIMENSION_MM) {
    throw new CatalogError(`${name} must be at least ${MIN_DIMENSION_MM}mm.`);
  }
  if (value > MAX_DIMENSION_MM) {
    throw new CatalogError(`${name} of ${value}mm is larger than anything in a home — check the units.`);
  }
}

/**
 * Build a catalog item, defaulting the fields people should not have to think about
 * and rejecting the combinations that would produce nonsense downstream.
 *
 * A void taller than the object is the one that matters: it inverts the solid span,
 * so the item would collide with nothing at all and quietly stop being checked.
 */
export function createCatalogItem(draft: ItemDraft, id: Id): CatalogItem {
  const name = draft.name.trim();
  if (!name) throw new CatalogError('Give the item a name.');

  requireDimension('height', draft.heightMm);
  const footprint = itemFootprint(draft.shape, draft.widthMm, draft.depthMm);

  const defaults = CATEGORY_DEFAULTS[draft.category];
  const voidBelowMm = draft.voidBelowMm ?? defaults.voidBelowMm;
  if (voidBelowMm < 0) throw new CatalogError('Open space beneath cannot be negative.');
  if (voidBelowMm >= draft.heightMm) {
    throw new CatalogError(
      `Open space beneath (${voidBelowMm}mm) must be less than the height (${draft.heightMm}mm), ` +
        `or the object has no solid part left to collide with.`,
    );
  }

  const surfaceHeightMm = draft.surfaceHeightMm;
  if (surfaceHeightMm !== undefined) {
    if (surfaceHeightMm <= 0 || surfaceHeightMm > draft.heightMm) {
      throw new CatalogError('The usable surface must be above the floor and no higher than the item.');
    }
  }

  const quantityOwned = draft.quantityOwned ?? 1;
  if (!Number.isInteger(quantityOwned) || quantityOwned < 0) {
    throw new CatalogError('Quantity owned must be a whole number, zero or more.');
  }

  return {
    id,
    name,
    category: draft.category,
    widthMm: Math.round(draft.widthMm),
    depthMm: Math.round(draft.depthMm),
    heightMm: Math.round(draft.heightMm),
    voidBelowMm: Math.round(voidBelowMm),
    ...(surfaceHeightMm !== undefined ? { surfaceHeightMm: Math.round(surfaceHeightMm) } : {}),
    canHostSurface: draft.canHostSurface ?? defaults.canHostSurface,
    footprint,
    defaultMount: draft.defaultMount ?? 'floor',
    // Only when there are some: an empty array and an absent field mean the same
    // thing and writing both into files makes them diff differently for no reason.
    ...(draft.clearances && draft.clearances.length > 0
      ? { clearances: draft.clearances.map((z) => ({ ...z })) }
      : {}),
    color: draft.color ?? defaults.color,
    quantityOwned,
    ...(draft.notes ? { notes: draft.notes } : {}),
    ...(draft.source ? { source: { ...draft.source } } : {}),
  };
}

/** The draft an existing item edits from — the inverse of `createCatalogItem`. */
export function draftFromItem(item: CatalogItem, shape: ShapeKind = 'rect'): ItemDraft {
  return {
    name: item.name,
    category: item.category,
    widthMm: item.widthMm,
    depthMm: item.depthMm,
    heightMm: item.heightMm,
    shape: generatorShape(item.footprint.generator) ?? shape,
    voidBelowMm: item.voidBelowMm,
    // Carried back, or editing the height of an imported item would quietly erase the
    // record of where its width came from.
    ...(item.source ? { source: { ...item.source } } : {}),
    ...(item.surfaceHeightMm !== undefined ? { surfaceHeightMm: item.surfaceHeightMm } : {}),
    canHostSurface: item.canHostSurface,
    defaultMount: item.defaultMount,
    ...(item.clearances ? { clearances: item.clearances.map((z) => ({ ...z })) } : {}),
    color: item.color,
    quantityOwned: item.quantityOwned,
    ...(item.notes ? { notes: item.notes } : {}),
  };
}

/** Which shape choice produced a generator, for round-tripping the edit form. */
export function generatorShape(gen: FootprintGenerator): ShapeKind | null {
  switch (gen.kind) {
    case 'rect':
      return gen.cornerRadius ? 'rounded' : 'rect';
    case 'circle':
      return 'circle';
    case 'ellipse':
      return 'ellipse';
    case 'lshape':
      return 'lshape';
    case 'ushape':
      return 'ushape';
    case 'trapezoid':
      return 'trapezoid';
    case 'poly':
      // An imported or hand-authored polygon has no parametric shape to edit back to.
      return null;
  }
}
