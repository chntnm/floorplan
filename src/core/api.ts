/**
 * The one path the client and the server both have to agree on.
 *
 * Its own module, with no imports, on purpose. The obvious home is
 * `server/endpoint.ts`, and importing a constant from there would drag
 * `node-html-parser`, the whole parser and a `node:dns` import into the browser
 * bundle — for a string. A value shared across the wire belongs to neither side.
 */
export const PRODUCT_LOOKUP_PATH = '/api/product-lookup';
