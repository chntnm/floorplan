import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProduct, resolveUrl } from './product';

/**
 * Parser fixtures. **Synthetic** — see `fixtures/product/README.md` for why, and for
 * what that costs. Each one exercises a single tier, and several are built so that a
 * reading which fell through to a *lower* tier is visible as a wrong number rather
 * than as a plausible one.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'product');
const PAGE = 'https://shop.example.com/p/thing';

function fixture(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

describe('tier 1 — JSON-LD', () => {
  it('reads name, price, image and dimensions', () => {
    const draft = parseProduct(fixture('json-ld.html'), PAGE);

    expect(draft.name).toBe('Harlow Sofa');
    expect(draft.price).toBe('1299.00');
    expect(draft.imageUrl).toBe('https://shop.example.com/img/harlow-1.jpg');
    expect(draft.widthMm).toBe(2134);
    expect(draft.depthMm).toBe(965);
    expect(draft.heightMm).toBe(813);
    expect(draft.dimensionSource).toBe('json-ld');
    expect(draft.confidence).toBe('labelled');
  });

  it('does not fall through to the page text when the structured data is good', () => {
    // The fixture's body says 999cm on every axis. Falling through would be a
    // perfectly plausible-looking sofa, which is the failure mode worth catching.
    const draft = parseProduct(fixture('json-ld.html'), PAGE);
    expect(draft.widthMm).not.toBe(9990);
  });

  it('prefers the structured name over the OpenGraph one', () => {
    // Both are present in that fixture, and og:title carries a "(og)" marker.
    expect(parseProduct(fixture('json-ld.html'), PAGE).name).toBe('Harlow Sofa');
  });

  it('finds a Product buried in an @graph beside other node types', () => {
    const draft = parseProduct(fixture('json-ld-graph.html'), PAGE);
    expect(draft.name).toBe('Dover Dresser');
    expect(draft.widthMm).toBe(1200);
    expect(draft.depthMm).toBe(450);
    expect(draft.heightMm).toBe(810);
  });

  it('reads unitCode and unitText alike', () => {
    // `CMT`, `MMT` and a plain `"cm"` all appear in that one fixture.
    const draft = parseProduct(fixture('json-ld-graph.html'), PAGE);
    expect(draft.widthMm).toBe(1200);
    expect(draft.price).toBe('899');
  });

  it('recovers from a broken JSON-LD block and reads the next one', () => {
    // A page with one malformed block and one good one is common enough that giving
    // up on the first parse error would cost real coverage.
    expect(parseProduct(fixture('messy.html'), PAGE).name).toBe('Marlow Bed');
  });

  it('refuses a structured number with no unit, and falls through for that axis', () => {
    // `{ value: 1524 }` with no unitCode. A structured field is not more trustworthy
    // than a paragraph when the thing that makes a number a length is missing from
    // both — so the width comes from the text tier instead, at 60".
    const draft = parseProduct(fixture('messy.html'), PAGE);
    expect(draft.heightMm).toBe(610);
    expect(draft.dimensionSource).toBe('json-ld');
    expect(draft.widthMm).toBeUndefined();
  });
});

describe('tier 2 — microdata', () => {
  it('reads a page with itemprop and no JSON-LD', () => {
    const draft = parseProduct(fixture('microdata.html'), PAGE);

    expect(draft.name).toBe('Ash Dining Table');
    expect(draft.imageUrl).toBe('https://cdn.example.com/ash.jpg');
    expect(draft.widthMm).toBe(1800);
    expect(draft.depthMm).toBe(900);
    expect(draft.heightMm).toBe(750);
    expect(draft.dimensionSource).toBe('microdata');
  });

  it('takes the machine value from a meta itemprop, not the formatted text', () => {
    expect(parseProduct(fixture('microdata.html'), PAGE).price).toBe('749.00');
  });
});

describe('tier 3 — OpenGraph', () => {
  it('gets a name and an image and admits it has no dimensions', () => {
    // A social-sharing card is not a spec sheet. Half a draft is still worth having:
    // the form opens named, with the measurements left to the user.
    const draft = parseProduct(fixture('opengraph.html'), PAGE);

    expect(draft.name).toBe('Wren Armchair');
    expect(draft.imageUrl).toBe('https://shop.example.com/media/wren.png');
    expect(draft.widthMm).toBeUndefined();
    expect(draft.dimensionSource).toBeUndefined();
    expect(draft.confidence).toBeUndefined();
  });
});

describe('tier 4 — the page text', () => {
  it('reads a spec table on a page with no structured data at all', () => {
    const draft = parseProduct(fixture('spec-table.html'), PAGE);

    expect(draft.name).toBe('Kepler Bookcase');
    expect(draft.widthMm).toBe(800); // 31 1/2"
    expect(draft.depthMm).toBe(330);
    expect(draft.heightMm).toBe(1880); // 6' 2"
    expect(draft.dimensionSource).toBe('text');
  });

  it('keeps the text the numbers came from', () => {
    // §7.2: a scraped dimension a person cannot check against the page is one they
    // have to take on trust, and the dialog exists precisely to avoid that.
    const draft = parseProduct(fixture('spec-table.html'), PAGE);
    expect(draft.rawSnippet).toBeTruthy();
    expect(draft.rawSnippet).toContain('31');
  });

  it('does not read the JSON-LD block as page text', () => {
    // Script content is stripped before the text pass. Without that, a page whose
    // structured data failed to parse would have its raw JSON scanned for numbers.
    const html = `<html><head><script type="application/ld+json">{"broken":</script></head>
      <body><h1>Thing</h1><p>No dimensions here.</p></body></html>`;
    expect(parseProduct(html, PAGE).widthMm).toBeUndefined();
  });
});

describe('anything else', () => {
  it('falls back to the document title for a name', () => {
    const draft = parseProduct('<html><head><title>Plain Page</title></head><body></body></html>', PAGE);
    expect(draft.name).toBe('Plain Page');
  });

  it('returns an empty draft rather than throwing on rubbish', () => {
    expect(parseProduct('not html at all', PAGE)).toEqual({});
  });

  it('makes a relative image absolute against the page it came from', () => {
    expect(resolveUrl('/img/a.jpg', PAGE)).toBe('https://shop.example.com/img/a.jpg');
    expect(resolveUrl('../b.jpg', PAGE)).toBe('https://shop.example.com/b.jpg');
    expect(resolveUrl(undefined, PAGE)).toBeUndefined();
    expect(resolveUrl('http://[bad', PAGE)).toBeUndefined();
  });
});
