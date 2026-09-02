import { beforeEach, describe, expect, it } from 'vitest';
import { activeFloor, useStore } from './store';
import {
  commitCalibration,
  nudgeBackgroundRotation,
  removeBackground,
  setBackground,
  setBackgroundLocked,
  setBackgroundOpacity,
} from './actions';
import { assetIds, clearAssets, putAsset } from './assets';
import {
  CalibrationError,
  createBackground,
  effectiveMmPerPx,
  imageToDoc,
  isCalibrated,
} from '../core/calibration';
import type { AssetRef } from '../core/document';

function floor() {
  return activeFloor(useStore.getState());
}

const RASTER = new Uint8Array([1, 2, 3]);

/** Import a plan the way `attachPlan` does, minus the DOM decoding. */
function importPlan(id = 'raster', withSource = false): AssetRef {
  const assets: AssetRef[] = [];
  let sourceId: string | undefined;
  if (withSource) {
    const src = putAsset({ mime: 'application/pdf', bytes: RASTER, id: `${id}-src` });
    assets.push(src);
    sourceId = src.id;
  }
  const ref = putAsset({ mime: 'image/png', bytes: RASTER, id });
  assets.push(ref);

  setBackground(
    createBackground({
      assetId: ref.id,
      pixelSize: { width: 1200, height: 900 },
      ...(sourceId ? { sourceAssetId: sourceId } : {}),
    }),
    assets,
  );
  return ref;
}

beforeEach(() => {
  useStore.getState().newDocument();
  clearAssets();
});

describe('setBackground', () => {
  it('lands the manifest and the background in one undo step', () => {
    importPlan();
    const state = useStore.getState();

    expect(state.past).toHaveLength(1);
    expect(state.doc.assets.map((a) => a.id)).toEqual(['raster']);
    expect(floor().background?.assetId).toBe('raster');
  });

  it('never leaves a document referencing an asset it has not declared', () => {
    // One mutation, so there is no intermediate state where the background points
    // at a manifest entry that does not exist yet.
    importPlan();
    const bg = floor().background!;
    expect(useStore.getState().doc.assets.some((a) => a.id === bg.assetId)).toBe(true);
  });

  it('carries the original PDF alongside the render', () => {
    importPlan('r2', true);
    expect(useStore.getState().doc.assets.map((a) => a.id).sort()).toEqual(['r2', 'r2-src']);
    expect(floor().background?.sourceAssetId).toBe('r2-src');
  });

  it('retires the previous plans manifest entries when replaced', () => {
    importPlan('first');
    importPlan('second');

    expect(useStore.getState().doc.assets.map((a) => a.id)).toEqual(['second']);
    // The bytes stay: undo has to be able to bring the first plan back, and there
    // is nowhere else they could come from.
    expect(assetIds().sort()).toEqual(['first', 'second']);
  });

  it('is undoable back to no plan at all', () => {
    importPlan();
    useStore.getState().undo();

    expect(floor().background).toBeUndefined();
    expect(useStore.getState().doc.assets).toEqual([]);
  });
});

describe('removeBackground', () => {
  it('drops the background and its manifest entries together', () => {
    importPlan('r3', true);
    removeBackground();

    expect(floor().background).toBeUndefined();
    expect(useStore.getState().doc.assets).toEqual([]);
  });

  it('does nothing, and records nothing, when there is no plan', () => {
    removeBackground();
    expect(useStore.getState().past).toHaveLength(0);
  });

  it('restores on undo, bytes included', () => {
    importPlan();
    removeBackground();
    useStore.getState().undo();

    expect(floor().background?.assetId).toBe('raster');
    expect(assetIds()).toContain('raster');
  });
});

describe('commitCalibration', () => {
  it('takes the reference in document mm and makes it measure what was typed', () => {
    importPlan();
    const before = floor().background!;

    // Two points 2000mm apart under the provisional scale, declared to be 4000mm.
    const a = imageToDoc(before, { x: 200, y: 400 });
    const b = imageToDoc(before, { x: 600, y: 400 });
    commitCalibration(a, b, 4000);

    const after = floor().background!;
    expect(isCalibrated(after)).toBe(true);
    const measured = Math.hypot(
      imageToDoc(after, { x: 600, y: 400 }).x - imageToDoc(after, { x: 200, y: 400 }).x,
      imageToDoc(after, { x: 600, y: 400 }).y - imageToDoc(after, { x: 200, y: 400 }).y,
    );
    expect(measured).toBeCloseTo(4000, 6);
    expect(effectiveMmPerPx(after)).toBeCloseTo(10, 9);
  });

  it('is one undo step, and undoes back to uncalibrated', () => {
    importPlan();
    const bg = floor().background!;
    commitCalibration(imageToDoc(bg, { x: 0, y: 0 }), imageToDoc(bg, { x: 400, y: 0 }), 3000);

    expect(useStore.getState().past).toHaveLength(2);
    useStore.getState().undo();
    expect(isCalibrated(floor().background)).toBe(false);
  });

  it('leaves the document untouched when the line is too short to measure', () => {
    importPlan();
    const bg = floor().background!;
    const a = imageToDoc(bg, { x: 100, y: 100 });
    const b = imageToDoc(bg, { x: 102, y: 100 });

    expect(() => commitCalibration(a, b, 3000)).toThrow(CalibrationError);
    expect(useStore.getState().past).toHaveLength(1);
    expect(isCalibrated(floor().background)).toBe(false);
  });

  it('does nothing when there is no plan to calibrate', () => {
    commitCalibration({ x: 0, y: 0 }, { x: 1000, y: 0 }, 3000);
    expect(useStore.getState().past).toHaveLength(0);
  });
});

describe('background properties', () => {
  it('clamps opacity into range', () => {
    importPlan();
    setBackgroundOpacity(2);
    expect(floor().background?.opacity).toBe(1);
    setBackgroundOpacity(-1);
    expect(floor().background?.opacity).toBe(0);
  });

  it('records nothing when a property is set to what it already is', () => {
    // immer patches an assignment even when the value is deep-equal, so the no-op
    // guard in `mutate` is what keeps this off the undo stack.
    importPlan();
    const before = useStore.getState().past.length;
    setBackgroundLocked(true);
    expect(useStore.getState().past).toHaveLength(before);
  });

  it('accumulates rotation nudges', () => {
    importPlan();
    nudgeBackgroundRotation(0.5);
    nudgeBackgroundRotation(0.5);
    expect(floor().background?.transform.rotationDeg).toBeCloseTo(1, 9);
  });
});

describe('the calibration gate in editor state', () => {
  it('records nothing — an abandoned calibration leaves no history', () => {
    importPlan();
    const before = useStore.getState().past.length;

    useStore.getState().beginCalibration();
    for (let i = 0; i < 50; i++) {
      useStore.getState().setCalibrationRef({ a: { x: 0, y: 0 }, b: { x: i, y: i } });
    }
    useStore.getState().endCalibration();

    expect(useStore.getState().past).toHaveLength(before);
    expect(useStore.getState().calibrationRef).toBeNull();
  });

  it('cancels whatever gesture was in flight when it opens', () => {
    importPlan();
    const store = useStore.getState();
    store.setDraft({ tool: 'wall', points: [{ x: 0, y: 0 }], cursor: { x: 0, y: 0 } });
    store.beginCalibration();

    expect(useStore.getState().draft).toBeNull();
    expect(useStore.getState().calibrating).toBe(true);
  });

  it('closes when the document is replaced', () => {
    importPlan();
    useStore.getState().beginCalibration();
    useStore.getState().newDocument();

    expect(useStore.getState().calibrating).toBe(false);
    // The asset store is the other half of the document; a leftover plan here would
    // be written into the next document's file.
    expect(assetIds()).toEqual([]);
  });
});
