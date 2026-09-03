import { describe, expect, it } from 'vitest';
import {
  BlockedUrlError,
  MAX_RESPONSE_BYTES,
  USER_AGENT,
  isPrivateAddress,
  lookupProduct,
  parseTargetUrl,
  type LookupDeps,
} from './lookup';

/**
 * The guards on an endpoint that fetches a URL a stranger supplied.
 *
 * Nothing here touches a network — DNS included, which is the point: the resolver is
 * injected precisely so the guard that matters most is the one a test can drive. A
 * hostname resolving to `169.254.169.254` is not something you can arrange with a real
 * lookup, and it is the attack this endpoint exists inside of.
 */

const PAGE = '<html><head><title>Thing</title></head><body>Width: 84 in</body></html>';

function html(body = PAGE, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

/** Everything public, nothing fetched unless the test says so. */
function deps(over: Partial<LookupDeps> = {}): LookupDeps {
  return {
    resolve: () => Promise.resolve(['93.184.216.34']),
    fetch: () => Promise.resolve(html()),
    ...over,
  };
}

describe('which addresses are private', () => {
  it('knows the ranges that matter', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata endpoint, and the reason this list exists
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1', // an IPv4 loopback wearing an IPv6 hat
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('lets a public address through', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220::1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('sees through the other spellings of a mapped IPv4 loopback', () => {
    // `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address, the second written
    // in hex. A check that looks for a dotted quad only recognises the first, which is
    // exactly the spelling an attacker does not use.
    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
      '::ffff:a00:1', // 10.0.0.1
      '0:0:0:0:0:ffff:7f00:0001',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('does not refuse everything that merely looks v6', () => {
    // `::ffff:5db8:d822` is a mapped 93.184.216.34 — a public address, and blocking it
    // would refuse a real retailer. `fe00::1` is one bit outside fe80::/10, which is
    // the kind of edge a prefix-string check gets wrong in the permissive direction.
    for (const address of ['::ffff:5db8:d822', '2001:db8::1', 'fe00::1', 'not-an-address']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('the spellings of an address', () => {
  it('refuses a loopback written as a number', () => {
    // `https://2130706433/` is 127.0.0.1 in decimal, and `0x7f.0.0.1` in hex. The
    // WHATWG URL parser normalises both to a dotted quad before this code sees them —
    // load-bearing and not obvious, so it is asserted rather than assumed. Without it
    // the literal guard would have a hole that only the DNS step covers, and that step
    // is skipped on a runtime with no resolver.
    for (const url of [
      'https://2130706433/p',
      'https://0x7f.0.0.1/p',
      'https://017700000001/p',
      'https://127.1/p',
    ]) {
      expect(() => parseTargetUrl(url), url).toThrow(BlockedUrlError);
    }
  });

  it('refuses a mapped loopback in a URL', () => {
    expect(() => parseTargetUrl('https://[::ffff:7f00:1]/p')).toThrow(BlockedUrlError);
  });
});

describe('which URLs are even considered', () => {
  it('refuses anything that is not https', () => {
    expect(() => parseTargetUrl('http://shop.example.com/p')).toThrow(BlockedUrlError);
    expect(() => parseTargetUrl('file:///etc/passwd')).toThrow(BlockedUrlError);
    expect(() => parseTargetUrl('gopher://shop.example.com')).toThrow(BlockedUrlError);
  });

  it('refuses a URL carrying credentials', () => {
    // A way of smuggling something past a log or a naive host check.
    expect(() => parseTargetUrl('https://user:pass@shop.example.com/p')).toThrow(BlockedUrlError);
  });

  it('refuses names that mean "this machine"', () => {
    for (const url of [
      'https://localhost/p',
      'https://api.localhost/p',
      'https://printer.local/p',
      'https://vault.internal/p',
    ]) {
      expect(() => parseTargetUrl(url), url).toThrow(BlockedUrlError);
    }
  });

  it('refuses a literal private address', () => {
    expect(() => parseTargetUrl('https://169.254.169.254/latest/meta-data/')).toThrow(
      BlockedUrlError,
    );
  });

  it('refuses nothing at all', () => {
    expect(() => parseTargetUrl('')).toThrow(BlockedUrlError);
    expect(() => parseTargetUrl(undefined)).toThrow(BlockedUrlError);
    expect(() => parseTargetUrl('not a url')).toThrow(BlockedUrlError);
  });

  it('allows an ordinary product page', () => {
    expect(parseTargetUrl('https://shop.example.com/p/sofa').hostname).toBe('shop.example.com');
  });
});

describe('resolving before connecting', () => {
  it('refuses a public name that points at a private address', () => {
    // The guard the literal check cannot make. `evil.example.com` is free to publish
    // an A record of 169.254.169.254, and a URL check alone would wave it through.
    return expect(
      lookupProduct('https://evil.example.com/p', deps({ resolve: () => Promise.resolve(['169.254.169.254']) })),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('refuses when any one of several addresses is private', async () => {
    const result = await lookupProduct(
      'https://mixed.example.com/p',
      deps({ resolve: () => Promise.resolve(['93.184.216.34', '10.0.0.5']) }),
    );
    expect(result.ok).toBe(false);
  });

  it('carries on where there is no resolver at all', async () => {
    // An edge runtime with no `node:dns`. The literal checks still apply; refusing
    // every lookup would take the feature out on a runtime where it otherwise works.
    const result = await lookupProduct('https://shop.example.com/p', deps({ resolve: null }));
    expect(result.ok).toBe(true);
  });
});

describe('redirects', () => {
  it('revalidates every hop, not just the URL that was typed', async () => {
    // The standard way past a check that only looks at the first URL: answer the
    // request with a 302 to somewhere internal.
    let hop = 0;
    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({
        fetch: () => {
          hop++;
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }),
          );
        },
      }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(hop).toBe(1);
  });

  it('follows an ordinary redirect and reads the page it lands on', async () => {
    let hop = 0;
    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({
        fetch: (url) => {
          hop++;
          if (url === 'https://shop.example.com/p') {
            return Promise.resolve(
              new Response(null, {
                status: 301,
                headers: { location: 'https://shop.example.com/p/sofa' },
              }),
            );
          }
          return Promise.resolve(html());
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toBe('https://shop.example.com/p/sofa');
    expect(hop).toBe(2);
  });

  it('gives up on a redirect loop', async () => {
    const result = await lookupProduct(
      'https://shop.example.com/a',
      deps({
        fetch: (url) =>
          Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: url.endsWith('/a') ? '/b' : '/a' },
            }),
          ),
      }),
    );
    expect(result).toMatchObject({ ok: false, status: 502 });
  });

  it('does not follow a redirect on its own', async () => {
    // `redirect: 'manual'` is what makes the revalidation above possible at all — with
    // 'follow', fetch lands on the private address before this code ever sees it.
    let init: RequestInit | undefined;
    await lookupProduct(
      'https://shop.example.com/p',
      deps({
        fetch: (_url, i) => {
          init = i;
          return Promise.resolve(html());
        },
      }),
    );
    expect(init?.redirect).toBe('manual');
  });
});

describe('what comes back', () => {
  it('identifies itself', async () => {
    let init: RequestInit | undefined;
    await lookupProduct(
      'https://shop.example.com/p',
      deps({
        fetch: (_url, i) => {
          init = i;
          return Promise.resolve(html());
        },
      }),
    );
    expect((init?.headers as Record<string, string>)['user-agent']).toBe(USER_AGENT);
  });

  it('parses the page it fetched', async () => {
    const result = await lookupProduct('https://shop.example.com/p', deps());
    expect(result.ok && result.draft.name).toBe('Thing');
    expect(result.ok && result.draft.widthMm).toBe(2134);
  });

  it('refuses something that is not a web page', async () => {
    // A 40MB PDF, or a tarball. Parsing it as HTML is pointless and reading it is not.
    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({ fetch: () => Promise.resolve(new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })) }),
    );
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it('reports an error status as one, with the number in it', async () => {
    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({ fetch: () => Promise.resolve(html('nope', 404)) }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('404');
  });

  it('stops reading an enormous page instead of buffering all of it', async () => {
    // The cap has to be enforced while reading. Checking `content-length` afterwards
    // is advice a hostile server is free to ignore.
    const chunk = new TextEncoder().encode('x'.repeat(100_000));
    let sent = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        // Far past the cap. If nothing stops, this test does not finish.
        if (sent > MAX_RESPONSE_BYTES * 20) controller.close();
        else controller.enqueue(chunk);
      },
    });

    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({
        fetch: () =>
          Promise.resolve(new Response(body, { headers: { 'content-type': 'text/html' } })),
      }),
    );

    expect(result.ok).toBe(true);
    expect(sent).toBeLessThan(MAX_RESPONSE_BYTES * 2);
  });

  it('says a page took too long rather than hanging', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({ fetch: () => Promise.reject(abort) }),
    );
    expect(result).toMatchObject({ ok: false, status: 504 });
  });

  it('says it could not reach a page rather than throwing', async () => {
    const result = await lookupProduct(
      'https://shop.example.com/p',
      deps({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) }),
    );
    expect(result).toMatchObject({ ok: false, status: 502 });
  });
});
