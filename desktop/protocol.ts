/**
 * What the desktop window loads, and why it is not `file://`.
 *
 * The app is the same static build the web deployment serves, but a `file://` page has
 * an opaque origin, and three things this app is built on need a real one:
 *
 *   - **`showSaveFilePicker`** — the File System Access API is secure-context only.
 *     Without it `supportsSaveInPlace()` in `src/state/save-target.ts` answers false and
 *     Ctrl+S silently becomes an anchor click into the downloads folder. In a desktop
 *     app that is not a graceful fallback, it is a bug.
 *   - **IndexedDB** — Chromium disables it on opaque origins, and it is where the
 *     autosave that backs crash recovery lives (`src/state/autosave-db.ts`).
 *   - **`fetch('/api/product-lookup')`** — a relative request needs an origin to be
 *     relative to.
 *
 * So the window loads `app://floorplan/`, a scheme registered `standard` (it has a host
 * and resolves relative URLs the ordinary way, which is what lets the Vite build's
 * absolute `/assets/…` paths work untouched) and `secure` (a trustworthy origin, which
 * is what restores the three capabilities above).
 *
 * The handler serves two things: files out of the built `dist/`, and the one endpoint.
 */

import { net } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PRODUCT_LOOKUP_PATH, handleProductLookup } from '../src/server/endpoint';

export const APP_SCHEME = 'app';
export const APP_HOST = 'floorplan';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX = `${APP_ORIGIN}/`;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/**
 * The page may load code, styles, images and workers from itself and nowhere else.
 *
 * `'unsafe-inline'` for styles because React writes style attributes and Konva sizes
 * its canvases the same way; there is no inline *script* anywhere in the build, so
 * script-src stays strict. `'wasm-unsafe-eval'` is for pdfjs, which decodes some image
 * formats in WebAssembly — without it, opening a plan PDF that happens to contain a
 * JPEG 2000 image fails at the decoder rather than at import.
 *
 * `connect-src` is `'self'` — the product lookup and nothing else. The lookup itself
 * reaches the network from the main process, where it is guarded (see below); the
 * renderer never talks to a retailer directly and this says so.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Resolve a request path inside `root`, or null if it escapes.
 *
 * `..` in a URL path is normally collapsed by the URL parser, but the handler is given
 * whatever the renderer asks for and a percent-encoded traversal survives parsing. The
 * check is on the resolved string, after normalisation, which is the only form worth
 * testing: everything else compares spellings rather than destinations.
 */
export function resolveWithin(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const resolved = normalize(join(root, decoded));
  const base = normalize(root);
  if (resolved !== base && !resolved.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return resolved;
}

/**
 * The endpoint, in the main process.
 *
 * In the browser deployment this is a serverless function and the desktop build would
 * otherwise have no equivalent — URL import would degrade to manual entry, which is a
 * documented and honest outcome but a worse one when there is a Node process sitting
 * right there. It is the *same* `handleProductLookup` the Vite middleware and the
 * serverless function call, so all three answer identically, and every SSRF guard in
 * `src/server/lookup.ts` — public addresses only, resolved and pinned, redirects
 * revalidated, size capped, timeout — applies here unchanged. Those guards are what
 * make running it on the user's own machine sound: a hostile URL still cannot reach
 * their loopback or their LAN.
 */
async function productLookup(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ message: 'POST a { url } to look up a product.' }), {
      status: 405,
      headers: JSON_HEADERS,
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ message: 'That request body is not JSON.' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const result = await handleProductLookup(body);
  return new Response(JSON.stringify(result.body), { status: result.status, headers: JSON_HEADERS });
}

/**
 * `app://floorplan/*` → the built app.
 *
 * Static files go through `net.fetch` of a `file://` URL rather than `readFile`, which
 * is what makes this work inside the packaged `app.asar` and what supplies the content
 * types — a `.mjs` served as `text/plain` would take down the pdfjs worker, and the
 * failure would look like "PDF import is broken" rather than "the MIME type is wrong".
 */
export function createAppHandler(root: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);

    if (url.pathname === PRODUCT_LOOKUP_PATH) return productLookup(request);

    const target = resolveWithin(root, url.pathname === '/' ? '/index.html' : url.pathname);
    if (!target) return new Response('Not found', { status: 404 });

    const response = await net.fetch(pathToFileURL(target).toString());
    if (!response.ok) return response;

    // The document carries the policy. Setting it here rather than as a <meta> in
    // index.html keeps the web build — which is served by hosts with their own header
    // policy — out of it.
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', CSP);
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  };
}
