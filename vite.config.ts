/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { PRODUCT_LOOKUP_PATH, handleProductLookup } from './src/server/endpoint';

/**
 * The product-lookup endpoint in development. See PLAN.md §7.2.
 *
 * `configureServer` only — deliberately **not** `configurePreviewServer`. Preview
 * serves the production build, where this endpoint is a serverless function that is
 * not part of the bundle, so leaving it out is what makes preview an honest rehearsal
 * of a static deployment. It is also what lets the end-to-end suite assert the stated
 * degradation — "the app remains fully functional with the endpoint absent" — against
 * a real absence rather than a stub of one.
 */
function productLookup(): Plugin {
  return {
    name: 'floorplan:product-lookup',
    configureServer(server) {
      server.middlewares.use(PRODUCT_LOOKUP_PATH, (req, res) => {
        void (async () => {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ message: 'POST a { url } to look up a product.' }));
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);

          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ message: 'That request body is not JSON.' }));
            return;
          }

          const result = await handleProductLookup(body);
          res.statusCode = result.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result.body));
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), productLookup()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5190,
    // Build output is not source. Watching it is useless — nothing here imports it —
    // and on Windows it is actively harmful: the watcher holds a handle on every
    // directory under the project root, and electron-builder packages by extracting
    // Electron into `release/win-unpacked.tmp` and *renaming* it, which fails with
    // EPERM against an open handle. Without this, `pnpm desktop` and `pnpm
    // desktop:dist` cannot both run in one session.
    watch: {
      ignored: ['**/release/**', '**/dist-electron/**'],
    },
  },

  test: {
    // The geometry core is pure functions over numbers — no DOM needed, and a node
    // environment keeps the highest-value test suite in the project fast.
    // Component tests that need a DOM should opt in per-file with:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
