# roomplan

Spatial planning for real rooms. Import a floor plan, build an inventory of what you
own, place it, and walk through the result in 3D.

The document is fully three-dimensional. Every object carries a real height and a base
elevation, so a rug under a table is not a collision, a wall shelf at 1400mm does not
block a desk at 750mm, and a 2100mm bookcase under a 2050mm soffit is a violation the
app catches.

> **Status: phase 2.** The plan editor works: draw walls, rooms and shapes by hand
> with grid/angle/endpoint snapping, select and delete, undo/redo, and save to a
> `.space` file another machine can open. Floor plan import (phase 3), the inventory
> (phase 4) and the 3D view (phase 5) are not built yet. See [PLAN.md](./PLAN.md).

## Quick start

```bash
pnpm install
pnpm dev            # http://localhost:5190
```

## Scripts

| Script | Does |
|--------|------|
| `pnpm dev` | Vite dev server |
| `pnpm build` | Typecheck, then production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit tests |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm e2e` | Playwright against a production build |
| `pnpm e2e:install` | One-time Playwright browser install |

## Layout

```
src/
├── core/          pure logic — units, geometry, document model, tools, validation
├── state/         zustand store: document slice (undoable) + editor slice (not)
├── ui/            React shell, panels, dialogs
│   └── plan/      Konva stage and its layers
└── styles/        global CSS
e2e/               Playwright specs
PLAN.md            architecture + phasing
```

`src/core/` is deliberately free of React and of any renderer. The geometry engine is
pure functions over integer millimeters, consumed identically by the Konva plan view,
the three.js space view, and the validation passes — which is what keeps one geometry
primitive serving all three.

## Conventions

- **Integer millimeters** are the canonical unit everywhere in `src/core/`. Display
  units are a view preference and never used for computation.
- The document is Z-up (`x` east, `y` south, `z` up). three.js is Y-up. The conversion
  lives in exactly one place and is tested both directions.
- Rotation is never baked into stored vertices. Footprints stay in local coordinates;
  world geometry is derived per query.
- **Document state is undoable; editor state is not.** A drag lives entirely in the
  editor slice and writes to the document once, on release, so one drawn wall is one
  press of Ctrl+Z rather than several hundred.
- Coordinates round to integer millimetres at the commit boundary, never during a
  drag — rounding mid-gesture makes geometry jitter against the cursor.
