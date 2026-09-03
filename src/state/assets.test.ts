import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, type SpaceDocument } from '../core/document';
import {
  adoptAssets,
  assetIds,
  assetMapFor,
  assetUrl,
  clearAssets,
  getAsset,
  hasAsset,
  missingAssets,
  putAsset,
} from './assets';

function doc(): SpaceDocument {
  return createDocument({ id: 'doc', floorId: 'floor', now: '2026-01-01T00:00:00.000Z' });
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

beforeEach(() => {
  clearAssets();
});

describe('putAsset', () => {
  it('returns the manifest entry the document stores', () => {
    const ref = putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' });
    expect(ref).toEqual({ id: 'a1', path: 'assets/a1.png', mime: 'image/png', bytes: 5 });
  });

  it('keeps the bytes out of the document and in the store', () => {
    // The document goes through immer on every mutation; a megabyte of raster in
    // there would be snapshotted onto the undo stack.
    putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' });
    expect(getAsset('a1')?.bytes).toBe(BYTES);
    expect(hasAsset('a1')).toBe(true);
  });

  it('mints an id when the caller has none', () => {
    const ref = putAsset({ mime: 'application/pdf', bytes: BYTES });
    expect(ref.id).toMatch(/[0-9a-f-]{36}/);
    expect(ref.path).toBe(`assets/${ref.id}.pdf`);
  });
});

describe('assetMapFor', () => {
  it('produces the path-keyed map writeSpace wants', () => {
    const d = doc();
    d.assets = [putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' })];
    expect(assetMapFor(d)).toEqual({ 'assets/a1.png': BYTES });
  });

  it('throws rather than writing a container short of a referenced file', () => {
    // Silently writing `{}` here is what produces a .space that opens with a blank
    // background on somebody else's machine — the failure the format exists to stop.
    const d = doc();
    d.assets = [{ id: 'gone', path: 'assets/gone.png', mime: 'image/png', bytes: 12 }];
    expect(() => assetMapFor(d)).toThrow(/no longer loaded/);
  });

  it('names every missing file, not just the first', () => {
    const d = doc();
    d.assets = [
      { id: 'x', path: 'assets/x.png', mime: 'image/png', bytes: 1 },
      { id: 'y', path: 'assets/y.pdf', mime: 'application/pdf', bytes: 1 },
    ];
    expect(() => assetMapFor(d)).toThrow(/assets\/x\.png, assets\/y\.pdf/);
  });

  it('is empty and happy for a document with no assets', () => {
    expect(assetMapFor(doc())).toEqual({});
  });
});

describe('adoptAssets', () => {
  it('joins container paths to document ids through the manifest', () => {
    const d = doc();
    d.assets = [{ id: 'a1', path: 'assets/a1.png', mime: 'image/png', bytes: 5 }];
    adoptAssets(d, { 'assets/a1.png': BYTES });

    expect(getAsset('a1')?.bytes).toBe(BYTES);
    expect(missingAssets(d)).toEqual([]);
  });

  it('replaces rather than merges, so one document cannot leak into the next', () => {
    // Opening a second space used to leave the first one's background in the store,
    // and the next save wrote it into the wrong file.
    putAsset({ mime: 'image/png', bytes: BYTES, id: 'old' });

    const d = doc();
    d.assets = [{ id: 'new', path: 'assets/new.png', mime: 'image/png', bytes: 5 }];
    adoptAssets(d, { 'assets/new.png': BYTES });

    expect(hasAsset('old')).toBe(false);
    expect(assetIds()).toEqual(['new']);
  });

  it('reports a file the container did not carry instead of faking it', () => {
    const d = doc();
    d.assets = [{ id: 'a1', path: 'assets/a1.png', mime: 'image/png', bytes: 5 }];
    adoptAssets(d, {});

    expect(missingAssets(d).map((a) => a.id)).toEqual(['a1']);
    expect(() => assetMapFor(d)).toThrow();
  });
});

describe('assetUrl', () => {
  it('mints a URL from the bytes the store holds now', () => {
    putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' });
    expect(assetUrl('a1')).toMatch(/^blob:/);
  });

  it('is stable for the same asset, so the image element is not rebuilt per render', () => {
    putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' });
    expect(assetUrl('a1')).toBe(assetUrl('a1'));
  });

  it('returns null for an id it does not hold', () => {
    expect(assetUrl('nope')).toBeNull();
  });

  it('issues a fresh URL after the bytes are replaced', () => {
    // The old URL points at the old blob. Handing it back after a reimport renders
    // the previous plan, which looks exactly like the import having failed.
    putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' });
    const first = assetUrl('a1');
    putAsset({ mime: 'image/png', bytes: new Uint8Array([9, 9]), id: 'a1' });

    expect(assetUrl('a1')).not.toBe(first);
  });
});

describe('clearAssets', () => {
  it('empties the store', () => {
    putAsset({ mime: 'image/png', bytes: BYTES, id: 'a1' });
    clearAssets();
    expect(assetIds()).toEqual([]);
  });
});
