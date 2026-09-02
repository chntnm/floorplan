/**
 * The document model. See PLAN.md §4.
 *
 * One document holds the catalog (what you own), the floors (structure), and the
 * placements (a catalog item at a position). Catalog and placement are deliberately
 * separate: six identical chairs are one catalog entry and six placements, so
 * "I own 6, 4 are placed" stays expressible.
 */

import type { Footprint } from './geometry/footprint';
import type { Polygon } from './geometry/polygon';
import type { Vec2 } from './geometry/vec';
import type { DisplayUnit } from './units';

export const SCHEMA_VERSION = 1;

export type Id = string;

export type Category =
  | 'seating'
  | 'table'
  | 'storage'
  | 'bed'
  | 'appliance'
  | 'fixture'
  | 'lighting'
  | 'decor'
  | 'rug'
  | 'other';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type ClearanceZone = {
  edge: 'front' | 'back' | 'left' | 'right';
  depthMm: number;
  /** Human-readable cause, shown in the validation panel: "drawer pull", "oven door". */
  reason: string;
  /** Vertical extent of the zone. Omitted means full height of the host object. */
  heightMm?: number;
};

export type ProductSource = {
  url: string;
  retrievedAt: string;
  /** `parsed` dimensions are unconfirmed and flagged in the inventory list. */
  confidence: 'confirmed' | 'parsed' | 'manual';
  /** The text the numbers were read from — keeps a scraped dimension auditable. */
  rawSnippet?: string;
};

export type CatalogItem = {
  id: Id;
  name: string;
  category: Category;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  /**
   * Open air beneath the object. Drives vertical collision — see `solidSpan`.
   * Dining table 720, desk 700, bed frame 250, dresser 0.
   */
  voidBelowMm: number;
  /** Usable top surface, when that is not the object's full height (desk with hutch). */
  surfaceHeightMm?: number;
  /** Whether other items can be surface-mounted on top. False for beds, sofas, rugs. */
  canHostSurface: boolean;
  footprint: Footprint;
  defaultMount: MountKind;
  clearances?: ClearanceZone[];
  color: string;
  imageAssetId?: Id;
  /** Reserved for GLTF models (v2). Nothing else changes when they land. */
  modelAssetId?: Id;
  source?: ProductSource;
  quantityOwned: number;
  notes?: string;
};

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export type MountKind = 'floor' | 'surface' | 'wall' | 'ceiling';

export type Mount =
  | { kind: 'floor' }
  | { kind: 'surface'; hostId: Id }
  | { kind: 'wall'; wallId: Id }
  | { kind: 'ceiling'; drop: number };

export type Placement = {
  id: Id;
  itemId: Id;
  floorId: Id;
  /** Centre of the footprint, in document space. */
  position: Vec2;
  /** Degrees counter-clockwise about the footprint centre. */
  rotation: number;
  mount: Mount;
  /**
   * Base of the object above this floor's datum.
   *
   * Explicit for `floor` and `wall` mounts; **derived** for `surface` and `ceiling`
   * mounts — call `resolveElevation` rather than trusting this field for those.
   */
  elevation: number;
  /** Mirror across local Y — handed items: a chaise, a desk return. */
  flipped?: boolean;
  overrides?: { color?: string; label?: string; heightMm?: number };
};

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export type Wall = {
  id: Id;
  a: Vec2;
  b: Vec2;
  /** Default 114 (interior stud) / 203 (exterior). */
  thicknessMm: number;
  heightMm: number;
  /** Usually 0; nonzero for half-walls on a platform. */
  baseElevationMm: number;
};

export type OpeningKind = 'door' | 'window' | 'cased' | 'pocket' | 'sliding';

export type Opening = {
  id: Id;
  wallId: Id;
  /** Distance from `wall.a` along the centreline. */
  offsetMm: number;
  widthMm: number;
  heightMm: number;
  /** 0 for doors, ~900 for windows. */
  sillMm: number;
  kind: OpeningKind;
  swing?: {
    hinge: 'a' | 'b';
    into: 'front' | 'back';
    angleDeg: number;
  };
};

export type Room = {
  id: Id;
  name: string;
  boundary: Polygon;
  ceilingHeightMm: number;
  floorColor?: string;
  /** Derived, cached. */
  areaMm2: number;
};

export type Background = {
  assetId: Id;
  /** The original PDF, retained alongside the render. */
  sourceAssetId?: Id;
  pageIndex?: number;
  /**
   * The raster's intrinsic size in pixels.
   *
   * This is the domain `calibration.refA/refB` live in, and it is what makes the
   * image-pixel to document-millimetre map invertible before calibration exists.
   * Without it a reopened document could render the background but could not
   * convert a click on it back to a pixel, so recalibration would be impossible.
   */
  pixelSize: { width: number; height: number };
  /**
   * Absent until the user completes the calibration gate. A floor plan has no
   * intrinsic scale, so a document with an uncalibrated background refuses
   * placements — see PLAN.md §6.1.
   */
  calibration?: {
    refA: Vec2;
    refB: Vec2;
    realLengthMm: number;
    mmPerPx: number;
  };
  transform: { position: Vec2; rotationDeg: number };
  opacity: number;
  locked: boolean;
};

export type Floor = {
  id: Id;
  name: string;
  index: number;
  /** Datum of this floor above building zero. */
  elevationMm: number;
  /** Used for placements that fall outside every traced room. */
  defaultCeilingHeightMm: number;
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  placements: Placement[];
  background?: Background;
};

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type SavedView = {
  id: Id;
  name: string;
  mode: 'plan2d' | 'space3d';
  /** Plan: pan/zoom. Space: camera position + target, in document mm. */
  camera: Record<string, number>;
};

export type AssetRef = {
  id: Id;
  /** Path within the container, e.g. `assets/bg-ground.png`. */
  path: string;
  mime: string;
  bytes: number;
};

export type SpaceDocument = {
  schemaVersion: number;
  id: Id;
  title: string;
  createdAt: string;
  modifiedAt: string;
  displayUnit: DisplayUnit;
  /** Snap grid in mm. */
  gridMm: number;
  catalog: CatalogItem[];
  floors: Floor[];
  activeFloorId: Id;
  savedViews: SavedView[];
  assets: AssetRef[];
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const DEFAULT_CEILING_HEIGHT_MM = 2438; // 8'
export const DEFAULT_WALL_HEIGHT_MM = 2438;
export const DEFAULT_WALL_THICKNESS_MM = 114;
export const DEFAULT_GRID_MM = 25;

export function createFloor(id: Id, name: string, index: number): Floor {
  return {
    id,
    name,
    index,
    elevationMm: 0,
    defaultCeilingHeightMm: DEFAULT_CEILING_HEIGHT_MM,
    walls: [],
    openings: [],
    rooms: [],
    placements: [],
  };
}

export function createDocument(params: {
  id: Id;
  floorId: Id;
  title?: string;
  displayUnit?: DisplayUnit;
  now?: string;
}): SpaceDocument {
  const now = params.now ?? new Date().toISOString();
  const floor = createFloor(params.floorId, 'Ground', 0);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: params.id,
    title: params.title ?? 'Untitled space',
    createdAt: now,
    modifiedAt: now,
    displayUnit: params.displayUnit ?? 'ft-in',
    gridMm: DEFAULT_GRID_MM,
    catalog: [],
    floors: [floor],
    activeFloorId: floor.id,
    savedViews: [],
    assets: [],
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function findFloor(doc: SpaceDocument, floorId: Id): Floor | undefined {
  return doc.floors.find((f) => f.id === floorId);
}

export function findItem(doc: SpaceDocument, itemId: Id): CatalogItem | undefined {
  return doc.catalog.find((i) => i.id === itemId);
}

export function findPlacement(doc: SpaceDocument, placementId: Id): Placement | undefined {
  for (const floor of doc.floors) {
    const p = floor.placements.find((x) => x.id === placementId);
    if (p) return p;
  }
  return undefined;
}

/** How many of a catalog item are placed, across every floor. */
export function placedCount(doc: SpaceDocument, itemId: Id): number {
  let n = 0;
  for (const floor of doc.floors) {
    for (const p of floor.placements) if (p.itemId === itemId) n++;
  }
  return n;
}

/** Owned minus placed. Negative means more are placed than the inventory records. */
export function unplacedCount(doc: SpaceDocument, itemId: Id): number {
  const item = findItem(doc, itemId);
  if (!item) return 0;
  return item.quantityOwned - placedCount(doc, itemId);
}
