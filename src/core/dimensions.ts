/**
 * Reading dimensions out of retailer prose. See PLAN.md §7.2.
 *
 * ## Why this is not `parseLength`
 *
 * `parseLength` reads a bare number in the **document's display unit**. That is right
 * for a field a person is typing into, where the unit is on screen next to the cursor,
 * and it is exactly wrong here. A spec table saying `84 x 38 x 32` in a document set to
 * millimetres would silently become an 84mm sofa; the same trap, in the other
 * direction, made a `1800` typed into a ft-in ceiling field mean 1800 inches.
 *
 * So **every number here needs its own unit**. A bare number is not a dimension, it is
 * a number, and it is refused. The one exception is a run like `84" x 38" x 32"`, where
 * the units are stated once per value — and even there each value carries its own.
 *
 * ## What it is allowed to be wrong about
 *
 * Nothing scraped becomes geometry unconfirmed (§7.2), so the bar here is "good enough
 * to put in a form the user is about to read", not "certain". Where the order of a bare
 * triple is unknowable it takes W × D × H, says so through `confidence`, and hands over
 * the text it read so the user can check it against the page.
 *
 * Pure — no DOM, no network.
 */

/** Millimetres per unit, keyed by every spelling seen in the wild. */
const UNITS: Record<string, number> = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  millimetre: 1,
  millimetres: 1,
  cm: 10,
  centimeter: 10,
  centimeters: 10,
  centimetre: 10,
  centimetres: 10,
  m: 1000,
  meter: 1000,
  meters: 1000,
  metre: 1000,
  metres: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  '"': 25.4,
  '”': 25.4,
  '″': 25.4,
  "'": 304.8,
  '’': 304.8,
  '′': 304.8,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8,
};

const UNIT_PATTERN =
  '(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?|in(?:ch(?:es)?)?|["”″]|ft|feet|foot|[\'’′])';

const NUMBER = String.raw`\d+(?:[.,]\d+)?(?:\s*\d+\/\d+)?`;

/**
 * One length as it appears in prose, a feet-and-inches compound included.
 *
 * The optional tail is what makes `6 ft 2 in` one value rather than two, and it has to
 * be in **every** matcher rather than only the spec-table one. Flattening
 * `<th>Height</th><td>6 ft 2 in</td>` gives `Height6 ft 2 in` with no space, so there
 * is no word boundary for the row matcher to find and the labelled matcher is what
 * actually reads it — which, without the tail, stopped at `6 ft` and produced a
 * bookcase two inches short.
 */
const VALUE = `(?:${NUMBER})\\s*(?:${UNIT_PATTERN})(?:\\s*(?:${NUMBER})\\s*(?:${UNIT_PATTERN}))?`;

function toNumber(raw: string): number | null {
  // "38 1/2" — retailers write mixed fractions and a plain `Number()` gives NaN.
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(raw.trim());
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (den === 0) return null;
    return whole + num / den;
  }

  const fraction = /^(\d+)\/(\d+)$/.exec(raw.trim());
  if (fraction) {
    const den = Number(fraction[2]);
    return den === 0 ? null : Number(fraction[1]) / den;
  }

  // A comma is a thousands separator far more often than a decimal point on the
  // English-language pages these fixtures are drawn from, but `2,5 cm` exists. Treat
  // it as a decimal only when exactly one or two digits follow.
  const normalised = /,\d{1,2}$/.test(raw.trim()) ? raw.replace(',', '.') : raw.replace(/,/g, '');
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

function unitFactor(raw: string): number | null {
  return UNITS[raw.trim().toLowerCase()] ?? null;
}

/**
 * One length, in millimetres, rounded to the integer the document stores.
 *
 * Returns null for a bare number. That is the whole point — see the header.
 */
export function parseExplicitLength(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Feet-and-inches compound: `6 ft 2 in`, `6' 2"`, `5'11`. The trailing inch unit is
  // optional because `5'11` is how half the internet writes it.
  const compound = new RegExp(
    String.raw`^(${NUMBER})\s*(ft|feet|foot|['’′])\s*(?:(${NUMBER})\s*(in|inch|inches|["”″])?)?$`,
    'i',
  ).exec(trimmed);
  if (compound) {
    const feet = toNumber(compound[1] ?? '');
    if (feet === null) return null;
    const inches = compound[3] ? toNumber(compound[3]) : 0;
    if (inches === null) return null;
    return Math.round(feet * 304.8 + inches * 25.4);
  }

  const single = new RegExp(String.raw`^(${NUMBER})\s*(${UNIT_PATTERN})$`, 'i').exec(trimmed);
  if (!single) return null;

  const value = toNumber(single[1] ?? '');
  const factor = unitFactor(single[2] ?? '');
  if (value === null || factor === null) return null;
  if (!(value > 0)) return null;

  return Math.round(value * factor);
}

export type Triple = {
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
};

/** How much to trust the mapping from numbers to axes. */
export type DimensionConfidence = 'labelled' | 'ordered';

export type DimensionReading = Triple & {
  confidence: DimensionConfidence;
  /** The text the numbers came from, kept so a person can check it. */
  snippet: string;
};

const AXIS_WORDS: Record<string, keyof Triple> = {
  w: 'widthMm',
  width: 'widthMm',
  d: 'depthMm',
  depth: 'depthMm',
  l: 'depthMm',
  length: 'depthMm',
  h: 'heightMm',
  height: 'heightMm',
};

function axisOf(word: string): keyof Triple | null {
  return AXIS_WORDS[word.trim().toLowerCase()] ?? null;
}

/**
 * `84"W x 38"D x 32"H` and `W 84 in x D 38 in x H 32 in`.
 *
 * Both orders of label and value, because retailers use both and the label is the only
 * thing that makes the reading trustworthy. Depth also answers to *length*: a sofa is
 * `84"W x 38"D` and a dining table is `84"L x 38"W`, and the axis the second one calls
 * width is the one the first calls depth.
 */
function readLabelled(text: string): Triple | null {
  const found: Triple = {};
  const word = '(W|D|L|H|Width|Depth|Length|Height)';

  const suffixed = new RegExp(`(${VALUE})\\s*${word}\\b`, 'gi');
  const prefixed = new RegExp(`${word}\\s*[:\\-]?\\s*(${VALUE})`, 'gi');

  for (const m of text.matchAll(suffixed)) {
    const axis = axisOf(m[2] ?? '');
    const mm = parseExplicitLength(m[1] ?? '');
    if (axis && mm !== null && found[axis] === undefined) found[axis] = mm;
  }
  for (const m of text.matchAll(prefixed)) {
    const axis = axisOf(m[1] ?? '');
    const mm = parseExplicitLength(m[2] ?? '');
    if (axis && mm !== null && found[axis] === undefined) found[axis] = mm;
  }

  return Object.keys(found).length > 0 ? found : null;
}

/**
 * `213 cm x 96 cm x 81 cm`, with nothing saying which is which.
 *
 * Order is assumed W × D × H, which is the dominant convention and is still a guess —
 * `confidence: 'ordered'` is how the caller knows to say so.
 */
function readTriple(text: string): Triple | null {
  const value = `(${NUMBER})\\s*(${UNIT_PATTERN})`;
  const sep = String.raw`\s*[x×]\s*`;
  const m = new RegExp(`${value}${sep}${value}${sep}${value}`, 'i').exec(text);
  if (!m) return null;

  const w = parseExplicitLength(`${m[1]}${m[2]}`);
  const d = parseExplicitLength(`${m[3]}${m[4]}`);
  const h = parseExplicitLength(`${m[5]}${m[6]}`);
  if (w === null || d === null || h === null) return null;

  return { widthMm: w, depthMm: d, heightMm: h };
}

/** Rows in a spec table: `Width: 84 in`, one per line. */
function readRows(text: string): Triple | null {
  const found: Triple = {};
  const pattern = new RegExp(`\\b(Width|Depth|Length|Height)\\b\\s*[:\\-]?\\s*(${VALUE})`, 'gi');

  for (const m of text.matchAll(pattern)) {
    const axis = axisOf(m[1] ?? '');
    const mm = parseExplicitLength(m[2] ?? '');
    if (axis && mm !== null && found[axis] === undefined) found[axis] = mm;
  }

  return Object.keys(found).length > 0 ? found : null;
}

/**
 * Read whatever dimensions a blob of text contains.
 *
 * Labelled forms are tried first and win outright: a label is evidence, and an
 * unlabelled triple in the same paragraph is a guess about the same numbers. Falling
 * back to the triple only when nothing was labelled is what keeps `confidence`
 * honest — it describes how the answer was reached, not how many fields it filled.
 */
export function readDimensions(text: string): DimensionReading | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;

  const rows = readRows(flat);
  const labelled = readLabelled(flat);
  const merged = rows || labelled ? { ...labelled, ...rows } : null;
  if (merged) return { ...merged, confidence: 'labelled', snippet: snippetAround(text, merged) };

  const triple = readTriple(flat);
  if (triple) return { ...triple, confidence: 'ordered', snippet: snippetAround(text, triple) };

  return null;
}

/**
 * A short piece of the source text, for the confirm dialog to show.
 *
 * §7.2 requires the raw text the numbers came from to be displayed alongside them. A
 * dimension a person cannot check against the page is a dimension they have to take on
 * trust, which is the thing the dialog exists to avoid.
 */
function snippetAround(text: string, found: Triple): string {
  const first = Object.values(found)[0];
  const flat = text.replace(/\s+/g, ' ').trim();
  if (first === undefined) return flat.slice(0, 160);

  // Anchor on any number, then widen — the exact digits in the source are in whatever
  // unit the page used, and are not the millimetres we converted them to.
  const at = flat.search(new RegExp(NUMBER));
  if (at < 0) return flat.slice(0, 160);

  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 160)}${
    flat.length > start + 160 ? '…' : ''
  }`;
}
