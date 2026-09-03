import { afterEach, describe, expect, it } from 'vitest';
import { NO_ENDPOINT_MESSAGE, lookUpProduct } from './product-lookup';

/**
 * The client's one real job: telling "the endpoint said no" apart from "there is no
 * endpoint". Those lead to different sentences, and only one of them is the user's
 * problem to fix.
 */

const realFetch = globalThis.fetch;

function respond(body: string, init: ResponseInit = {}): void {
  globalThis.fetch = () => Promise.resolve(new Response(body, init));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

describe('when the endpoint is there', () => {
  it('returns the draft', async () => {
    respond(JSON.stringify({ url: 'https://shop.example.com/p', draft: { name: 'Sofa', widthMm: 2134 } }), {
      headers: JSON_HEADERS,
    });

    const outcome = await lookUpProduct('https://shop.example.com/p');
    expect(outcome).toMatchObject({ kind: 'ok', draft: { name: 'Sofa', widthMm: 2134 } });
  });

  it('passes a refusal through as something to show', async () => {
    respond(JSON.stringify({ message: 'Only https product pages can be looked up.' }), {
      status: 400,
      headers: JSON_HEADERS,
    });

    const outcome = await lookUpProduct('http://shop.example.com/p');
    expect(outcome).toEqual({ kind: 'error', message: 'Only https product pages can be looked up.' });
  });
});

describe('when the endpoint is not there', () => {
  it('does not mistake an SPA fallback for a successful lookup', async () => {
    // The trap. A static host answering an unknown POST with `index.html` and a 200
    // makes `response.ok` true; the JSON parse then throws somewhere deep in a catch
    // written for network failures. The content type is the only honest signal.
    respond('<!doctype html><html><body>the app</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

    expect(await lookUpProduct('https://shop.example.com/p')).toEqual({ kind: 'unavailable' });
  });

  it('treats a 404 as absent, not as an error to explain', async () => {
    respond('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    expect(await lookUpProduct('https://shop.example.com/p')).toEqual({ kind: 'unavailable' });
  });

  it('treats a network failure as absent', async () => {
    globalThis.fetch = () => Promise.reject(new Error('Failed to fetch'));
    expect(await lookUpProduct('https://shop.example.com/p')).toEqual({ kind: 'unavailable' });
  });

  it('treats JSON that is not ours as absent', async () => {
    // A proxy, or a different service on the same path. An error with no message is
    // not a refusal this application can explain.
    respond(JSON.stringify({ error: 'nope' }), { status: 502, headers: JSON_HEADERS });
    expect(await lookUpProduct('https://shop.example.com/p')).toEqual({ kind: 'unavailable' });
  });

  it('treats a 200 with no draft as absent', async () => {
    respond(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    expect(await lookUpProduct('https://shop.example.com/p')).toEqual({ kind: 'unavailable' });
  });

  it('has a sentence that says what to do instead', () => {
    // §7.2: URL import degrades to a message pointing at manual entry. "Lookup failed"
    // tells someone nothing they can act on.
    expect(NO_ENDPOINT_MESSAGE).toContain('by hand');
  });
});

describe('the request', () => {
  it('posts the URL as JSON', async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (_input, init) => {
      seen = init;
      return Promise.resolve(new Response('{}', { status: 200, headers: JSON_HEADERS }));
    };

    await lookUpProduct('https://shop.example.com/p');
    expect(seen?.method).toBe('POST');
    expect(JSON.parse(String(seen?.body))).toEqual({ url: 'https://shop.example.com/p' });
  });
});
