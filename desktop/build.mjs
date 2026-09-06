/**
 * The main process, bundled.
 *
 * esbuild rather than tsc for one reason: `desktop/main.ts` imports the product-lookup
 * endpoint out of `src/server`, which imports `node-html-parser`. Bundling turns the
 * shell into a single file with no runtime dependency on `node_modules`, which is what
 * lets the packaged app ship `dist/` and `dist-electron/` and nothing else — no
 * pnpm symlink farm to flatten, no production/development dependency split to get
 * wrong. Types are checked by `pnpm typecheck` over the same files.
 */

import { build } from 'esbuild';

await build({
  entryPoints: ['desktop/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  // Electron 44 carries Node 22. Node built-ins are external automatically.
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
});
