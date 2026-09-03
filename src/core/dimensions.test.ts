import { describe, expect, it } from 'vitest';
import { parseExplicitLength, readDimensions } from './dimensions';

describe('a scraped length needs its own unit', () => {
  it('refuses a bare number', () => {
    // The trap this module exists for. `parseLength` would read this in the document's
    // display unit, so `84` in a metric document becomes an 84mm sofa — plausible,
    // silent, and wrong. There is no display unit on a retailer's page to appeal to.
    expect(parseExplicitLength('84')).toBeNull();
    expect(parseExplicitLength('  1800 ')).toBeNull();
  });

  it('reads inches, however they are written', () => {
    expect(parseExplicitLength('84"')).toBe(2134);
    expect(parseExplicitLength('84 in')).toBe(2134);
    expect(parseExplicitLength('84 inches')).toBe(2134);
    expect(parseExplicitLength('84”')).toBe(2134);
  });

  it('reads metric', () => {
    expect(parseExplicitLength('213 cm')).toBe(2130);
    expect(parseExplicitLength('2.13m')).toBe(2130);
    expect(parseExplicitLength('810 mm')).toBe(810);
    expect(parseExplicitLength('2,13 m')).toBe(2130);
  });

  it('reads a thousands separator as one', () => {
    expect(parseExplicitLength('1,524 mm')).toBe(1524);
  });

  it('reads feet and inches together', () => {
    expect(parseExplicitLength('6 ft 2 in')).toBe(1880);
    expect(parseExplicitLength(`6' 2"`)).toBe(1880);
    // The inch mark is optional, because half the internet leaves it off.
    expect(parseExplicitLength(`5'11`)).toBe(1803);
  });

  it('reads the fractions a furniture page actually prints', () => {
    expect(parseExplicitLength('38 1/2 in')).toBe(978);
  });

  it('refuses a zero or negative dimension', () => {
    expect(parseExplicitLength('0 in')).toBeNull();
    expect(parseExplicitLength('-4 in')).toBeNull();
  });

  it('refuses a unit it does not know', () => {
    expect(parseExplicitLength('84 cubits')).toBeNull();
  });
});

describe('finding three numbers on a page', () => {
  it('reads suffixed labels', () => {
    const found = readDimensions('84"W x 38"D x 32"H');
    expect(found).toMatchObject({
      widthMm: 2134,
      depthMm: 965,
      heightMm: 813,
      confidence: 'labelled',
    });
  });

  it('reads prefixed labels', () => {
    expect(readDimensions('W 84 in x D 38 in x H 32 in')).toMatchObject({
      widthMm: 2134,
      depthMm: 965,
      heightMm: 813,
      confidence: 'labelled',
    });
  });

  it('reads spec-table rows', () => {
    const text = 'Width: 84 in\nDepth: 38 in\nHeight: 32 in\nWeight: 90 lb';
    expect(readDimensions(text)).toMatchObject({
      widthMm: 2134,
      depthMm: 965,
      heightMm: 813,
      confidence: 'labelled',
    });
  });

  it('treats length as the depth axis', () => {
    // A sofa is 84"W x 38"D and a dining table is 84"L x 38"W. The axis the second
    // calls width is the one the first calls depth, and a table entered 84 deep by 38
    // wide is rotated ninety degrees in every room it is placed in.
    expect(readDimensions('84"L x 38"W x 30"H')).toMatchObject({
      depthMm: 2134,
      widthMm: 965,
      heightMm: 762,
    });
  });

  it('guesses W x D x H for a bare triple, and says it guessed', () => {
    expect(readDimensions('213 cm x 96 cm x 81 cm')).toMatchObject({
      widthMm: 2130,
      depthMm: 960,
      heightMm: 810,
      confidence: 'ordered',
    });
  });

  it('prefers a label over an order when the page has both', () => {
    // `confidence` describes how the answer was reached. Reading the labels and then
    // reporting `ordered` because a triple also matched would understate what is known;
    // reading the triple and reporting `labelled` would overstate it.
    const found = readDimensions('Dimensions: 32"H x 84"W x 38"D');
    expect(found?.confidence).toBe('labelled');
    expect(found?.heightMm).toBe(813);
    expect(found?.widthMm).toBe(2134);
  });

  it('takes a partial reading rather than nothing', () => {
    // A page that states a height and leaves the rest to a diagram. Two fields
    // pre-filled is better than an empty form, and the third is editable anyway.
    const found = readDimensions('Height: 32 in. Seat height 18 in.');
    expect(found?.heightMm).toBe(813);
    expect(found?.widthMm).toBeUndefined();
  });

  it('finds nothing in a page with no dimensions', () => {
    expect(readDimensions('A very comfortable sofa. Free delivery.')).toBeNull();
  });

  it('is not fooled by a price or a product code', () => {
    expect(readDimensions('$1,299.00 — model 84523')).toBeNull();
  });

  it('carries the text the numbers came from', () => {
    // §7.2: a dimension a person cannot check against the page is one they have to
    // take on trust, which is what the confirm dialog exists to avoid.
    const found = readDimensions('Overall dimensions: 84"W x 38"D x 32"H. Solid oak frame.');
    expect(found?.snippet).toContain('84');
    expect(found?.snippet.length).toBeLessThanOrEqual(162);
  });
});
