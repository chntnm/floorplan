/**
 * The endpoint, independent of what is hosting it.
 *
 * Vite dev middleware in development and one serverless function in production call
 * the same function with the same parsed body, so the two deployments cannot drift
 * into answering differently — which would be invisible until production, since the
 * dev server is the only one anybody runs while building the feature.
 */

import { lookupProduct } from './lookup';

export { PRODUCT_LOOKUP_PATH } from '../core/api';

export type EndpointResponse = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * `POST { url }` → a product draft, or a message saying why not.
 *
 * Every failure is a JSON body with a `message` the UI can show verbatim. An endpoint
 * that answers a bad URL with an HTML error page would reach the client as "the
 * endpoint is absent", which is a different thing and would send the user to manual
 * entry without telling them their URL was the problem.
 */
export async function handleProductLookup(body: unknown): Promise<EndpointResponse> {
  const url = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['url'] : undefined;

  const result = await lookupProduct(url);
  if (!result.ok) return { status: result.status, body: { message: result.message } };

  return { status: 200, body: { url: result.url, draft: result.draft } };
}
