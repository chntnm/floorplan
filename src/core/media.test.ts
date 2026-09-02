import { describe, expect, it } from 'vitest';
import { assetPath, extensionFor, isRaster, sniffMime } from './media';

/** Bytes with the given prefix, padded so length is never the thing under test. */
function withPrefix(prefix: number[], length = 64): Uint8Array {
  const out = new Uint8Array(length);
  out.set(prefix, 0);
  return out;
}

const PNG = withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = withPrefix([0xff, 0xd8, 0xff, 0xe0]);
const PDF = withPrefix([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function webp(): Uint8Array {
  const out = withPrefix([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  return out;
}

describe('sniffMime', () => {
  it('identifies the formats the importer accepts', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(webp())).toBe('image/webp');
  });

  it('returns null for a format it cannot import', () => {
    // GIF — a real image format, and deliberately not one of ours.
    expect(sniffMime(withPrefix([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(sniffMime(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
  });

  it('does not read past the end of a truncated file', () => {
    // Four bytes of a PNG signature. Reading the full eight would run off the end;
    // returning `null` beats throwing inside a decoder later.
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('requires WEBP after RIFF, not RIFF alone', () => {
    // A WAV file is also RIFF. Matching on the container alone would send audio to
    // the image decoder.
    const wav = withPrefix([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00]);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(sniffMime(wav)).toBeNull();
  });

  it('ignores what the file claims to be', () => {
    // The whole reason this function exists: a JPEG named plan.png arrives from the
    // browser as `image/png`, and the bytes are the only honest source.
    expect(sniffMime(JPEG)).toBe('image/jpeg');
  });
});

describe('isRaster', () => {
  it('separates what can be drawn from what must be rendered first', () => {
    expect(isRaster('image/png')).toBe(true);
    expect(isRaster('image/webp')).toBe(true);
    expect(isRaster('application/pdf')).toBe(false);
  });
});

describe('assetPath', () => {
  it('lands inside the container prefix writeSpace enforces', () => {
    expect(assetPath('abc', 'image/png')).toBe('assets/abc.png');
    expect(assetPath('abc', 'application/pdf')).toBe('assets/abc.pdf');
  });

  it('uses jpg for jpeg', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
  });
});
