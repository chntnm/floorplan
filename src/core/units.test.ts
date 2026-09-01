import { describe, expect, it } from 'vitest';
import {
  docToThree,
  formatArea,
  formatLength,
  mm,
  parseLength,
  threeToDoc,
  MM_PER_INCH,
} from './units';

describe('mm', () => {
  it('snaps to integers', () => {
    expect(mm(1879.6)).toBe(1880);
    expect(mm(1880.4)).toBe(1880);
  });

  it('rejects non-finite input rather than producing NaN geometry', () => {
    expect(() => mm(NaN)).toThrow(RangeError);
    expect(() => mm(Infinity)).toThrow(RangeError);
  });
});

describe('parseLength', () => {
  it('parses feet-inches in every common spelling', () => {
    const expected = mm(6 * 304.8 + 2 * MM_PER_INCH); // 1880
    expect(parseLength(`6'2"`, 'ft-in')).toBe(expected);
    expect(parseLength(`6' 2"`, 'ft-in')).toBe(expected);
    expect(parseLength('6 ft 2 in', 'ft-in')).toBe(expected);
    expect(parseLength('6ft 2in', 'ft-in')).toBe(expected);
  });

  it('parses suffixed units regardless of the display preference', () => {
    expect(parseLength('188cm', 'ft-in')).toBe(1880);
    expect(parseLength('1.88m', 'ft-in')).toBe(1880);
    expect(parseLength('1880mm', 'in')).toBe(1880);
    expect(parseLength('74"', 'mm')).toBe(mm(74 * MM_PER_INCH));
    expect(parseLength('2ft', 'mm')).toBe(mm(609.6));
  });

  it('interprets a bare number in the display unit', () => {
    expect(parseLength('1880', 'mm')).toBe(1880);
    expect(parseLength('188', 'cm')).toBe(1880);
    expect(parseLength('1.88', 'm')).toBe(1880);
    // A bare number in a ft-in document means inches — nobody types bare feet.
    expect(parseLength('74', 'ft-in')).toBe(mm(74 * MM_PER_INCH));
    expect(parseLength('74', 'in')).toBe(mm(74 * MM_PER_INCH));
  });

  it('returns null on unparseable input instead of throwing', () => {
    expect(parseLength('', 'mm')).toBeNull();
    expect(parseLength('wide', 'mm')).toBeNull();
    expect(parseLength('12 furlongs', 'mm')).toBeNull();
    expect(parseLength('6-2', 'ft-in')).toBeNull();
  });

  it('handles negatives', () => {
    expect(parseLength('-500', 'mm')).toBe(-500);
    expect(parseLength('-50cm', 'mm')).toBe(-500);
  });
});

describe('formatLength', () => {
  it('formats each unit', () => {
    expect(formatLength(1880, 'mm')).toBe('1880 mm');
    expect(formatLength(1880, 'cm')).toBe('188 cm');
    expect(formatLength(1880, 'm')).toBe('1.88 m');
    expect(formatLength(1880, 'ft-in')).toBe(`6' 2"`);
  });

  it('carries 12" up into the next foot', () => {
    // 2438mm is 7' 11.97" — must not render as 7' 12".
    expect(formatLength(2438, 'ft-in')).toBe(`8' 0"`);
  });

  it('round-trips through parseLength within the display precision', () => {
    for (const value of [0, 25, 813, 1524, 2032, 2438, 3048]) {
      const round = parseLength(formatLength(value, 'ft-in'), 'ft-in');
      expect(round).not.toBeNull();
      // ft-in display rounds to 1/8", so allow ~1.6mm of display error.
      expect(Math.abs(round! - value)).toBeLessThanOrEqual(2);
    }
  });

  it('formats negatives', () => {
    expect(formatLength(-1880, 'ft-in')).toBe(`-6' 2"`);
  });
});

describe('formatArea', () => {
  it('uses sq ft for imperial and m² for metric', () => {
    const tenSqFtInMm2 = 10 * 304.8 * 304.8;
    expect(formatArea(tenSqFtInMm2, 'ft-in')).toBe('10 sq ft');
    expect(formatArea(1_000_000, 'm')).toBe('1 m²');
  });
});

describe('document ↔ three.js conversion', () => {
  it('swaps the up axis and scales mm to metres', () => {
    // Document is Z-up; three.js is Y-up.
    expect(docToThree({ x: 1000, y: 2000, z: 3000 })).toEqual({ x: 1, y: 3, z: 2 });
  });

  it('round-trips both directions', () => {
    const p = { x: 1234, y: -5678, z: 900 };
    expect(threeToDoc(docToThree(p))).toEqual(p);

    const t = { x: 1.5, y: 2.5, z: -3.5 };
    expect(docToThree(threeToDoc(t))).toEqual(t);
  });
});
