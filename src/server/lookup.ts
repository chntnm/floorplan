/**
 * The server half of product URL import. See PLAN.md §7.2.
 *
 * A browser cannot fetch a retailer's page — CORS — so this runs server-side: Vite dev
 * middleware in development, one serverless function in production. **The app stays
 * fully functional as a static build with this absent**; URL import degrades to a
 * message pointing at manual entry. It is a convenience layer, not a dependency.
 *
 * ## This endpoint fetches a URL the user supplied, which is SSRF by construction
 *
 * That is not a hypothetical: the whole feature is "give us a URL and we will make a
 * request to it from our network". Every guard below exists because the request comes
 * from inside somewhere the caller cannot otherwise reach.
 *
 *   - **https only.** `file:`, `gopher:` and friends are not retailer pages.
 *   - **No credentials in the URL** — `https://user:pass@host` is a way of smuggling
 *     something past a log or a naive host check.
 *   - **Public addresses only.** Loopback, link-local, every RFC 1918 range, carrier
 *     NAT, unique-local IPv6 and `.localhost`/`.local`/`.internal` names are refused —
 *     and the hostname is *resolved* first where DNS is available, because
 *     `evil.example.com` is free to have an A record of `169.254.169.254`.
 *   - **Redirects are followed by hand**, at most three, revalidating every hop. A
 *     redirect to a private address is the standard way past a check that only looks
 *     at the URL the user typed.
 *   - **A response size cap and a hard timeout**, so a hostile or merely enormous page
 *     cannot hold a function open or exhaust its memory.
 *   - **The socket is pinned to the address that was checked.** A guard that resolves a
 *     name and a transport that resolves it again leave a window between them in which
 *     the record can change, which is the whole of DNS rebinding: the check sees a
 *     public address and the connection lands on a private one. `fetch` exposes no way
 *     to pin a socket, so where `node:https` is present the request goes through it
 *     with a `lookup` that returns the addresses already validated.
 */

import type * as NodeHttps from 'node:https';
import type * as NodeStream from 'node:stream';

import { parseProduct, type ProductDraft } from '../core/product';

export const MAX_RESPONSE_BYTES = 2_000_000;
export const REQUEST_TIMEOUT_MS = 8_000;
export const MAX_REDIRECTS = 3;

/** Identified, per §7.2. A scraper that lies about who it is deserves what it gets. */
export const USER_AGENT =
  'floorplan/0.1 (+https://github.com/chntnm/floorplan) product-dimension-lookup';

export type LookupResult =
  | { ok: true; url: string; draft: ProductDraft }
  | { ok: false; status: number; message: string };

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 169 && b === 254) return true; // link-local, and 169.254.169.254 in particular
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * An IPv6 literal as its eight 16-bit groups, or null if it is not one.
 *
 * Expanded rather than matched by prefix, because the same address has many
 * spellings and a string test only recognises the ones you thought of.
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the *same address* — the second written
 * in hex — and a regex looking for dotted quads sees only the first.
 */
function parseIPv6(raw: string): number[] | null {
  let h = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h.includes(':')) return null;

  // A trailing dotted quad (`::ffff:127.0.0.1`) becomes two hex groups, so
  // everything below works on one representation.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (tail) {
    const octets = tail[2]!.split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    h = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : null;
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (!rest) return null;

  const gap = 8 - head.length - rest.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...rest];
}

function isPrivateIPv6(host: string): boolean {
  const g = parseIPv6(host);
  if (!g) return false;

  // `::` (unspecified) and `::1` (loopback).
  if (g.slice(0, 7).every((n) => n === 0) && (g[7] === 0 || g[7] === 1)) return true;
  // Link-local fe80::/10 and unique-local fc00::/7.
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  if ((g[0]! & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped ::ffff:0:0/96 — an IPv4 address wearing an IPv6 hat, and the way a
  // loopback gets past a check that only knows what a dotted quad looks like.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const hi = g[6]!;
    const lo = g[7]!;
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  return false;
}

export function isPrivateAddress(host: string): boolean {
  return isPrivateIPv4(host) || isPrivateIPv6(host);
}

/** Hostname to addresses. Injected so the guard can be tested without a network. */
export type Resolver = (hostname: string) => Promise<string[]>;

/**
 * The default resolver, or null on a runtime with no `node:dns`.
 *
 * Best effort by design: on a bundled or edge runtime the literal-address checks still
 * apply and the DNS step is skipped. Refusing every lookup because `node:dns` is
 * missing would take the feature out entirely on a runtime where it otherwise works.
 */
export async function systemResolver(hostname: string): Promise<string[]> {
  const dns = await import('node:dns/promises');
  const found = await dns.lookup(hostname, { all: true });
  return found.map((entry) => entry.address);
}

/**
 * Resolve a hostname, refuse it if it points anywhere private, and hand back the
 * addresses the connection is allowed to use.
 *
 * Returning them rather than returning nothing is what turns a check into a guarantee:
 * the caller connects to one of *these*, not to whatever the name resolves to a moment
 * later. `null` means there is nothing to pin — a runtime with no resolver, where the
 * literal checks are all there is.
 */
async function resolvePublicHost(
  hostname: string,
  resolve: Resolver | null,
): Promise<string[] | null> {
  if (isPrivateAddress(hostname)) {
    throw new BlockedUrlError('That address is not a public web address.');
  }
  if (!resolve) return null;

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    // A runtime with no `node:dns` at all: skip the step rather than refusing every
    // lookup. A hostname that genuinely will not resolve fails at the fetch instead.
    if (err instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(err.message)) {
      return null;
    }
    throw new BlockedUrlError(`Could not resolve ${hostname}.`);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError('That address resolves to a private network.');
    }
  }
  return addresses.length > 0 ? addresses : null;
}

/** Which `dns.lookup` family a literal address belongs to. */
function addressFamily(address: string): number {
  return address.includes(':') ? 6 : 4;
}

/**
 * `fetch`, with the socket pinned to addresses that have already been checked.
 *
 * The one gap the guards above cannot close on their own. `resolvePublicHost` looks the
 * name up and `fetch` looks it up again when it connects, and a record that changes
 * between the two is DNS rebinding — the check passes on a public address, the
 * connection lands on `169.254.169.254`. There is no `fetch` option for this, so the
 * request is made through `node:https` with a `lookup` that returns what was validated
 * instead of asking the resolver a second time.
 *
 * TLS is untouched: the hostname still drives SNI and certificate validation, so this
 * pins *where* the connection goes without changing *who* it has to prove it is. All of
 * the resolved addresses are offered rather than only the first, so a host with one
 * dead address still fails over the way it would have.
 *
 * Two cases fall back to `fetch`, and neither is a hole: a runtime with no `node:https`
 * is the same runtime that had no `node:dns`, and a call with no addresses is that same
 * runtime arriving here. Where there is nothing to pin there was never a resolution to
 * disagree with.
 */
async function pinnedFetch(
  target: string,
  init: RequestInit,
  pinned: string[] | null,
): Promise<Response> {
  if (!pinned || pinned.length === 0) return globalThis.fetch(target, init);

  let request: typeof NodeHttps.request;
  let Readable: typeof NodeStream.Readable;
  try {
    ({ request } = await import('node:https'));
    ({ Readable } = await import('node:stream'));
  } catch {
    return globalThis.fetch(target, init);
  }

  const url = new URL(target);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  // Written last so a caller cannot ask for something this transport cannot read.
  // `https.request` does not decompress and `fetch` does; a compressed body here would
  // reach `parseProduct` as gzip, with no error to explain why the page had no title.
  headers['accept-encoding'] = 'identity';

  return await new Promise<Response>((settle, fail) => {
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        ...(init.signal ? { signal: init.signal } : {}),
        lookup: (_hostname, options, done) => {
          if (options.all) {
            done(
              null,
              pinned.map((address) => ({ address, family: addressFamily(address) })),
            );
          } else {
            done(null, pinned[0]!, addressFamily(pinned[0]!));
          }
        },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const received = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const one of value) received.append(name, one);
          else if (value !== undefined) received.set(name, value);
        }
        // 204 and 304 are defined to carry no body, and `Response` refuses to be given
        // one — a redirect chain through either would throw here rather than be read.
        const empty = status === 204 || status === 304;
        const body = empty
          ? null
          : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
        settle(new Response(body, { status, headers: received }));
      },
    );
    outgoing.on('error', fail);
    outgoing.end();
  });
}

/** Validate the shape of a URL. Throws `BlockedUrlError` with a message to show. */
export function parseTargetUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BlockedUrlError('Give a product page URL.');
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedUrlError('That is not a URL I can read.');
  }

  if (url.protocol !== 'https:') {
    throw new BlockedUrlError('Only https product pages can be looked up.');
  }
  if (url.username || url.password) {
    throw new BlockedUrlError('A URL carrying credentials will not be fetched.');
  }

  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) ||
    // A literal address is refused here as well as in `assertPublicHost`. Both are
    // reached on every hop, so this is redundant by design: the URL gate should be
    // able to say no to `https://169.254.169.254/latest/meta-data/` on its own, rather
    // than depending on a resolver step that a runtime without `node:dns` skips.
    isPrivateAddress(host)
  ) {
    throw new BlockedUrlError('That address is not a public web address.');
  }

  return url;
}

/**
 * What actually makes the request: `fetch`, widened by the addresses the socket is to
 * be pinned to.
 *
 * The third argument is here so a test can see it. Pinning is the guard with no
 * observable output — a correct implementation and one that quietly calls plain
 * `fetch` return the same page — so the addresses are passed rather than captured, and
 * a stub can assert that the ones the resolver validated are the ones the connection
 * was handed. A two-argument stub is still assignable and simply ignores them.
 */
export type Transport = (
  url: string,
  init: RequestInit,
  pinned: string[] | null,
) => Promise<Response>;

export type LookupDeps = {
  fetch?: Transport;
  /** Pass `null` to skip the DNS check — for a runtime that has no resolver. */
  resolve?: Resolver | null;
};

/** Read at most `MAX_RESPONSE_BYTES`, then stop — a cap that is not merely advisory. */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return (await response.text()).slice(0, MAX_RESPONSE_BYTES);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (size >= MAX_RESPONSE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

/**
 * Fetch a product page and read what it says.
 *
 * Both dependencies are injected so the guards can be tested without touching a
 * network — including DNS, which is the guard that matters most and the one a test
 * cannot otherwise reach. They are read here rather than captured at module load, for
 * the same reason the save picker is.
 */
export async function lookupProduct(
  rawUrl: unknown,
  deps: LookupDeps = {},
): Promise<LookupResult> {
  const transport: Transport = deps.fetch ?? pinnedFetch;
  const resolve = deps.resolve === undefined ? systemResolver : deps.resolve;
  let url: URL;
  try {
    url = parseTargetUrl(rawUrl);
  } catch (err) {
    return { ok: false, status: 400, message: message(err) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Checked *and* pinned: the addresses this returns are the only ones the
      // connection below can reach, so the name cannot be re-pointed in between.
      const pinned = await resolvePublicHost(url.hostname, resolve);

      response = await transport(
        url.toString(),
        {
          // Manual, so every hop is revalidated. `redirect: 'follow'` would let a
          // retailer's shortlink land on a private address without this code seeing it.
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        },
        pinned,
      );

      if (response.status < 300 || response.status >= 400) break;

      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url);

      try {
        url = parseTargetUrl(url.toString());
      } catch (err) {
        return { ok: false, status: 400, message: message(err) };
      }

      if (hop === MAX_REDIRECTS) {
        return { ok: false, status: 502, message: 'That page redirected too many times.' };
      }
      response = undefined;
    }

    if (!response) {
      return { ok: false, status: 502, message: 'That page redirected too many times.' };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        message: `That page returned ${response.status}. Check the URL, or enter the item by hand.`,
      };
    }

    const type = response.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { ok: false, status: 415, message: 'That URL is not a web page.' };
    }

    const html = await readCapped(response);
    return { ok: true, url: url.toString(), draft: parseProduct(html, url.toString()) };
  } catch (err) {
    if (err instanceof BlockedUrlError) return { ok: false, status: 400, message: err.message };
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, status: 504, message: 'That page took too long to answer.' };
    }
    return { ok: false, status: 502, message: 'Could not reach that page.' };
  } finally {
    clearTimeout(timer);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'That URL cannot be looked up.';
}
