import { describe, expect, it } from 'vitest';
import { PRODUCT_LOOKUP_PATH, handleProductLookup } from './endpoint';

/**
 * The shape both deployments answer with.
 *
 * `lookup.ts` is thoroughly covered and this wrapper is four lines, which is exactly
 * the kind of code that ships unexecuted: every other test in this feature exercises
 * either the pure parser or the guards, and the end-to-end suite runs against
 * `vite preview`, which has no endpoint by design. Nothing else runs this function.
 */
describe('the endpoint contract', () => {
  it('answers a bad URL with a status and a message, not an exception', async () => {
    // The message reaches the UI verbatim. An endpoint that threw here would be
    // rendered by the host as an HTML error page, which the client reads as "no
    // endpoint" — sending the user to manual entry without telling them their URL was
    // the problem.
    const result = await handleProductLookup({ url: 'http://shop.example.com/p' });

    expect(result.status).toBe(400);
    expect(String(result.body['message'])).toContain('https');
  });

  it('answers a missing body the same way', async () => {
    for (const body of [undefined, null, {}, 'not an object', { url: 42 }]) {
      const result = await handleProductLookup(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(typeof result.body['message']).toBe('string');
    }
  });

  it('refuses a private address rather than fetching it', async () => {
    const result = await handleProductLookup({ url: 'https://169.254.169.254/latest/meta-data/' });
    expect(result.status).toBe(400);
  });

  it('agrees with the client about where it lives', () => {
    // The path is the one thing the two halves have to share, and it is why it lives
    // in `core/api.ts` rather than here — importing it from this module would drag the
    // HTML parser into the browser bundle for a string.
    expect(PRODUCT_LOOKUP_PATH).toBe('/api/product-lookup');
  });
});
