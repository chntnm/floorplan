# roomplan

Spatial planning for real rooms. Import a floor plan, build an inventory of what you
own, place it, and walk through the result in 3D.

The document is fully three-dimensional. Every object carries a real height and a base
elevation, so a rug under a table is not a collision, a wall shelf at 1400mm does not
block a desk at 750mm, and a 2100mm bookcase under a 2050mm soffit is a violation the
app catches.

> **Status: phase 0.** Scaffold and app shell only. See [PLAN.md](./PLAN.md) for the
> full architecture and phasing.

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
├── core/          pure logic — units, geometry, document model, validation
├── ui/            React shell, panels, dialogs
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
