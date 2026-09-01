/**
 * Units. See PLAN.md §3.
 *
 * The canonical unit everywhere in `src/core/` is the **integer millimetre**.
 * Floating-point millimetres make snapping, equality, and "is this flush?" tests
 * unreliable; integers make them exact, and a millimetre is finer than any real
 * measurement in this domain.
 *
 * Display units are a *view preference*. They are parsed on input and formatted on
 * output, and never participate in computation.
 */

export const DISPLAY_UNITS = ['ft-in', 'in', 'mm', 'cm', 'm'] as const;
export type DisplayUnit = (typeof DISPLAY_UNITS)[number];

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;

/** Snap a real number to the canonical integer-millimetre grid. */
export function mm(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`units: non-finite length ${value}`);
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const FEET_INCHES = /^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?$/i;
const SUFFIXED = /^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|inch|inches|"|ft|feet|foot|')$/i;
const BARE = /^(-?\d+(?:\.\d+)?)$/;

const SUFFIX_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: MM_PER_INCH,
  inch: MM_PER_INCH,
  inches: MM_PER_INCH,
  '"': MM_PER_INCH,
  ft: MM_PER_FOOT,
  feet: MM_PER_FOOT,
  foot: MM_PER_FOOT,
  "'": MM_PER_FOOT,
};

/** The unit a bare number is interpreted as, per display preference. */
const BARE_UNIT_MM: Record<DisplayUnit, number> = {
  'ft-in': MM_PER_INCH, // a bare number typed in a ft-in document means inches
  in: MM_PER_INCH,
  mm: 1,
  cm: 10,
  m: 1000,
};

/**
 * Parse a user-typed length to integer millimetres.
 *
 * Accepts `1880`, `188cm`, `1.88m`, `74in`, `74"`, `6'2"`, `6 ft 2 in`, `6'`.
 * A bare number is interpreted in `unit`. Returns `null` on anything unparseable,
 * so callers can reject input without exception handling.
 */
export function parseLength(input: string, unit: DisplayUnit): number | null {
  const s = input.trim().replace(/\s+/g, ' ');
  if (s === '') return null;

  const fi = FEET_INCHES.exec(s);
  if (fi) {
    const feet = Number(fi[1]);
    const inches = Number(fi[2]);
    const sign = feet < 0 ? -1 : 1;
    return mm(Math.abs(feet) * MM_PER_FOOT * sign + inches * MM_PER_INCH * sign);
  }

  const suf = SUFFIXED.exec(s);
  if (suf) {
    const factor = SUFFIX_TO_MM[suf[2]!.toLowerCase()];
    if (factor === undefined) return null;
    return mm(Number(suf[1]) * factor);
  }

  const bare = BARE.exec(s);
  if (bare) return mm(Number(bare[1]) * BARE_UNIT_MM[unit]);

  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function trimZeros(n: number, places: number): string {
  return Number(n.toFixed(places)).toString();
}

/** Format integer millimetres for display. Inverse-ish of `parseLength`. */
export function formatLength(lengthMm: number, unit: DisplayUnit): string {
  switch (unit) {
    case 'mm':
      return `${Math.round(lengthMm)} mm`;
    case 'cm':
      return `${trimZeros(lengthMm / 10, 1)} cm`;
    case 'm':
      return `${trimZeros(lengthMm / 1000, 3)} m`;
    case 'in':
      return `${trimZeros(lengthMm / MM_PER_INCH, 2)}"`;
    case 'ft-in': {
      const sign = lengthMm < 0 ? '-' : '';
      const totalInches = Math.abs(lengthMm) / MM_PER_INCH;
      let feet = Math.floor(totalInches / 12);
      let inches = totalInches - feet * 12;
      // Round to 1/8" — the finest division anyone reads off a tape measure.
      inches = Math.round(inches * 8) / 8;
      if (inches >= 12) {
        feet += 1;
        inches -= 12;
      }
      return `${sign}${feet}' ${trimZeros(inches, 3)}"`;
    }
  }
}

/** Format an area (mm²) in the unit family the document displays. */
export function formatArea(areaMm2: number, unit: DisplayUnit): string {
  if (unit === 'ft-in' || unit === 'in') {
    return `${trimZeros(areaMm2 / (MM_PER_FOOT * MM_PER_FOOT), 1)} sq ft`;
  }
  return `${trimZeros(areaMm2 / 1_000_000, 2)} m²`;
}

// ---------------------------------------------------------------------------
// Renderer boundary
// ---------------------------------------------------------------------------

/**
 * Document space is Z-up (`x` east, `y` south, `z` up) — the architectural
 * convention. three.js is Y-up. The swap lives here and nowhere else.
 */
export type DocPoint3 = { x: number; y: number; z: number };
export type ThreePoint3 = { x: number; y: number; z: number };

/** Document millimetres (Z-up) → three.js metres (Y-up). */
export function docToThree(p: DocPoint3): ThreePoint3 {
  return { x: p.x / 1000, y: p.z / 1000, z: p.y / 1000 };
}

/** three.js metres (Y-up) → document millimetres (Z-up). */
export function threeToDoc(p: ThreePoint3): DocPoint3 {
  return { x: mm(p.x * 1000), y: mm(p.z * 1000), z: mm(p.y * 1000) };
}
