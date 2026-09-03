/**
 * Asking the server about a product URL. See PLAN.md §7.2.
 *
 * ## `response.ok` is not how you find out whether the endpoint exists
 *
 * A static build has no `/api/product-lookup`. Depending on the host, a POST to it
 * comes back as a 404, a 405, or — on any host with an SPA fallback, which is most of
 * them, `vite preview` included — a **200 carrying `index.html`**. That last one is the
 * dangerous case: `response.ok` is true, and `response.json()` throws somewhere deep
 * in a `catch` that was written for network failures.
 *
 * So the test is the **content type**. Anything that is not JSON means the endpoint is
 * absent, whatever the status line says, and the UI points at manual entry — which is
 * §7.2's stated degradation rather than an error nobody can act on.
 *
 * `fetch` is read from `globalThis` at call time, never captured at module load, for
 * the same reason the save picker is: a snapshot cannot be replaced from a test.
 */

import { PRODUCT_LOOKUP_PATH } from '../core/api';
import type { ProductDraft } from '../core/product';

export type LookupOutcome =
  | { kind: 'ok'; url: string; draft: ProductDraft }
  /** No endpoint deployed. The app is a static build and this is expected. */
  | { kind: 'unavailable' }
  /** The endpoint answered, and the answer was no. `message` is safe to show. */
  | { kind: 'error'; message: string };

export const NO_ENDPOINT_MESSAGE =
  'Looking up a URL needs the lookup service, which this build does not have. ' +
  'Enter the item by hand — name, then width, depth and height.';

function isJson(response: Response): boolean {
  return /application\/json/i.test(response.headers.get('content-type') ?? '');
}

export async function lookUpProduct(url: string): Promise<LookupOutcome> {
  let response: Response;
  try {
    response = await globalThis.fetch(PRODUCT_LOOKUP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    // No network, or no server at all. Indistinguishable from here, and the same
    // advice either way.
    return { kind: 'unavailable' };
  }

  if (!isJson(response)) return { kind: 'unavailable' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unavailable' };
  }

  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  if (!response.ok) {
    const message = typeof payload['message'] === 'string' ? payload['message'] : null;
    // A JSON body with no message is an endpoint we do not recognise — a proxy, or a
    // different service on the same path — not a refusal we can explain.
    return message ? { kind: 'error', message } : { kind: 'unavailable' };
  }

  const draft = payload['draft'];
  if (typeof draft !== 'object' || draft === null) return { kind: 'unavailable' };

  return {
    kind: 'ok',
    url: typeof payload['url'] === 'string' ? payload['url'] : url,
    draft: draft as ProductDraft,
  };
}
