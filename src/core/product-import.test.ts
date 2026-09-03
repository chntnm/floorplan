import { describe, expect, it } from 'vitest';
import { acceptedUnchanged, evidenceFor, itemDraftFrom, sourceFor } from './product-import';
import type { ItemDraft } from './catalog';
import type { ProductDraft } from './product';

const SCRAPED: ProductDraft = {
  name: 'Harlow Sofa',
  widthMm: 2134,
  depthMm: 965,
  heightMm: 813,
  confidence: 'labelled',
  rawSnippet: 'Width: 84 in · Depth: 38 in · Height: 32 in',
  dimensionSource: 'json-ld',
};

function submitted(over: Partial<ItemDraft> = {}): ItemDraft {
  return { ...itemDraftFrom(SCRAPED), ...over };
}

describe('opening the form', () => {
  it('prefills what was found', () => {
    expect(itemDraftFrom(SCRAPED)).toMatchObject({
      name: 'Harlow Sofa',
      widthMm: 2134,
      depthMm: 965,
      heightMm: 813,
      shape: 'rect',
    });
  });

  it('leaves a dimension the page did not give at zero', () => {
    expect(itemDraftFrom({ name: 'Wren Armchair' })).toMatchObject({
      name: 'Wren Armchair',
      widthMm: 0,
      depthMm: 0,
      heightMm: 0,
    });
  });

  it('does not guess a category', () => {
    // Category drives `voidBelowMm`, which decides whether a rug under this thing is a
    // collision. Too load-bearing to infer from a marketing title, and it is one
    // select on a form the user is already reading.
    expect(itemDraftFrom({ name: 'Harlow Dining Table' }).category).toBe('other');
  });

  it('gives a nameless page a name that can be corrected', () => {
    // An empty name is refused by `createCatalogItem`. A placeholder is easier to fix
    // than an error about a field the user never saw.
    expect(itemDraftFrom({}).name).toBe('Imported item');
  });
});

describe('parsed against confirmed', () => {
  it('is parsed when the numbers went in as they came off the page', () => {
    expect(sourceFor({ url: 'https://x/p', scraped: SCRAPED, submitted: submitted() })).toMatchObject({
      confidence: 'parsed',
    });
  });

  it('is confirmed once every scraped dimension has been changed', () => {
    const edited = submitted({ widthMm: 2000, depthMm: 900, heightMm: 800 });
    expect(sourceFor({ url: 'https://x/p', scraped: SCRAPED, submitted: edited })).toMatchObject({
      confidence: 'confirmed',
    });
  });

  it('stays parsed while any one scraped dimension is untouched', () => {
    // The flag means "this item carries a measurement nobody checked". One survivor
    // is enough for that to be true, and it is the one that makes the sofa not fit.
    const edited = submitted({ widthMm: 2000, depthMm: 900 });
    expect(acceptedUnchanged(SCRAPED, edited)).toBe(true);
  });

  it('is confirmed when the page gave no dimensions at all', () => {
    // An OpenGraph-only page. Every number was typed by a person, so there is nothing
    // unverified to flag.
    const scraped: ProductDraft = { name: 'Wren Armchair' };
    const typed: ItemDraft = { ...itemDraftFrom(scraped), widthMm: 800, depthMm: 850, heightMm: 900 };
    expect(sourceFor({ url: 'https://x/p', scraped, submitted: typed })).toMatchObject({
      confidence: 'confirmed',
    });
  });

  it('keeps the URL and the text the numbers came from', () => {
    const source = sourceFor({
      url: 'https://shop.example.com/p/harlow',
      scraped: SCRAPED,
      submitted: submitted(),
      now: '2026-09-03T10:00:00.000Z',
    });
    expect(source.url).toBe('https://shop.example.com/p/harlow');
    expect(source.retrievedAt).toBe('2026-09-03T10:00:00.000Z');
    expect(source.rawSnippet).toContain('84 in');
  });

  it('omits the snippet rather than storing an empty one', () => {
    const source = sourceFor({ url: 'https://x/p', scraped: { widthMm: 1 }, submitted: submitted() });
    expect('rawSnippet' in source).toBe(false);
  });
});

describe('what the dialog says about the numbers', () => {
  it('says when the order was assumed', () => {
    const evidence = evidenceFor({ ...SCRAPED, confidence: 'ordered' });
    expect(evidence).toContain('usual width × depth × height order');
  });

  it('says when they were labelled', () => {
    expect(evidenceFor(SCRAPED)).toContain('labelled');
  });

  it('says nothing when there is nothing to show', () => {
    expect(evidenceFor({ name: 'Thing' })).toBeNull();
  });
});
