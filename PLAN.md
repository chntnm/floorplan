# floorplan — Implementation Plan

**Location:** `Development/conquerorchin/floorplan/`
**Status:** Planning — nothing built yet
**Date:** 2026-09-01

---

## 1. What This Is

A spatial planning application for laying out furniture and objects in a real space
(new apartment, house, room, office). You bring a floor plan — as a PDF, an image, or
by drawing it yourself — build an inventory of the things you own or are considering,
place them, and walk through the result in 3D.

The document is **fully three-dimensional**. Every object carries a real height and a
base elevation. A rug under a table is not a collision. A wall-mounted shelf at 1400mm
does not block a desk at 750mm. A 2100mm bookcase under a 2050mm sloped soffit is a
violation the app catches. Height is not metadata — it is geometry.

Two synchronized views over one document:

| View | Purpose | Renderer |
|------|---------|----------|
| **Plan** (2D top-down) | Authoring — precise drawing, dimensioning, placement, measurement | Konva (canvas 2D) |
| **Space** (3D) | Verification and traversal — walk the space with arrow keys, check sightlines, headroom, and how it actually feels | three.js / react-three-fiber |

Neither view is the "real" one. Both read and write the same document model.

**Portability is a first-class requirement:** a saved file opens on someone else's
machine with every asset, dimension, and piece of metadata intact.

---

## 2. Stack

```
vite + typescript          build / dev server
react 19                   UI shell, panels, dialogs
zustand + immer            document state, patch-based undo/redo
react-konva (konva)        2D plan editor — hit-testing, transform handles, drag
@react-three/fiber         3D view
@react-three/drei          PointerLockControls, OrbitControls, Grid, Environment
three                      geometry extrusion, raycasting, camera
pdfjs-dist                 render PDF floor plans to raster
fflate                     .space zip container (already proven in courier/)
polygon-clipping           boolean ops for overlap, clearance unions, room areas
node-html-parser           product page parsing (server side only)
vitest                     unit tests — geometry, format round-trip, parsers
@playwright/test           e2e — import → calibrate → place → export → reimport
```

Precedent in this workspace: `courier/` (Vite + TS + pdfjs-dist + fflate) for the
document-ingest half, `akasha/` (three.js WebGL traversal) for the 3D half.

**Why Konva for 2D rather than hand-rolled canvas:** selection handles, rotation
gizmos, marquee multi-select, z-ordering, and hit-testing are weeks of work to build
well and are not the interesting part of this application.

**Why a separate 3D renderer rather than doing everything in three.js:** precise
authoring — snapping a sofa flush to a wall, dimensioning a run of cabinets, tracing a
floor plan — is dramatically easier in an orthographic 2D view with real cursor
precision. The 3D view is where you *verify* and *experience*; the plan view is where
you *build*.

---

## 3. Coordinate Systems and Units

Three coordinate spaces exist. Confusing them is the most likely source of subtle bugs,
so the conversion boundary is explicit, isolated in `src/core/units.ts`, and tested.

| Space | Units | Axes |
|-------|-------|------|
| **Document** (canonical) | integer **millimeters** | `x` east, `y` south, `z` up |
| **Plan view** (Konva) | screen px | `x`, `y` via a pan/zoom affine transform |
| **Space view** (three.js) | **meters** (`mm / 1000`) | `x` = doc x, `y` = doc **z** (up), `z` = doc y |

**Integer millimeters as the canonical unit** is deliberate. Floating-point millimeters
make snapping, equality tests, and "is this flush?" checks unreliable. Integers make
them exact. A millimeter is finer than any real-world measurement in this domain.

**Display units are a view preference**, stored in the document but never used for
computation. Default `ft-in` (US). Options: `ft-in`, `in`, `mm`, `cm`, `m`. All input
fields accept flexible entry — `6'2"`, `74in`, `1880`, `1.88m` — parsed to mm on commit.

Note the axis swap into three.js. three.js is Y-up; the document is Z-up (standard for
architectural plans). One conversion function, one place, unit-tested both directions.

---

## 4. Document Model

### 4.1 The one geometry primitive

Everything with a footprint is a **closed polygon**, optionally with arc segments.
Rect, circle, L-shape, U-shape, rounded-rect, and custom are **generators** that emit a
polygon — not separate classes with separate renderers, separate hit-tests, and
separate serialization.

```ts
type Vec2 = { x: number; y: number };            // mm, integer

type Polygon = {
  pts: Vec2[];                                    // closed ring, CCW, local coords
  arcs?: { afterIndex: number; bulge: number }[]; // optional arc segments
};

type FootprintGenerator =
  | { kind: 'rect';    w: number; d: number; cornerRadius?: number }
  | { kind: 'circle';  r: number }
  | { kind: 'ellipse'; rx: number; ry: number }
  | { kind: 'lshape';  w: number; d: number; cutW: number; cutD: number; corner: Corner }
  | { kind: 'ushape';  w: number; d: number; armW: number; openSide: Side }
  | { kind: 'trapezoid'; wTop: number; wBottom: number; d: number }
  | { kind: 'poly';    pts: Vec2[] };             // freeform / traced

type Footprint = {
  generator: FootprintGenerator;
  outline: Polygon;   // derived from generator, cached; ALL algorithms use this
};
```

The generator is retained so shapes stay parametrically editable ("make this circle
900mm"). The cached `outline` is what snapping, overlap, clearance, area, and extrusion
all consume — one code path.

Circles and ellipses keep their generator so the 2D view can stroke a true arc and the
3D view can build a real cylinder, but every *algorithm* sees the tessellated polygon.

### 4.2 The vertical axis

This is what makes the app 3D rather than a top-down diagram with a height field.

```ts
type Mount =
  | { kind: 'floor' }                        // elevation = 0
  | { kind: 'surface'; hostId: string }      // sits on another object's top
  | { kind: 'wall'; wallId: string }         // shelf, TV, cabinet — uses Placement.elevation
  | { kind: 'ceiling'; drop: number };       // pendant light, fan — drop below room ceiling

type Placement = {
  id: string;
  itemId: string;          // → CatalogItem
  floorId: string;
  position: Vec2;          // mm, center of footprint in document space
  rotation: number;        // degrees CCW about the footprint center
  mount: Mount;
  elevation: number;       // mm, base of object above this floor's datum — DERIVED
                           // for surface/ceiling mounts, explicit for floor/wall
  flipped?: boolean;       // mirror across local Y (handed items: chaise, desk return)
  overrides?: Partial<Pick<CatalogItem, 'color' | 'label' | 'heightMm'>>;
};
```

**Vertical occupancy** for any placement is the interval

```
[ elevation + voidBelowMm , elevation + heightMm ]
```

Two objects collide only if their footprints overlap in plan **and** their vertical
intervals overlap.

`voidBelowMm` is the load-bearing detail, and it is easy to get wrong by omitting it.
A table is not a solid prism from the floor up — it is a top and four legs, with roughly
720mm of open air beneath. Without a void, a rug at `[0, 5]` and a table at `[0, 750]`
"collide," and so does a bin under a desk, and the validation panel is noise from the
first real room. With it, `voidBelowMm` = 720 for a dining table, 700 for a desk, 250
for a bed frame, 0 for a dresser — and every "tucks underneath" case resolves correctly
in one field.

The remaining known gap: a dining chair (`[0, 900]`, including its back) tucked under a
table top at `[720, 750]` still registers as overlapping. A proper multi-segment vertical
profile — a stack of intervals per item rather than one — is the v2 escalation for this.
Since collisions **warn rather than block**, it is a nuisance rather than a wall, and
`voidBelowMm` covers everything else.

**Which room is a placement in?** Several features need this — `ceiling` mount drop is
measured from *a* ceiling, and the headroom check compares against *a* room's
`ceilingHeightMm` — but `Placement` deliberately stores only `floorId`. Room membership
is **resolved at query time** by point-in-polygon on `position` against the floor's rooms,
memoized and invalidated when either the placement moves or room boundaries change.
Storing a `roomId` would mean reassigning it every time a placement is dragged across a
boundary, and a stale one silently produces wrong headroom results. A placement in no
room (a hallway with no traced boundary) falls back to the floor's default ceiling height.

**Surface mounting** is a parent-child relation. A lamp mounted on a nightstand has
`elevation = host.elevation + host.surfaceHeightMm`. Move the nightstand and the lamp
moves with it; raise the nightstand and the lamp rises. `surfaceHeightMm` defaults to
the item's `heightMm` but is overridable for items whose usable surface is not their top
(a desk with a hutch: surface at 750mm, total height 1400mm).

Cycle detection is required on surface mounts — A on B on A must be rejected at the
model layer, not caught by a stack overflow in the renderer.

**Headroom** becomes checkable: a placement whose top exceeds the room's
`ceilingHeightMm`, or which intersects a soffit, beam, or sloped ceiling volume, is a
violation surfaced in the same panel as footprint overlaps.

### 4.3 Catalog vs. placement

Two separate concepts, deliberately. Six identical dining chairs are **one** catalog
entry and **six** placements.

```ts
type CatalogItem = {
  id: string;
  name: string;
  category: Category;         // seating | table | storage | bed | appliance | fixture | decor | ...
  widthMm: number;            // x extent at rotation 0
  depthMm: number;            // y extent at rotation 0
  heightMm: number;           // z extent
  voidBelowMm: number;        // open air beneath — table apron 720, desk 700,
                              // bed frame 250, dresser 0. Drives vertical collision.
  surfaceHeightMm?: number;   // usable top surface, if not heightMm
  canHostSurface: boolean;    // can other items be surface-mounted on top?
                              // true: table, desk, nightstand, dresser
                              // false: bed, sofa, rug, appliance, wall art
  footprint: Footprint;
  defaultMount: Mount['kind'];
  clearances?: ClearanceZone[];
  color: string;
  imageAssetId?: string;      // product photo, stored in the container
  modelAssetId?: string;      // optional GLTF for the 3D view (v2)
  source?: {
    url: string;
    retrievedAt: string;
    confidence: 'confirmed' | 'parsed' | 'manual';
    rawSnippet?: string;      // the text the dimensions came from — auditable
  };
  quantityOwned: number;      // inventory count, independent of placements
  notes?: string;
};
```

Conflating these breaks the inventory list the moment you own more of something than
you have placed. "I own 6, 4 are placed, 2 unplaced" must be expressible.

### 4.4 Structure: walls, openings, rooms, floors

```ts
type Wall = {
  id: string;
  a: Vec2; b: Vec2;          // centerline endpoints
  thicknessMm: number;       // default 114 (interior stud) / 203 (exterior)
  heightMm: number;          // floor to top of wall
  baseElevationMm: number;   // usually 0; nonzero for half-walls on platforms
};

type Opening = {
  id: string;
  wallId: string;
  offsetMm: number;          // distance from wall.a along the centerline
  widthMm: number;
  heightMm: number;
  sillMm: number;            // 0 for doors, ~900 for windows
  kind: 'door' | 'window' | 'cased' | 'pocket' | 'sliding';
  swing?: {                  // read only where the kind has a leaf
    hinge: 'a' | 'b';        // hinged there, or parked there when open
    into: 'front' | 'back';  // which side of the wall
    angleDeg: number;        // 90 typical; drives the swing arc + 3D door panel
  };
};

type Room = {
  id: string;
  name: string;
  boundary: Polygon;         // traced or auto-derived from enclosing walls
  ceilingHeightMm: number;   // per-room — vaulted living room, low bedroom
  floorColor?: string;
  areaMm2: number;           // derived, cached
};

type Floor = {
  id: string;
  name: string;              // "Ground", "Upstairs", "Basement"
  index: number;             // stacking order — see §11.2; array order is insertion order
  elevationMm: number;       // datum of this floor above building zero, signed
  defaultCeilingHeightMm: number;  // for placements outside every traced room
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  placements: Placement[];
  background?: Background;   // imported floor plan raster for this floor
};
```

**Openings are wall-hosted, not walls and not furniture.** A door is not a piece of
furniture that happens to sit in a gap. Hosting means an opening moves when its wall
moves, is constrained to that wall's length, and its swing arc participates in clearance
checks. In 3D, an opening cuts a real hole in the extruded wall mesh and — for doors —
renders a panel at the swing angle.

**One stored field, read according to the kind.** `swing` is the only thing recorded,
and `leafOf` reads it into a shape named for the *leaf*: hinged doors get an angle,
sliding doors get a park end and a face but structurally **no angle to read**, pocket
doors get only a park end, and cased openings and windows get no leaf at all. That is
what stops a slider quietly acquiring a swing angle nobody set, without a second
stored field or a migration. The field is deliberately **retained across a kind
change** — a door turned into a cased opening and back is the door you had, hinged
where you hung it — so a cased opening in a saved file may carry a `swing` that
nothing reads. Losing a choice the user made is the worse trade.

### 4.5 The document

```ts
type SpaceDocument = {
  schemaVersion: number;       // 1 — from day one, with a migration hook
  id: string;
  title: string;
  createdAt: string;
  modifiedAt: string;
  displayUnit: 'ft-in' | 'in' | 'mm' | 'cm' | 'm';
  gridMm: number;              // snap grid, default 25
  catalog: CatalogItem[];      // shared across all floors
  floors: Floor[];
  activeFloorId: string;
  savedViews: SavedView[];     // named camera bookmarks, 2D and 3D
  assets: AssetRef[];          // manifest of what lives in the container
};
```

`savedViews` matter for the portability requirement. "Open my space" should be able to
mean "open my space *standing in the doorway of the living room looking at the sofa
wall*" — the exact framing that motivated the share.

---

## 5. File Format — `.space`

A **zip container**, written and read with `fflate`.

```
myapartment.space
├── manifest.json        { schemaVersion, app, version, createdAt, modifiedAt, title }
├── document.json        the SpaceDocument
├── thumbnail.png        512px plan render, for file browsers and a recent-files list
└── assets/
    ├── bg-ground.png    rendered floor plan raster
    ├── bg-ground.pdf    original source PDF, retained
    └── prod-<hash>.jpg  product images
```

Naked JSON fails the portability requirement the moment a document references a local
PDF. The container is the default. A plain `.space.json` export remains valid and is
offered when a document has no assets — useful for diffing and version control.

`schemaVersion` ships at 1 with a migration registry (`migrations/001-to-002.ts`) and a
no-op entry, so the machinery exists before it is needed. Loading a newer version than
the app understands produces a clear message, not a crash or a silent partial parse.

### 5.1 Save mechanics

Two ways out, one pipeline. The bytes are built identically for both — document,
assets, thumbnail — and only the last step differs.

- **File System Access API** where available (Chrome, Edge) — `showSaveFilePicker`, the
  handle retained in memory so Ctrl+S is a true save-in-place, no download prompt.
- **Download fallback** everywhere else (Firefox, Safari) — anchor with a blob URL. Not
  a degraded mode to apologise for: it is what proved the portability requirement end
  to end through phases 3 to 8, and it is still the fallback when a retained handle has
  lost permission.
- **Import** by file picker or drag-and-drop onto the window. One routing function, so
  a dropped `.space` and a picked one cannot come to differ — including the page picker
  a multi-page PDF raises, which is why the pending inspection lives in the store
  rather than inside the import button.

`supportsSaveInPlace()` reads `window` **at call time**, never at module load. A
snapshot decides for the life of the page from whatever was true during the first
import, which makes the branch unreachable from a test — and headless Chromium *has*
the API, so without the call-time read the download path would ship with no end-to-end
coverage at all and the in-place path could not be driven by a stub either.

A handle is **session state, not document state**: it does not serialize, it does not
survive a reload, and it belongs to one document, so it lives beside the asset store
and `loadDocument`/`newDocument` clear it. A handle that outlived its document would
send the next Ctrl+S into the previous space's file, with no warning and no undo.
"Save as…" exists because otherwise the retained handle is a trap — once a document
has a file there would be no way to write it anywhere else.

**Cancelling is a decision, not a failure.** A dismissed picker throws `AbortError`;
reported as an error it becomes an alert about a save the user chose not to make, and
it is then indistinguishable from a real write failure. It is translated to
`SaveCancelled`, nothing is shown, and the document stays dirty because it genuinely
was not saved. Nothing marks the document clean until a write resolves.

### 5.2 Autosave and recovery

**IndexedDB, two object stores**: documents keyed by document id, assets keyed by asset
id. An autosave that keeps only `document.json` recovers a space whose background is
gone — the same failure `assetMapFor` throws to prevent, reached through a different
door — but rewriting a megabyte of raster every twenty seconds is absurd. The way out
is that an asset is **immutable once stored**: `putAsset` mints a new id for new bytes
and never rewrites an existing one, so assets are written by id exactly once and every
tick after that writes the document record alone. The cost of a tick does not depend on
how big the background is.

§5's "every 20s **and** on every meaningful mutation" is two schedules as written, one
of which writes on every frame of a drag. The reading that satisfies both is a
**debounce with a deadline**: two seconds after the last change, but never more than
twenty seconds since the last write, so continuous activity cannot postpone the write
indefinitely by resetting the debounce on every frame.

**A record is deleted the moment its document is saved to a file.** That rule is what
keeps the prompt worth reading: a surviving record means that document had unsaved
changes when the tab went away. Without it every clean reload offers to recover work
already saved, and the prompt is trained out of the user long before the one time it
matters.

Recovery has **two offers**, because §5's "newer than the opened file" answers the easy
half and the case that matters after a crash is the one it does not describe — there is
*no* opened file. The tab died with an hour of drawing in it and comes back on a fresh
empty document whose id the record has never heard of.

- `newer` — an autosave for *this* document holding a later edit than the file that was
  opened. Compared on the document's own `modifiedAt`, not on when the autosave ran:
  the question is which state is further along, not which write happened last.
- `orphan` — the current document is structurally untouched, so there is nothing to
  lose, and an autosave for another document exists.

A restored document arrives **dirty**. It has never been written to a file, and opening
it clean would let the user close the tab a second time on the same unsaved work. There
is no handle either, so the next save asks where to put it — which is why recovery does
not pretend to restore "the file you were working on".

Every database call resolves rather than rejecting when IndexedDB is unavailable,
blocked by a privacy setting, or over quota. A safety net that can take down the
application it is protecting is a worse bargain than no net.

### 5.3 Thumbnail

Rendered **offscreen from document geometry**, not from `stage.toDataURL()`. The stage
version couples saving to the plan view being mounted — there is no stage in 3D mode —
and captures the current pan and zoom, so the picture is whatever corner of the plan you
were looking at rather than the plan.

Split so the seam is testable: the fit transform and the ring extraction are pure, and
what is left is `ctx.fill()`. The active floor only, framed on its own extent — the
ghost underlay is excluded for the same reason it is excluded from `floorBounds`. The
extent covers **placements as well as rooms and walls**, unlike `floorBounds`: an
inventory-first document with furniture and no structure yet has a perfectly good
picture and would otherwise produce none.

An empty floor gets **no thumbnail** rather than a blank square, and no failure in this
path can fail a save — losing a preview is cosmetic, and there is no environment where
the fix is to give up on the document.

---

## 6. Getting a Floor Plan In

Two paths, converging on the same result.

### 6.1 Import a PDF or image

The critical insight: **PDF import is a background-image feature, not a
geometry-extraction feature.** Automatic wall detection from a raster is a computer
vision research problem. It is not v1, and pretending otherwise sinks the schedule.

```
select file (PDF / PNG / JPG)
  → [PDF] pdfjs getDocument → page picker → page.render() to canvas at chosen DPI
  → store raster as an asset, retain the original file too
  → ▶ CALIBRATION GATE ◀   (blocking — cannot proceed)
  → background locked, opacity slider exposed
  → user traces walls with the same tools as manual mode
```

**The calibration gate is the single most important step in the application.**

A PDF floor plan has no intrinsic real-world scale. Vector CAD exports use arbitrary
drawing units; scans are just pixels. Furniture dimensions arrive in inches and
centimeters. Without calibration, every downstream placement is wrong — and wrong in a
way that looks plausible, which is worse than obviously broken.

So: the user draws a line across a known dimension — a stated room width, a standard
door (813mm / 32"), a printed scale bar — and types the real length. The app computes
`mmPerPx` and stores the reference:

```ts
type Background = {
  assetId: string;
  sourceAssetId?: string;    // the original PDF
  pageIndex?: number;
  calibration: {
    refA: Vec2; refB: Vec2;  // in image pixel coords
    realLengthMm: number;
    mmPerPx: number;         // derived
  };
  transform: { position: Vec2; rotationDeg: number };
  opacity: number;           // default 0.45
  locked: boolean;           // default true
};
```

This is a **blocking modal in the import flow**, not a setting buried in a panel. It is
re-openable later ("recalibrate") because people get it wrong the first time. A
document with an uncalibrated background refuses to accept placements and says why.

Deferred to v2: vector path extraction via pdfjs `page.getOperatorList()`, which for
CAD-exported PDFs can yield actual line segments and skip tracing. Same foundation, an
additional input to the same tracing layer.

### 6.2 Draw it manually

No file, or a plan too poor to trace. Same tools, no background:

- **Wall tool** — click-drag chained segments, live length + angle readout, snaps to
  15° increments and to existing endpoints; type an exact length to commit a segment.
- **Room rectangle** — drag a rectangle, get four walls; type `W × D` for exact.
- **Shape tools** — the full generator vocabulary for non-rectangular boundaries.
- **Dimension tool** — annotate any two points; annotations persist in the document.

Both paths produce identical structures. One code path.

---

## 7. Inventory

The inventory panel lists `CatalogItem`s with quantity owned and quantity placed. Items
exist independent of placement — you can build a shopping list before you have a floor
plan, and unplaced items are exactly the point of the exercise.

### 7.1 Manual entry (primary path)

Name, category, `W × D × H`, footprint shape, mount type, color, optional photo. Fast,
keyboard-driven, always available. Preset library seeded with standard dimensions
(queen bed 1524×2032, interior door 813, dishwasher 610) so common items are one click.

### 7.2 Product URL import (convenience path)

**A browser cannot fetch a retailer's product page** — CORS blocks it. This requires a
server-side fetch:

```
POST /api/product-lookup   { url }
  → server-side fetch (respects robots.txt, identified UA, rate-limited, cached by URL hash)
  → parse, in order:
      1. <script type="application/ld+json">  schema.org/Product
         → name, image, offers.price, additionalProperty[], width/height/depth QuantitativeValue
      2. microdata itemprop attributes
      3. OpenGraph  og:title, og:image        (name + image only)
      4. regex over the spec table / description text
  → { name, widthMm, depthMm, heightMm, imageUrl, price, confidence, rawSnippet }
```

Dimension patterns the text fallback handles:

```
84"W x 38"D x 32"H          →  W/D/H suffixed
W 84 in x D 38 in x H 32 in →  W/D/H prefixed
213 cm x 96 cm x 81 cm      →  bare triple, order inferred from labels or W×D×H default
Width: 84 in                →  labeled rows in a spec table
6 ft 2 in                   →  feet-inches compound
```

**The result always lands in a confirm-before-add dialog** with every field editable,
the source URL shown, and the raw text snippet the numbers came from displayed
alongside. A scraped dimension never becomes geometry unconfirmed. Confidence is stored
on the item (`parsed` vs `confirmed`) and parsed-but-unconfirmed items are flagged in
the inventory list.

Deployment: Vite dev middleware in development, one serverless function in production.
**The app remains fully functional as a static build with the endpoint absent** — URL
import degrades to a message pointing at manual entry. This is a convenience layer, not
a dependency.

---

## 8. Editing: Modes and Layers

The layer toggle from the requirements, made concrete as a mode enum that drives
hit-testing, the tool palette, and rendering:

```ts
type EditMode = 'plan' | 'furnish';
```

| | `plan` mode | `furnish` mode |
|---|---|---|
| Walls, rooms, openings | editable, hit-testable | rendered, **not hit-testable** |
| Background raster | movable, recalibratable | locked, dimmed |
| Placements | dimmed, not selectable | editable |
| Tool palette | wall, room, shape, opening, dimension, calibrate | select, place, rotate, measure |

Switching to `furnish` sets `listening={false}` on the entire plan Konva layer and
`cache()`s it — the structure becomes a single bitmap. This is both the interaction
model the requirements asked for and the main 2D performance win.

Undo/redo is global and linear across both modes, implemented as immer patch pairs on
the zustand store. Mode switches are not undoable steps.

The store is split into a **document slice**, where every mutation records a patch
pair, and an **editor slice** (tool, draft, cursor, selection, viewport, modes) that
records nothing. A gesture in progress lives entirely in the editor slice and touches
the document exactly once, on release. Without that split a drag would leave one undo
entry per mousemove and Ctrl+Z would appear to do nothing.

**Finishing a polyline is same-place, not double-click.** Konva's `dblclick` fires on
any two clicks inside a 400ms window with no distance check at all, so drawing two wall
points quickly — which is how anyone draws — ends the chain at the second point.
Clicking the same spot twice is the gesture people actually mean, and it needs no
timer; Enter and closing the loop also finish.

**The hit graph does not take effect until the next draw.** Konva keeps hit-test
geometry in a separate canvas that is only refreshed when the layer is drawn, so
anything changing what is hittable is invisible to a click arriving in the same
frame. Two triggers, both load-bearing: a layer switched on is still deaf (pick
Select and click a wall fast enough and nothing happens), and a shape that first
appeared this frame is not in the hit canvas yet (place an item, click it straight
away, and it does not select). Three consequences: the *tool* is checked inside the
shape handlers rather than by toggling `listening`; the *mode* switch calls
`drawHit()` from a layout effect; and so does a change in the number of shapes on a
layer.

**Nothing above the canvas may change height during a gesture.** The calibration gate
is a band directly above the stage; an early version swapped a one-line prompt for the
length form on mousedown, the band grew, the stage shifted down under the pointer, and
a reference drawn as 3000mm committed as 3048mm — with every dimension traced
afterwards inheriting the error. Controls there are rendered disabled, not absent, and
the error line reserves its space.

---

## 9. Placement Quality

### 9.1 Snapping

- **Grid** — configurable, default 25mm, toggle with `G`.
- **Wall snap** — within tolerance, translate so the footprint edge is flush against
  the wall's inner face and rotate to match the wall angle. Items with
  `defaultMount: wall` or a `backToWall` affinity (sofas, beds, dressers) snap more
  eagerly and orient automatically.
- **Object edges** — align and abut to other placements; alignment guides render like
  a design tool's smart guides.
- **Angle** — rotation snaps to 15° increments, `Alt` to override.
- **Vertical snap** — dragging an object over another whose `canHostSurface` is true
  converts the mount to `surface` and seats it exactly on top. Dragging it off returns
  it to the floor. Without that flag, a lamp dragged across the room would mount itself
  to whatever it happened to pass over.

Hold `Alt` to suppress all snapping.

### 9.2 Collision — genuinely 3D

```
collides(A, B) =
     polygonsIntersect(worldOutline(A), worldOutline(B))
  && intervalsOverlap(solidSpan(A), solidSpan(B))

solidSpan(P) = [ P.elevation + item.voidBelowMm,
                 P.elevation + item.heightMm ]
```

Broad phase by AABB, narrow phase via `polygon-clipping` intersection. Collisions
highlight in red and list in a validation panel — they **warn, never block**. Sometimes
you mean it, and an app that refuses to let you do something you understand is worse
than one that tells you and gets out of the way.

Additional 3D-only checks:
- **Headroom** — `elevation + heightMm > room.ceilingHeightMm`
- **Door swing** — the swept arc, from sill to head, against **object volumes only**.
  Walls are not tested: a door swinging back to rest against the adjacent wall is how
  doors are hung, and flagging it would fire on nearly every door in a corner. The
  sector is polygonised at one vertex per 5°, because it is a collision polygon and a
  chord cuts *inside* the true arc — too coarse and a narrow object at the outer edge
  falls into the gap and is never reported. A slider is checked against the wall it
  parks over instead; a pocket door is checked against nothing in the room, which is
  the entire argument for fitting one, and instead has to prove its cavity exists.
- **Wall-mount validity** — a wall-mounted item whose span exceeds its host wall, or
  which overlaps an opening

**Never bake rotation into stored vertices.** Footprints stay in local coordinates;
world geometry is derived per query as `rotate(outline, rotation) + position`. Baking
accumulates floating-point error across repeated rotations and makes "reset rotation"
impossible to implement correctly.

### 9.3 Clearance and circulation

Two distinct checks, both explicit and implementable — not a research problem.

**Item clearance zones.** A catalog item declares zones attached to a footprint edge:

```ts
type ClearanceZone = {
  edge: 'front' | 'back' | 'left' | 'right';
  depthMm: number;
  reason: string;   // "drawer pull" | "dishwasher door" | "chair pull-out" | "oven door"
  heightMm?: number; // vertical extent — a drawer zone doesn't care about a wall shelf above it
};
```

Zones transform with their placement. Anything solid intruding into a zone within its
vertical extent is a violation, listed with its reason. Presets ship with the standard
library: 900mm in front of dressers, 1067mm behind dining chairs, 1200mm at appliance
doors.

Three things fell out of building it that are worth stating.

**Walls are not obstructions for a zone.** Wall snap seats an item's back edge *on*
the wall face, so a `back` zone tested against walls fires on every chair pushed
against one — the default outcome of using the snap, not a corner case. This is the
same rule phase 6 settled for door swings. The question "is there room to get past
this" is a different question, and the walkway probe below is what answers it, with
walls very much included. Two checks, deliberately.

**The step-over threshold belongs to the intruder, not to the zone.** A rug in front
of a dresser is not a blocked drawer. The fix is *not* to lift the zone's floor —
that exempts a band of space and hides a 90mm shoe rack sitting in it. What makes the
rug irrelevant is that you step over it, so the zone runs from the floor and anything
whose solid top is below `CLEARANCE_STEP_OVER_MM` is skipped: the same shape of rule
as `voidBelowMm` and the walker's `STEP_OVER_MM`.

**A zone is a rectangle off the local bounding box.** "Attached to a footprint edge"
is the spec, and a bounding-box edge is the only edge a circular table has. It goes
through `toWorld` — the transform the outline itself uses — so rotation and flipping
come out right by construction rather than by two formulas agreeing.

**Walkway width probe.** The user draws a path polyline through the space; the app
reports the narrowest gap along it. Flags anything below the threshold (762mm / 30").

**Measured against a body, not at a height.** This spec originally said 900mm — "hip
height, where you actually squeeze past furniture, not floor level where a sofa base
is narrower than its arms". The floor half of that is right and the fix is not: **a
standard sofa back is 840mm**, so a ray at 900 passes straight over this section's own
example and reports a clear walkway through the middle of the couch. A dining table at
760 and a dresser at 810 go the same way, and any single height is either low enough
to catch table legs or high enough to miss the furniture. So the probe asks what
traversal already asks — is anything solid inside `[STEP_OVER_MM, STAND_HEIGHT_MM]`,
imported from `walk.ts` rather than restated, so there is one definition of what a
body takes up. The walker's answer about a doorway and the plan's answer about a gap
can then never disagree.

**The route is editor state, not document state.** It is a question asked of the
plan, like a measurement, not a part of it — nobody else opening the file drew it.
Storing the *path* rather than the answer is what makes it worth having: move the
sofa 100mm and the number moves with it. It survives a tool change, unlike a
measurement, and the tool stays available in furnish mode, because "can I still get
past?" is a question you ask while pushing furniture around.

**What the sampling can miss.** The path is sampled at its vertices and every 100mm
between them, and each sample casts one ray to each side. The answer is the narrowest
gap *at a sample*, not the true infimum: a table leg between two samples is stepped
over, and a diagonal pinch is measured square to the path. Vertices are always
sampled because a path turns where a room pinches. Stated rather than implied.

Full medial-axis navmesh analysis of the free space is explicitly out of scope. The
probe answers the real question — "can I get from the door to the couch?" — at a
fraction of the complexity.

---

## 10. The 3D Space View

Not a preview. A second first-class view over the same document, and the reason the
vertical axis is modeled properly throughout.

### 10.1 Building the scene

Everything derives from the document — there is no separate 3D scene graph to keep in
sync.

- **Walls** — `THREE.ExtrudeGeometry` from the wall's rectangular plan profile, extruded
  to `heightMm`. Openings are subtracted as boolean holes (precomputed per wall,
  rebuilt only when that wall's openings change).
- **Floors and ceilings** — room boundary polygons triangulated and placed at the floor
  datum and at `ceilingHeightMm`. Ceilings hide when the camera is inside the room, or
  render single-sided so you can look in from above in orbit mode.
  **Shipped as a global toggle, default off**, rather than as camera-aware hiding.
  Deciding "is the camera inside this room" per frame per room is a point-in-polygon
  test against a moving target, and getting it wrong flickers the ceiling on and off
  as you cross a threshold. A switch is legible and always right; the cost is that
  walk mode has no ceiling overhead until it is turned on.
- **Placements** — extruded from the same `outline` polygon that the 2D view draws and
  the collision engine tests, raised to `elevation`, height `heightMm`. Circles and
  ellipses build true cylinders from their generator. One primitive, three consumers.
- **Doors** — a real panel at the swing angle, hinged on the *face* it opens onto
  rather than on the centreline (half a wall thickness, invisible in a drawing and a
  systematic bias in every clearance answer if skipped). Windows get a transparent
  pane. A pocket door draws no leaf at all, because its leaf is inside the wall.
  **Glazing blocks the walker and an open door does not** — glass is something you
  cannot walk through, while a leaf drawn open would otherwise narrow its own doorway
  by however far it happens to have been swung, and there is no way to push it.
- **Appearance** — v1 is flat category colors with soft shading, plus the product
  thumbnail applied to the top face for identification from above. `modelAssetId` is
  reserved in the format for GLTF models in v2; nothing else changes when they land.

### 10.2 Traversal — arrow keys, like akasha

Two camera modes, toggled with `Tab`:

**Walk mode** (default)
```
↑ / W        forward            eye height 1650mm, follows floor datum
↓ / S        back               collision against walls + object volumes
← / →        turn               capsule radius 250mm
A / D        strafe
Q / E        turn               drag-to-look for pitch and fine aim
Shift        run (2×)
Space        step up — raises the body interval's floor to 450mm
C            crouch — eye height 1100mm, body top 1250mm
```

**Built, with two deliberate departures.** The arrow keys **turn** rather than strafe:
the requirement is arrow-key traversal, and with turning bound only to `Q`/`E` someone
using the arrows alone can never change direction. `A`/`D` strafe instead. And look is
**drag-to-look**, not `PointerLockControls` — pointer lock takes over the cursor,
prompts, and cannot be driven by a test, and click-to-select needs the pointer anyway.

**Step up is not a key that teleports you.** It is the *bottom of the body interval*:

```
body = [ feet + stepClearance , feet + standingHeight ]     // [200, 1800] normally
```

With a body of `[0, 1800]` a 5mm rug is a collision — `[0,5]` and `[0,1800]` genuinely
overlap — and the walker is stopped dead by a carpet. Starting the interval at a
stride's clearance is what makes every case fall out of one number, the same shape of
fix as `voidBelowMm`. `Space` raises the clearance to 450 for a deliberate step; `C`
lowers the *top* to 1250 so you can duck. Ground height then follows whatever is
underfoot, rising at most a stride and falling as far as there is to fall.

Collision is 2D circle-vs-polygon against every object whose `solidSpan` overlaps the
walker's body interval `[0, 1800]` — which is exactly why the vertical model has to be
right. You walk *over* a rug, *under* a wall-mounted shelf, and *into* a dresser, with no
special cases. Crouching narrows the body interval to `[0, 1250]`, so you can duck under
things you otherwise can't pass.

**Orbit mode** — the whole space, or the active floor. Arrow keys pan, drag to orbit,
scroll to zoom. Dollhouse framing with ceilings hidden.

**Fly mode** (`Tab` again) — walk controls plus `R`/`F` for elevation, collision off.
Useful for inspecting wall-mounted and ceiling items.

### 10.3 Interaction in 3D

- Click to select — raycast into the scene, selection syncs to the plan view and the
  properties panel.
- Drag on the ground plane to reposition (raycast to the floor plane, XY only);
  elevation is edited numerically in the panel. Precise work belongs in plan view.
- Saved views — `savedViews` bookmarks capture camera position, target, and mode, and
  travel with the file.

### 10.4 Performance

Target 500 placements at 60fps. Instanced meshes for repeated catalog items (six
identical chairs are one draw call), frustum culling, static geometry merged per floor,
and only the active floor rendered by default with lower floors available as a dimmed
underlay.

---

## 11. Multi-Room and Multi-Floor

Rooms are named polygons with computed area and a per-room ceiling height, either traced
directly or auto-derived by detecting closed loops in the wall graph.

Floors stack along the document's Z axis at their `elevationMm`. In plan view, one floor
is active and the floor below renders as a dimmed ghost for alignment — which is how you
get a staircase to land in the right place. In the 3D view, floors stack for real, with
a toggle for showing all floors, the active floor only, or a cutaway.

The catalog is shared document-wide; placements reference their `floorId`. Moving a
placement between floors is an explicit action, not a drag.

### 11.1 Detection

Wall centrelines form a planar graph once they are split at every crossing **and every
T-junction**; its faces are found by the standard half-edge walk, keeping the first edge
clockwise from the way back. Interior faces come out with positive signed area and each
connected component's outer face negative, and **that sign is the test** — not "discard
the biggest", which gets a courtyard backwards, because the outer face of an inner ring
of walls is smaller than the room around it.

The T-junction split is the one that decides whether detection works on a real plan. A
partition drawn to butt into the middle of another wall has its endpoint on that wall's
*interior*; with no node there the graph has no branch and the walk hands back the
single loop around the outside.

**Boundaries are centrelines**, matching `commitRoomRect`, so a drawn room and a
detected one describe the same walls with the same number. Insetting by half a
thickness would be nearer the floor area you could carpet and would make the two paths
disagree about every room drawn by hand. Rings are canonicalised to start at their
lowest corner, which is what makes a second run a genuine no-op rather than a rewrite
of every boundary in the document.

**Detection adds and updates; it never deletes.** An Area-tool room has no walls at all
— that is the point of `commitShapeRoom` — so removing rooms with no supporting loop
would delete a legitimate one on every run. Unmatched rooms are reported and left
alone. Reporting them as a *validation issue* was considered and rejected for the same
reason: it would flag every shape room forever, which is noise, not a finding.

Matching is by **overlap area**, greedily, largest first. Centroid containment is
cheaper and breaks where it matters: partition a room and the old centroid may land in
either half, or inside the partition. Overlap gives the larger half the old name — the
one a person would still call the living room — and the smaller half becomes a new room.

A detected room is a **simple ring**. `Polygon` has no holes, so an island of walls
inside a room does not punch one: a courtyard is detected as its own room *and* left
inside the ring around it.

### 11.2 The stack

`index` is the stacking order and the array is insertion order. Two places to look for
one answer, so `orderedFloors` is the only thing that sorts and nothing else reads array
position — which matters the first time someone adds a basement, because it takes index
−1 and is appended, and the two orders disagree permanently from then on.

A new floor's elevation is **suggested, not derived**: the floor below it plus that
floor's tallest ceiling plus `FLOOR_ASSEMBLY_MM`. It is then an ordinary editable signed
number, because a split level, a mezzanine and a garage half a storey down are all real
and none of them survive a formula. Floors are added at the ends only; inserting between
two would renumber every floor above and make one gesture an edit to the whole building.

Switching floors writes `activeFloorId` **without recording history**. Undo has to walk
back the edits you made; having it teleport you between storeys instead would make the
stack unusable. It still marks the document dirty, because reopening a three-storey
house on the floor you left it is why the field is in the document rather than in the
editor. The same switch clears the selection, the draft, any drag in progress and the
walkway route — `pruneSelection` would keep all of them, since a wall on the floor below
still exists perfectly well.

Moving a placement between floors carries **everything standing on it**, however deep,
or a surface mount is left pointing at a host on another floor — which `findPlacement`
resolves happily, into an elevation measured against the wrong datum. A `wall` mount
names a wall that does not exist over there and is re-seated on the floor, reported
rather than discovered. Deleting a floor performs the same repair for anything elsewhere
mounted onto it, and refuses the last floor outright.

### 11.3 What each view does with the stack

The plan view draws the floor below as an underlay that **participates in nothing**:
`listening={false}`, absent from the wall and room counts, and absent from `floorBounds`
and therefore from zoom-to-fit. That last one is what keeps the viewport still across a
floor change, without which aligning an upstairs wall over the one holding it up would
be impossible. The `listening` flag is load-bearing and not merely tidy: PlanStage reads
a click as empty canvas by `e.target === stage`, and that is what clears the selection
and starts a pan.

The space view stacks floors for real, each built by `buildScene` in its own frame and
shifted by its elevation relative to the active floor's datum — so the active floor
keeps the coordinates the rest of the application uses. `active` shows it alone, `all`
shows the building, and `cutaway` is named for what it removes: the floors above, which
are otherwise a lid. Other floors are dimmed, lose their ceilings (the slab above is the
ceiling) and **do not take clicks**, since selecting one would put something in the
panel that the plan view cannot show and the delete key would then remove from a storey
you are not on.

**Validation is active-floor scoped**, and the panel says so once there is more than
one floor. Overlaps, headroom, clearance and swing all run against the floor you are
editing, so a problem upstairs is invisible while you are downstairs — including in a
file handed to someone else. Widening `validateFloor` to the whole document is not the
fix on its own: every issue would then need to name a floor and clicking one would have
to change floors before it could select anything, which is a phase 9 job. Naming the
scope is what stops "No issues" reading as a claim about the building.

**Collision always comes from the active floor**, whatever the display toggle says.
Feeding the stack to the walker would make traversal depend on a view setting — and
since floors default to `elevationMm: 0`, a second floor added before its elevation is
set would put you inside the walls of a storey you were only looking at. Two questions,
one of which includes things the other does not; the same shape of split as clearance
and the walkway probe in §9.3.

---

## 12. Phasing

Each phase ends at something runnable. The URL-import server and the 3D view are
isolated so neither blocks the core editor.

| Phase | Deliverable |
|-------|-------------|
| **0** | Scaffold: Vite + React + TS, vitest, playwright, lint, CI. Empty app shell. |
| **1** | **Geometry core** — units, mm integers, polygon primitive, all generators, rotation/transform, area, SAT + clipping overlap, vertical intervals. Pure functions, no UI, heavily tested. Document model + `.space` read/write + migration hook. Round-trips a hand-authored fixture. |
| **2** | **Plan editor** — Konva stage, pan/zoom, wall/room/shape tools, dimension tool, grid + snapping, selection and transform (wall endpoint and body drag), mode toggle, undo/redo. Draw a floor plan by hand and save it. Room *reposition* is deliberately not included: rooms and their walls are separate entities, and moving one without the other desynchronises them — redraw instead until phase 8 relates them. **Phase 8 kept half of this.** Detection is the relating mechanism: a boundary derived from the wall graph re-derives when the walls move, so the way to reposition a room is now to move its walls and press Detect rooms, which reshapes the room in place and keeps its name and ceiling. Dragging a room boundary directly is still not implemented and is no longer planned for v1 — it is the gesture that desynchronises, and the one that does not now exists. |
| **3** | **Import + calibration** — PDF via pdfjs (dynamically imported, so the 437kB renderer stays off first paint), image import, the blocking calibration gate, background transform/opacity/lock, tracing over a real plan. An uncalibrated background is shown at a nominal 6m width so the reference line is drawable *and* so the transform is invertible before a real scale exists; calibrating rescales about `refA` so the point the user anchored on does not move, and `transform.position` stays a float because rounding it would drift the anchor on every recalibration. Import deliberately does not re-fit the viewport. Deferred: thumbnails and File System Access (phase 9), vector path extraction (v2). |
| **4** | **Inventory** — catalog/placement split, manual entry, preset library, quantity tracking, placement onto the plan with wall snap, surface snap, rotation, and 3D overlap warnings. **First genuinely useful build.** Wall snap seats the footprint's *back edge* (local −y) on the wall's near face and rotates to match, never the centre on the centreline. The calibration gate stops being decorative here: `addPlacement` throws `PlacementBlockedError` carrying the same sentence the validation panel shows, and the Place button is disabled rather than offered-and-refused. Deleting a placement re-seats anything surface-mounted on it, so the document never references a host that is gone. Headroom arrives early — `exceedsHeadroom` already existed — but clearance zones (7) and door swing (6) are still out. |
| **5** | **3D space view** — extrusion from document geometry, orbit mode, walk mode with arrow-key traversal and collision, mount types (floor/surface/wall/ceiling), elevation editing, headroom checks, saved views. **Includes opening *geometry*** — wall-hosted openings and the holes they cut in the extruded walls, without swing. A sealed walker who cannot leave the first room does not demonstrate traversal, so the doorways have to exist here. An opening cuts a wall in *elevation*, not in plan, so `ExtrudeGeometry` holes were never the answer: `wallSegments` **splits** the wall into the solid boxes that remain — flank, sill wall, lintel, flank — which needs no CSG and hands the same list to the renderer, the walker and the validation panel. A doorway is passable because the only solid above it starts at 2032mm, with no "is this a door" check anywhere in traversal. The walk simulation deliberately lives *outside* three.js: a plain rAF loop over pure functions, so the camera consumes the walker rather than owning it, the position readout survives a browser with no WebGL, and traversal is testable without a GPU. Deferred and stated rather than claimed: **instancing** (§10.4's 500-at-60fps target is unmeasured — one mesh per solid today), and a real contact-normal collision resolver (moves are retried per axis, so diagonal walls slide stickily). |
| **6** | **Openings, complete** — swing arcs in 2D, hinged door panels and window panes in 3D, sliding/pocket/cased variants, swing-vs-object clearance. The five kinds behave in four different ways, and the difference is the reason the kinds exist: hinged doors need their swept sector clear, sliders need the wall they park over clear, pocket doors need **nothing** in the room clear and instead need a cavity that can exist, and cased openings and windows need nothing at all. The swept sector is computed once and serves three consumers — its boundary *is* the 2D door symbol (closed leaf, arc, open leaf), it is the clearance polygon, and it positions the 3D panel — so the drawing and the check cannot disagree about where the door goes. Hanging the leaf is done with **flip buttons, not selects**, because there is no honest label for the two sides of a wall; the arc in the drawing is what makes the choice legible. The angle field holds its text locally and commits on blur or Enter, like the room name and every length field: writing per keystroke to a value that is *clamped* means the `1` of `135` is stored as `15` and the rest of the number is typed against that, so no angle whose first digit falls below the floor can be entered at all. `fill()` in a test never sees it, because it delivers the whole value in one change event. Deferred and stated rather than claimed: **windows do not open** (a casement sash would swing like a door and is not built), and the 3D layer-toggle gate on a door leaf is covered by an exhaustive unit test over `refIsEditable` rather than end to end — in the orbit view a leaf is a slab a few pixels wide seen edge-on, and walk mode does not take selection clicks at all, so hunting for it with a grid of clicks would test where the camera happens to sit. |
| **7** | **Clearance and circulation** — clearance zones on catalog items, the standard preset library, walkway width probe, consolidated validation panel across overlap/headroom/clearance/swing. Two checks that sound alike and are not: a zone asks whether a drawer opens, the probe asks whether a person fits, and they differ on whether walls count (see §9.3 — they do not for a zone, they do for the probe). Zones are drawn on the selected item only, for the reason the swing arc is drawn: a warning that says "the bookcase blocks the drawer pull" is an argument and the hatched rectangle is the evidence — but six dining chairs with pull-out zones would carpet the floor in hatching and say nothing. The probe stores the *route*, not the number, so it re-answers as furniture moves; the tool stays live in furnish mode for the same reason. The panel groups by what you would do about a problem rather than by the issue enum, keeping `validateFloor`'s blocking-first order rather than forming a second opinion about severity in the component least qualified to have one. Deferred and stated rather than claimed: **the 900mm probe height in §9.3 was wrong and is now a body interval** — a sofa back is 840mm, so the specified ray passed over the one piece of furniture the spec named; and the full medial-axis navmesh remains explicitly out of scope, so the probe reports the narrowest gap *at a sample*, not the true infimum. |
| **8** | **Multi-room and multi-floor** — room detection and areas, per-room ceiling heights, floor stacking, ghost underlay, 3D floor toggles. Detection keeps planar-graph faces **by sign** rather than by magnitude, because a courtyard's outer face is smaller than the room around it; and it splits walls at T-junctions as well as crossings, which is the pass that decides whether it works on a real plan at all. Boundaries are centrelines, matching the Room tool, and rings are canonicalised so a second run is a genuine no-op — both asserted, because two paths that describe the same walls with different numbers is the failure this phase exists to avoid. Detection **never deletes**: an Area-tool room has no walls by design, so removing what detection cannot see would delete a legitimate room every run; unmatched rooms are reported and left. Ceiling height became editable, which is what makes it worth having — the headroom check reads it through `ceilingHeightAt`. On the stack: `index` is the ordering and nothing reads array position, a floor switch is silent in history but dirty on disk, and moving a placement carries everything standing on it while re-seating what named a wall it left behind. The plan ghost participates in nothing — not the hit graph, not the counts, not `floorBounds` — and the `listening` flag is load-bearing rather than tidy, since PlanStage reads empty canvas by `e.target === stage`. **Collision stays on the active floor whatever the 3D toggle says**, the same two-questions split as §9.3 — and in the space view a solid on another floor declines the click *before* stopping propagation, or the top storey would swallow every click meant for the floor below it. Deferred and stated rather than claimed: room-boundary dragging is dropped for v1 in favour of move-the-walls-and-re-detect (see row 2), floors can only be added at the ends of the stack, and a detected room is a simple ring — an island of walls inside one does not punch a hole in it. |
| **9** | **Polish and portability** — File System Access save-in-place, IndexedDB autosave and recovery, thumbnails, product URL lookup endpoint + confirm dialog, export/import e2e, migration tests. |

Phases 4 and 5 together are the point at which the application does what it exists to
do. Everything after is depth.

---

## 13. Testing

- **Geometry (vitest)** — the highest-value tests in the project. Rotation round-trips
  to identity, area invariance under rotation and translation, generator→polygon
  correctness at boundary parameters, overlap true/false positives including the
  vertical cases (rug under table, bin under desk, boxes under a bed frame, shelf above
  dresser — each asserted as *not* colliding), mm rounding stability under repeated
  transforms, surface-mount cycle rejection.
- **Format round-trip** — document → `.space` → document deep-equals, with assets.
  Fixture files checked in per schema version; every migration tested against a real
  fixture from the previous version. `src/core/fixtures/schema-v1.space` is that file
  for schema 1: written once, hand-authored rather than produced by `createDocument`,
  and committed. Nothing regenerates it, because a fixture produced by the same build
  that reads it asserts only that today's writer agrees with today's reader. There is
  no migration to test yet — `MIGRATIONS` is empty at schema 1 — so the chain itself is
  exercised through the `migrateTo` seam with temporarily registered fakes, plus the
  three error paths. When a schema 2 arrives, the v1 tests do not change: the correct
  response to a failure is a migration, not a new fixture.
- **Product parsers** — saved HTML fixtures from real retailer pages checked into the
  repo. **No network in CI.** Each fixture asserts extracted dimensions and confidence.
- **e2e (playwright)** — import PDF → calibrate → trace walls → add item → place →
  enter 3D → walk → export → reimport → assert identical document.

---

## 14. Explicitly Out of Scope for v1

- Automatic wall detection from raster floor plans (CV problem)
- PDF vector path extraction (v2 — deferred, not designed out)
- Photorealistic rendering, materials, real lighting simulation
- GLTF furniture models (the format reserves `modelAssetId`; the loader is v2)
- Real-time multi-user collaboration (the file format is the sharing mechanism)
- Cost estimation, shopping cart integration, purchase tracking
- Automatic layout suggestion / "arrange this room for me"
- Mobile-first touch UI (desktop first; touch is not designed against)
- Multi-segment vertical profiles (a stack of solid intervals per item, rather than one
  span with a void beneath). v2 escalation — see §4.2. Until then, chairs tucked under
  tables report a benign overlap warning.

---

## 15. Open Questions

1. **Retailer coverage for URL import** — which sites to build fixtures against first?
   IKEA, Wayfair, Article, West Elm, CB2 all publish clean JSON-LD; Amazon does not.
2. **Room auto-detection** — worth building the wall-graph loop finder in phase 8, or
   is manual room tracing sufficient indefinitely?
3. **Sloped ceilings** — attics and dormers break the flat `ceilingHeightMm` assumption.
   Model as a ceiling plane with a slope, or defer?
4. **Stairs** — as a placement category with a footprint, or as real structure connecting
   floors? Real structure is correct and considerably more work.
