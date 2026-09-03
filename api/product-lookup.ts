/**
 * The production deployment of the product-lookup endpoint. See PLAN.md §7.2.
 *
 * A Web-standard `Request` → `Response` handler, which is what Vercel, Netlify,
 * Cloudflare Workers and Deno Deploy all accept in their current runtimes. All the
 * behaviour is in `src/server/endpoint.ts`, shared with the Vite dev middleware, so
 * the endpoint you develop against and the one you deploy cannot answer differently.
 *
 * Nothing in the application requires this file to be deployed. With it absent the
 * client sees a non-JSON answer or a network error and URL import degrades to a
 * message pointing at manual entry — which is the stated contract, not a fallback that
 * happens to work.
 */

import { handleProductLookup } from '../src/server/endpoint';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default async function handler(request: Request): Promise<Response> {
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
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: JSON_HEADERS,
  });
}
