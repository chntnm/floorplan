/**
 * The preset library. See PLAN.md §7.1.
 *
 * Standard dimensions so common items are one click rather than three fields and a
 * tape measure. These are real published sizes — a US queen mattress is 1524 × 2032mm
 * because it is 60" × 80", a dishwasher bay is 610mm because it is 24" — rounded to
 * the millimetre and no further.
 *
 * Every preset carries its `voidBelowMm` explicitly, including the zeroes. That field
 * is what stops a rug under a coffee table reading as a collision, and a preset that
 * inherited it from the category default would be one refactor away from silently
 * losing it.
 *
 * A preset is an `ItemDraft`, not a `CatalogItem`: it has no id and no footprint until
 * someone adds it, and it stays editable in the same form as manual entry.
 */

import type { ItemDraft } from './catalog';

export type Preset = ItemDraft & {
  /** Stable key for lists and tests; never stored in a document. */
  key: string;
  group: string;
};

export const PRESETS: readonly Preset[] = [
  // -- Sleeping ------------------------------------------------------------
  { key: 'bed-twin', group: 'Beds', name: 'Twin bed', category: 'bed', shape: 'rect', widthMm: 991, depthMm: 1905, heightMm: 635, voidBelowMm: 250 },
  { key: 'bed-full', group: 'Beds', name: 'Full bed', category: 'bed', shape: 'rect', widthMm: 1372, depthMm: 1905, heightMm: 635, voidBelowMm: 250 },
  { key: 'bed-queen', group: 'Beds', name: 'Queen bed', category: 'bed', shape: 'rect', widthMm: 1524, depthMm: 2032, heightMm: 635, voidBelowMm: 250 },
  { key: 'bed-king', group: 'Beds', name: 'King bed', category: 'bed', shape: 'rect', widthMm: 1930, depthMm: 2032, heightMm: 635, voidBelowMm: 250 },
  { key: 'nightstand', group: 'Beds', name: 'Nightstand', category: 'storage', shape: 'rect', widthMm: 500, depthMm: 400, heightMm: 600, voidBelowMm: 0, canHostSurface: true },

  // -- Seating -------------------------------------------------------------
  { key: 'sofa-3', group: 'Seating', name: 'Sofa (3-seat)', category: 'seating', shape: 'rect', widthMm: 2130, depthMm: 910, heightMm: 840, voidBelowMm: 0 },
  { key: 'loveseat', group: 'Seating', name: 'Loveseat', category: 'seating', shape: 'rect', widthMm: 1520, depthMm: 910, heightMm: 840, voidBelowMm: 0 },
  { key: 'armchair', group: 'Seating', name: 'Armchair', category: 'seating', shape: 'rect', widthMm: 810, depthMm: 860, heightMm: 800, voidBelowMm: 0 },
  { key: 'dining-chair', group: 'Seating', name: 'Dining chair', category: 'seating', shape: 'rect', widthMm: 460, depthMm: 510, heightMm: 900, voidBelowMm: 0 },
  { key: 'office-chair', group: 'Seating', name: 'Office chair', category: 'seating', shape: 'circle', widthMm: 660, depthMm: 660, heightMm: 1100, voidBelowMm: 0 },

  // -- Tables --------------------------------------------------------------
  // 720mm of apron clearance is what lets chairs tuck under and a rug lie beneath.
  { key: 'dining-table-6', group: 'Tables', name: 'Dining table (6)', category: 'table', shape: 'rect', widthMm: 1830, depthMm: 910, heightMm: 760, voidBelowMm: 720, canHostSurface: true },
  { key: 'dining-table-round', group: 'Tables', name: 'Dining table (round)', category: 'table', shape: 'circle', widthMm: 1220, depthMm: 1220, heightMm: 760, voidBelowMm: 720, canHostSurface: true },
  { key: 'coffee-table', group: 'Tables', name: 'Coffee table', category: 'table', shape: 'rect', widthMm: 1220, depthMm: 610, heightMm: 450, voidBelowMm: 380, canHostSurface: true },
  { key: 'side-table', group: 'Tables', name: 'Side table', category: 'table', shape: 'circle', widthMm: 500, depthMm: 500, heightMm: 550, voidBelowMm: 450, canHostSurface: true },
  { key: 'desk', group: 'Tables', name: 'Desk', category: 'table', shape: 'rect', widthMm: 1520, depthMm: 760, heightMm: 750, voidBelowMm: 700, canHostSurface: true },

  // -- Storage -------------------------------------------------------------
  { key: 'dresser', group: 'Storage', name: 'Dresser', category: 'storage', shape: 'rect', widthMm: 1520, depthMm: 510, heightMm: 810, voidBelowMm: 0, canHostSurface: true },
  { key: 'bookcase', group: 'Storage', name: 'Bookcase', category: 'storage', shape: 'rect', widthMm: 810, depthMm: 300, heightMm: 1830, voidBelowMm: 0, canHostSurface: false },
  { key: 'wardrobe', group: 'Storage', name: 'Wardrobe', category: 'storage', shape: 'rect', widthMm: 1200, depthMm: 600, heightMm: 2000, voidBelowMm: 0, canHostSurface: false },
  { key: 'tv-stand', group: 'Storage', name: 'TV stand', category: 'storage', shape: 'rect', widthMm: 1520, depthMm: 400, heightMm: 500, voidBelowMm: 0, canHostSurface: true },

  // -- Appliances ----------------------------------------------------------
  { key: 'fridge', group: 'Appliances', name: 'Refrigerator', category: 'appliance', shape: 'rect', widthMm: 910, depthMm: 760, heightMm: 1780, voidBelowMm: 0 },
  { key: 'dishwasher', group: 'Appliances', name: 'Dishwasher', category: 'appliance', shape: 'rect', widthMm: 610, depthMm: 610, heightMm: 850, voidBelowMm: 0 },
  { key: 'range', group: 'Appliances', name: 'Range', category: 'appliance', shape: 'rect', widthMm: 760, depthMm: 660, heightMm: 920, voidBelowMm: 0 },
  { key: 'washer', group: 'Appliances', name: 'Washer', category: 'appliance', shape: 'rect', widthMm: 690, depthMm: 760, heightMm: 970, voidBelowMm: 0 },

  // -- Everything else -----------------------------------------------------
  // Mounted at 400mm by default, which is a wall-hung screen above a stand.
  { key: 'tv-65', group: 'Other', name: 'TV (65 in)', category: 'decor', shape: 'rect', widthMm: 1450, depthMm: 80, heightMm: 830, voidBelowMm: 0, defaultMount: 'wall' },
  { key: 'floor-lamp', group: 'Other', name: 'Floor lamp', category: 'lighting', shape: 'circle', widthMm: 400, depthMm: 400, heightMm: 1600, voidBelowMm: 0 },
  { key: 'pendant', group: 'Other', name: 'Pendant light', category: 'lighting', shape: 'circle', widthMm: 350, depthMm: 350, heightMm: 300, voidBelowMm: 0, defaultMount: 'ceiling' },
  // A rug is 10mm of solid sitting on the floor. Everything with a void above 10mm —
  // every table, every bed — passes over it without a warning, which is the point.
  { key: 'rug-5x8', group: 'Other', name: 'Rug (5 x 8 ft)', category: 'rug', shape: 'rect', widthMm: 1520, depthMm: 2440, heightMm: 10, voidBelowMm: 0 },
  { key: 'rug-8x10', group: 'Other', name: 'Rug (8 x 10 ft)', category: 'rug', shape: 'rect', widthMm: 2440, depthMm: 3050, heightMm: 10, voidBelowMm: 0 },
];

export const PRESET_GROUPS: readonly string[] = [...new Set(PRESETS.map((p) => p.group))];

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((p) => p.key === key);
}
