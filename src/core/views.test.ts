import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA,
  createSavedView,
  decodeCamera,
  encodeCamera,
  spaceViews,
  uniqueViewName,
  type SpaceCamera,
} from './views';
import type { SavedView } from './document';

const CAMERA: SpaceCamera = {
  position: { x: 1200, y: 300, z: 1650 },
  target: { x: 2500, y: 2500, z: 1200 },
  mode: 'walk',
};

describe('camera encoding', () => {
  it('round-trips through the record the file format stores', () => {
    expect(decodeCamera(encodeCamera(CAMERA))).toEqual(CAMERA);
  });

  it('uses the key set the format fixture already contains', () => {
    // `space-file.test.ts` has a checked-in view using x/y/z/tx/ty/tz. Changing the
    // names here would silently stop reading files saved before the change.
    expect(Object.keys(encodeCamera(CAMERA)).sort()).toEqual(
      ['m', 'tx', 'ty', 'tz', 'x', 'y', 'z'].sort(),
    );
  });
});

describe('decoding a record this version did not write', () => {
  it('fills in every missing field rather than producing NaN', () => {
    // A NaN reaches a matrix and blanks the screen with no error anywhere.
    const camera = decodeCamera({});
    expect(camera).toEqual(DEFAULT_CAMERA);
  });

  it('rejects a non-finite value instead of passing it through', () => {
    const camera = decodeCamera({ x: NaN, y: Infinity, z: 900, tx: 0, ty: 0, tz: 0, m: 1 });
    expect(camera.position.x).toBe(DEFAULT_CAMERA.position.x);
    expect(camera.position.y).toBe(DEFAULT_CAMERA.position.y);
    expect(camera.position.z).toBe(900);
  });

  it('clamps a camera mode index it does not recognise', () => {
    expect(decodeCamera({ m: 99 }).mode).toBe('orbit');
    expect(decodeCamera({ m: -1 }).mode).toBe('orbit');
  });

  it('nudges a camera that is looking at itself', () => {
    // Position equal to target is a zero-length view direction and a degenerate
    // matrix — a black screen with nothing logged.
    const camera = decodeCamera({ x: 100, y: 200, z: 300, tx: 100, ty: 200, tz: 300 });
    expect(camera.target).not.toEqual(camera.position);
  });
});

describe('the saved view list', () => {
  const views: SavedView[] = [
    createSavedView('a', 'Doorway', CAMERA),
    { id: 'b', name: 'Plan bookmark', mode: 'plan2d', camera: {} },
  ];

  it('shows only space views', () => {
    expect(spaceViews(views).map((v) => v.id)).toEqual(['a']);
  });

  it('suffixes a duplicate name rather than refusing to save', () => {
    // The point of the button is that pressing it saves where you are standing.
    expect(uniqueViewName('Doorway', views)).toBe('Doorway 2');
    expect(uniqueViewName('Kitchen', views)).toBe('Kitchen');
  });

  it('keeps suffixing past the first collision', () => {
    const many = [...views, createSavedView('c', 'Doorway 2', CAMERA)];
    expect(uniqueViewName('Doorway', many)).toBe('Doorway 3');
  });
});
