/**
 * Reading a product out of a retailer's page. See PLAN.md §7.2.
 *
 * Four tiers, tried in order of how much the page is actually telling us:
 *
 *   1. `application/ld+json` — schema.org/Product. Structured, intended for machines,
 *      and published cleanly by most furniture retailers.
 *   2. microdata `itemprop` attributes — the same vocabulary, inline.
 *   3. OpenGraph — name and image only. It is a social-sharing card, not a spec sheet.
 *   4. regex over the page text — the fallback, and the least trustworthy.
 *
 * Name, image and price are taken from the first tier that has them. **Dimensions are
 * tracked separately**, because they are the only part that becomes geometry: a page
 * can publish a clean JSON-LD name and leave the measurements to a paragraph, and
 * reporting `json-ld` for the whole reading would overstate where the numbers came
 * from. `dimensionSource` says which tier the numbers are from, and `confidence` says
 * whether they were labelled or merely in the usual order.
 *
 * ## Nothing here decides anything
 *
 * Every result lands in a confirm-before-add dialog with every field editable, the
 * source URL shown, and the text the numbers came from displayed alongside (§7.2). So
 * this module is allowed to guess, provided it says that it guessed. What it is not
 * allowed to do is produce a number with no unit behind it — see `dimensions.ts`.
 *
 * Pure: HTML in, a draft out. No network. `server/lookup.ts` does the fetching.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import { parseExplicitLength, readDimensions, type DimensionConfidence } from './dimensions';

export type ProductTier = 'json-ld' | 'microdata' | 'opengraph' | 'text';

export type ProductDraft = {
  name?: string;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  imageUrl?: string;
  price?: string;
  /** Which tier the dimensions came from, or undefined when none were found. */
  dimensionSource?: ProductTier;
  confidence?: DimensionConfidence;
  /** The text the numbers were read from — keeps a scraped dimension auditable. */
  rawSnippet?: string;
};

type Dimensions = {
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  confidence: DimensionConfidence;
  rawSnippet?: string;
};

// ---------------------------------------------------------------------------
// Units as schema.org spells them
// ---------------------------------------------------------------------------

/** UN/CEFACT codes, which is what `unitCode` carries when a page bothers with it. */
const UNIT_CODES: Record<string, string> = {
  INH: 'in',
  FOT: 'ft',
  CMT: 'cm',
  MMT: 'mm',
  MTR: 'm',
};

/**
 * A schema.org `QuantitativeValue`, or a plain string, into millimetres.
 *
 * `{ value: 84, unitCode: 'INH' }` and `"84 inches"` are both common, and so is
 * `{ value: 84 }` with no unit at all — which is refused, like every other unitless
 * number. A structured field is not more trustworthy than a paragraph when the one
 * thing that makes a number a length is missing from both.
 */
function quantityToMm(raw: unknown): number | null {
  if (typeof raw === 'string') return parseExplicitLength(raw);
  if (typeof raw !== 'object' || raw === null) return null;

  const q = raw as Record<string, unknown>;
  const value = q['value'];
  if (typeof value !== 'number' && typeof value !== 'string') return null;

  const code = typeof q['unitCode'] === 'string' ? UNIT_CODES[q['unitCode']] : undefined;
  const text = typeof q['unitText'] === 'string' ? q['unitText'] : undefined;
  const unit = code ?? text;
  if (!unit) return null;

  return parseExplicitLength(`${value} ${unit}`);
}

// ---------------------------------------------------------------------------
// Tier 1 — JSON-LD
// ---------------------------------------------------------------------------

function isProduct(node: unknown): node is Record<string, unknown> {
  if (typeof node !== 'object' || node === null) return false;
  const type = (node as Record<string, unknown>)['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && t.toLowerCase() === 'product');
}

/** Every Product node anywhere in a JSON-LD blob, `@graph` and arrays included. */
function findProducts(node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const child of node) findProducts(child, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;

  if (isProduct(node)) found.push(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null) findProducts(value, found);
  }
  return found;
}

function firstString(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = firstString(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof raw === 'object' && raw !== null) {
    const url = (raw as Record<string, unknown>)['url'];
    return typeof url === 'string' ? url : undefined;
  }
  return undefined;
}

const AXIS_BY_PROPERTY: Record<string, 'widthMm' | 'depthMm' | 'heightMm'> = {
  width: 'widthMm',
  depth: 'depthMm',
  length: 'depthMm',
  height: 'heightMm',
};

function jsonLdDimensions(product: Record<string, unknown>): Dimensions | null {
  const found: Dimensions = { confidence: 'labelled' };
  const parts: string[] = [];

  for (const [property, axis] of Object.entries(AXIS_BY_PROPERTY)) {
    const mm = quantityToMm(product[property]);
    if (mm !== null && found[axis] === undefined) {
      found[axis] = mm;
      parts.push(`${property}: ${JSON.stringify(product[property])}`);
    }
  }

  // `additionalProperty: [{ name: 'Width', value: '84 inches' }]` — where most
  // retailers actually put the numbers, because schema.org's own width/depth/height
  // are singular and a sofa has three.
  const extras = product['additionalProperty'];
  for (const extra of Array.isArray(extras) ? extras : [extras]) {
    if (typeof extra !== 'object' || extra === null) continue;
    const row = extra as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'].trim().toLowerCase() : '';
    const axis = AXIS_BY_PROPERTY[name];
    if (!axis || found[axis] !== undefined) continue;

    const mm =
      quantityToMm(row['value']) ??
      (typeof row['value'] === 'string' ? parseExplicitLength(row['value']) : null);
    if (mm !== null) {
      found[axis] = mm;
      parts.push(`${row['name']}: ${String(row['value'])}`);
    }
  }

  if (found.widthMm === undefined && found.depthMm === undefined && found.heightMm === undefined) {
    return null;
  }
  return { ...found, rawSnippet: parts.join(' · ') };
}

// ---------------------------------------------------------------------------
// Tier 2 — microdata
// ---------------------------------------------------------------------------

function itemprop(root: HTMLElement, name: string): HTMLElement | null {
  return root.querySelector(`[itemprop="${name}"]`);
}

/**
 * The value of a microdata property.
 *
 * `content` first: `<meta itemprop="price" content="1299.00">` carries the machine
 * value, and the visible text next to it is formatted for a human ("$1,299").
 */
function propValue(el: HTMLElement | null): string | undefined {
  if (!el) return undefined;
  const content = el.getAttribute('content');
  if (content?.trim()) return content.trim();
  const src = el.getAttribute('src') ?? el.getAttribute('href');
  if (src?.trim()) return src.trim();
  const text = el.text.trim();
  return text || undefined;
}

function microdataDimensions(root: HTMLElement): Dimensions | null {
  const found: Dimensions = { confidence: 'labelled' };
  const parts: string[] = [];

  for (const [property, axis] of Object.entries(AXIS_BY_PROPERTY)) {
    const el = itemprop(root, property);
    const raw = propValue(el);
    if (!raw) continue;

    const unit = el?.getAttribute('data-unit') ?? el?.getAttribute('unitText') ?? '';
    const mm = parseExplicitLength(unit ? `${raw} ${unit}` : raw);
    if (mm !== null && found[axis] === undefined) {
      found[axis] = mm;
      parts.push(`${property}: ${raw}${unit ? ` ${unit}` : ''}`);
    }
  }

  if (found.widthMm === undefined && found.depthMm === undefined && found.heightMm === undefined) {
    return null;
  }
  return { ...found, rawSnippet: parts.join(' · ') };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function meta(root: HTMLElement, property: string): string | undefined {
  const el =
    root.querySelector(`meta[property="${property}"]`) ??
    root.querySelector(`meta[name="${property}"]`);
  return el?.getAttribute('content')?.trim() || undefined;
}

/** Absolute, so an image the page names relatively is still fetchable elsewhere. */
export function resolveUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

/** Page text with script and style content removed, for the tier-4 fallback. */
function visibleText(root: HTMLElement): string {
  for (const el of root.querySelectorAll('script, style, noscript')) el.remove();
  return root.text.replace(/\s+/g, ' ').trim();
}

/**
 * Assign only when there is something to assign.
 *
 * `exactOptionalPropertyTypes` draws the distinction this whole file depends on:
 * "absent" and "present but undefined" are not the same, and a tier that found
 * nothing must leave the field for the next tier rather than filling it with
 * undefined and stopping the chain.
 */
function set<K extends keyof ProductDraft>(
  draft: ProductDraft,
  key: K,
  value: ProductDraft[K] | undefined,
): void {
  if (value !== undefined) draft[key] = value;
}

export function parseProduct(html: string, pageUrl: string): ProductDraft {
  const root = parse(html);

  // --- tier 1 -------------------------------------------------------------
  let product: Record<string, unknown> | undefined;
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const found = findProducts(JSON.parse(script.text));
      if (found.length > 0) {
        product = found[0];
        break;
      }
    } catch {
      // A page with one broken JSON-LD block and one good one is common enough that
      // giving up on the first parse error would cost real coverage.
    }
  }

  const draft: ProductDraft = {};
  let dimensions: Dimensions | null = null;
  let dimensionSource: ProductTier | undefined;

  if (product) {
    const name = firstString(product['name']);
    if (name) draft.name = name;
    const image = resolveUrl(firstString(product['image']), pageUrl);
    if (image) draft.imageUrl = image;

    const offers = product['offers'];
    const offer = Array.isArray(offers) ? offers[0] : offers;
    if (typeof offer === 'object' && offer !== null) {
      const price = (offer as Record<string, unknown>)['price'];
      if (typeof price === 'string' || typeof price === 'number') draft.price = String(price);
    }

    dimensions = jsonLdDimensions(product);
    if (dimensions) dimensionSource = 'json-ld';
  }

  // --- tier 2 -------------------------------------------------------------
  if (!draft.name) set(draft, 'name', propValue(itemprop(root, 'name')));
  if (!draft.imageUrl) set(draft, 'imageUrl', resolveUrl(propValue(itemprop(root, 'image')), pageUrl));
  if (!draft.price) set(draft, 'price', propValue(itemprop(root, 'price')));

  if (!dimensions) {
    dimensions = microdataDimensions(root);
    if (dimensions) dimensionSource = 'microdata';
  }

  // --- tier 3 -------------------------------------------------------------
  if (!draft.name) set(draft, 'name', meta(root, 'og:title'));
  if (!draft.imageUrl) set(draft, 'imageUrl', resolveUrl(meta(root, 'og:image'), pageUrl));

  // --- tier 4 -------------------------------------------------------------
  // `visibleText` strips script tags, so it must run after the JSON-LD pass above.
  if (!dimensions) {
    const reading = readDimensions(visibleText(root));
    if (reading) {
      dimensions = {
        ...(reading.widthMm !== undefined ? { widthMm: reading.widthMm } : {}),
        ...(reading.depthMm !== undefined ? { depthMm: reading.depthMm } : {}),
        ...(reading.heightMm !== undefined ? { heightMm: reading.heightMm } : {}),
        confidence: reading.confidence,
        rawSnippet: reading.snippet,
      };
      dimensionSource = 'text';
    }
  }

  if (!draft.name) {
    const title = root.querySelector('title')?.text.trim();
    if (title) draft.name = title;
  }

  if (dimensions) {
    if (dimensions.widthMm !== undefined) draft.widthMm = dimensions.widthMm;
    if (dimensions.depthMm !== undefined) draft.depthMm = dimensions.depthMm;
    if (dimensions.heightMm !== undefined) draft.heightMm = dimensions.heightMm;
    draft.confidence = dimensions.confidence;
    if (dimensions.rawSnippet) draft.rawSnippet = dimensions.rawSnippet;
    if (dimensionSource) draft.dimensionSource = dimensionSource;
  }

  return draft;
}
