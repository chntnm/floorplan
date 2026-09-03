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
 *
 * The residual hole is stated rather than papered over: between the DNS check and the
 * connection there is a window in which a record can change (DNS rebinding). Closing it
 * needs the socket to be pinned to the address that was checked, which `fetch` does not
 * expose. For a self-hosted planning tool with no internal network worth reaching, the
 * trade is deliberate.
 */

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

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(h)) return true; // unique-local
  // `::ffff:127.0.0.1` — an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return mapped ? isPrivateIPv4(mapped[1]!) : false;
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

/** Resolve a hostname and refuse it if it points anywhere private. */
async function assertPublicHost(hostname: string, resolve: Resolver | null): Promise<void> {
  if (isPrivateAddress(hostname)) {
    throw new BlockedUrlError('That address is not a public web address.');
  }
  if (!resolve) return;

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    // A runtime with no `node:dns` at all: skip the step rather than refusing every
    // lookup. A hostname that genuinely will not resolve fails at the fetch instead.
    if (err instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(err.message)) {
      return;
    }
    throw new BlockedUrlError(`Could not resolve ${hostname}.`);
  }

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError('That address resolves to a private network.');
    }
  }
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

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LookupDeps = {
  fetch?: FetchLike;
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
  const fetchImpl = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
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
      await assertPublicHost(url.hostname, resolve);

      response = await fetchImpl(url.toString(), {
        // Manual, so every hop is revalidated. `redirect: 'follow'` would let a
        // retailer's shortlink land on a private address without this code seeing it.
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      });

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
