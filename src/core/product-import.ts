/**
 * Turning a scraped product into something the item form can open. See PLAN.md §7.2.
 *
 * The bridge between `core/product.ts` (which reads a page) and `core/catalog.ts`
 * (which builds an item). Deliberately imports `ProductDraft` **as a type only**: the
 * parser pulls in `node-html-parser`, and a value import here would drag the whole
 * server-side parser into the browser bundle for the sake of a shape.
 *
 * ## What `parsed` versus `confirmed` actually means
 *
 * §7.2 stores confidence on the item and flags parsed-but-unconfirmed items in the
 * inventory list. Every item added through this path has passed a confirm dialog, so
 * "the user saw it" cannot be the distinction — it would make `confirmed` universal
 * and the flag meaningless.
 *
 * The distinction that is worth recording is narrower and more useful: **was any
 * dimension accepted exactly as scraped?** A number a person typed or corrected has
 * been checked against something. A number they left alone has not — they may have
 * read it, or they may have pressed Add. `parsed` marks the item as carrying at least
 * one measurement nobody verified, which is exactly the item you want flagged when a
 * sofa turns out not to fit.
 */

import type { ItemDraft } from './catalog';
import type { ProductSource } from './document';
import type { ProductDraft } from './product';

/** The item form's starting point. Missing dimensions stay at zero for the user. */
export function itemDraftFrom(product: ProductDraft): ItemDraft {
  return {
    // A page with no name at all still gives a form worth opening; an empty name is
    // refused by `createCatalogItem`, and a placeholder is easier to correct than an
    // error message about a field the user never filled in.
    name: product.name?.trim() || 'Imported item',
    // Not guessed from the name. A category drives `voidBelowMm`, which decides
    // whether a rug under this thing reads as a collision — too load-bearing to infer
    // from a marketing title, and one select the user is already looking at.
    category: 'other',
    widthMm: product.widthMm ?? 0,
    depthMm: product.depthMm ?? 0,
    heightMm: product.heightMm ?? 0,
    shape: 'rect',
  };
}

const AXES = ['widthMm', 'depthMm', 'heightMm'] as const;

/** Whether any dimension went in exactly as it came off the page. */
export function acceptedUnchanged(scraped: ProductDraft, submitted: ItemDraft): boolean {
  return AXES.some((axis) => scraped[axis] !== undefined && scraped[axis] === submitted[axis]);
}

export function sourceFor(params: {
  url: string;
  scraped: ProductDraft;
  submitted: ItemDraft;
  now?: string;
}): ProductSource {
  const { url, scraped, submitted } = params;

  return {
    url,
    retrievedAt: params.now ?? new Date().toISOString(),
    confidence: acceptedUnchanged(scraped, submitted) ? 'parsed' : 'confirmed',
    ...(scraped.rawSnippet ? { rawSnippet: scraped.rawSnippet } : {}),
  };
}

/** The sentence shown beside the form, so the numbers can be checked against the page. */
export function evidenceFor(scraped: ProductDraft): string | null {
  if (!scraped.rawSnippet) return null;

  const how =
    scraped.confidence === 'ordered'
      ? 'read in the usual width × depth × height order, which the page did not state'
      : 'read from labelled dimensions';

  return `${how}: ${scraped.rawSnippet}`;
}
