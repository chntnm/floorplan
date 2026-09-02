import { describe, expect, it } from 'vitest';
import { createFloor, type Background } from './document';
import {
  CalibrationError,
  DEFAULT_BACKGROUND_OPACITY,
  NOMINAL_PLAN_WIDTH_MM,
  applyCalibration,
  backgroundCentre,
  backgroundExtentMm,
  clampOpacity,
  createBackground,
  docToImage,
  effectiveMmPerPx,
  floorAcceptsPlacements,
  imageToDoc,
  isCalibrated,
  mmPerPxFrom,
  placementBlockReason,
  provisionalMmPerPx,
  rotateBackground,
} from './calibration';

function bg(over: Partial<Background> = {}): Background {
  return {
    ...createBackground({ assetId: 'a1', pixelSize: { width: 1200, height: 900 } }),
    ...over,
  };
}

describe('provisionalMmPerPx', () => {
  it('shows any raster at the nominal plan width', () => {
    expect(provisionalMmPerPx(1200)).toBe(NOMINAL_PLAN_WIDTH_MM / 1200);
    expect(1200 * provisionalMmPerPx(1200)).toBe(NOMINAL_PLAN_WIDTH_MM);
  });

  it('refuses a non-positive width rather than returning Infinity', () => {
    // Infinity here would propagate silently into every coordinate on the plan.
    expect(() => provisionalMmPerPx(0)).toThrow(RangeError);
    expect(() => provisionalMmPerPx(-10)).toThrow(RangeError);
    expect(() => provisionalMmPerPx(Number.NaN)).toThrow(RangeError);
  });
});

describe('createBackground', () => {
  it('starts uncalibrated, locked, and translucent', () => {
    const background = createBackground({ assetId: 'a1', pixelSize: { width: 800, height: 600 } });
    expect(isCalibrated(background)).toBe(false);
    expect(background.locked).toBe(true);
    expect(background.opacity).toBe(DEFAULT_BACKGROUND_OPACITY);
    expect(background.transform).toEqual({ position: { x: 0, y: 0 }, rotationDeg: 0 });
  });

  it('rejects an empty raster', () => {
    expect(() => createBackground({ assetId: 'a', pixelSize: { width: 0, height: 10 } })).toThrow(
      RangeError,
    );
  });
});

describe('the image-to-document map', () => {
  it('exists before calibration, at the provisional scale', () => {
    const b = bg();
    expect(effectiveMmPerPx(b)).toBe(NOMINAL_PLAN_WIDTH_MM / 1200);
    // This is the whole point of a provisional scale: the reference line the user
    // draws has to be convertible *before* the real scale is known.
    expect(imageToDoc(b, { x: 1200, y: 0 })).toEqual({ x: NOMINAL_PLAN_WIDTH_MM, y: 0 });
  });

  it('puts the raster origin at the transform position', () => {
    const b = bg({ transform: { position: { x: 500, y: -250 }, rotationDeg: 0 } });
    expect(imageToDoc(b, { x: 0, y: 0 })).toEqual({ x: 500, y: -250 });
  });

  it('round-trips through the inverse, including a rotation', () => {
    const b = bg({ transform: { position: { x: 1234, y: -567 }, rotationDeg: 37 } });
    for (const p of [
      { x: 0, y: 0 },
      { x: 1200, y: 900 },
      { x: 431, y: 88 },
    ]) {
      const back = docToImage(b, imageToDoc(b, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('reports the extent the status bar shows', () => {
    expect(backgroundExtentMm(bg())).toEqual({
      width: NOMINAL_PLAN_WIDTH_MM,
      height: 900 * (NOMINAL_PLAN_WIDTH_MM / 1200),
    });
  });
});

describe('mmPerPxFrom', () => {
  it('divides the stated length by the pixels drawn', () => {
    expect(mmPerPxFrom({ x: 100, y: 100 }, { x: 500, y: 100 }, 3000)).toBe(7.5);
  });

  it('measures the line, not its x extent', () => {
    // 3-4-5: 300px across, 400px down, 500px of line.
    expect(mmPerPxFrom({ x: 0, y: 0 }, { x: 300, y: 400 }, 5000)).toBe(10);
  });

  it('refuses a line too short to have been drawn deliberately', () => {
    expect(() => mmPerPxFrom({ x: 0, y: 0 }, { x: 3, y: 0 }, 3000)).toThrow(CalibrationError);
    expect(() => mmPerPxFrom({ x: 0, y: 0 }, { x: 0, y: 0 }, 3000)).toThrow(CalibrationError);
  });

  it('refuses a real length that is not a length', () => {
    expect(() => mmPerPxFrom({ x: 0, y: 0 }, { x: 400, y: 0 }, 0)).toThrow(CalibrationError);
    expect(() => mmPerPxFrom({ x: 0, y: 0 }, { x: 400, y: 0 }, -3000)).toThrow(CalibrationError);
    expect(() => mmPerPxFrom({ x: 0, y: 0 }, { x: 400, y: 0 }, Number.NaN)).toThrow(
      CalibrationError,
    );
  });
});

describe('applyCalibration', () => {
  const refA = { x: 200, y: 300 };
  const refB = { x: 600, y: 300 };

  it('makes the reference line measure what the user said it was', () => {
    const next = applyCalibration(bg(), refA, refB, 3000);
    const a = imageToDoc(next, refA);
    const b = imageToDoc(next, refB);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(3000, 6);
  });

  it('anchors refA, so the point the user pointed at does not move', () => {
    const before = bg();
    const anchorBefore = imageToDoc(before, refA);
    const after = applyCalibration(before, refA, refB, 3000);
    const anchorAfter = imageToDoc(after, refA);

    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6);
  });

  it('anchors refA under a rotated background too', () => {
    const before = bg({ transform: { position: { x: 900, y: 120 }, rotationDeg: 22.5 } });
    const anchorBefore = imageToDoc(before, refA);
    const after = applyCalibration(before, refA, refB, 3000);

    expect(imageToDoc(after, refA).x).toBeCloseTo(anchorBefore.x, 6);
    expect(imageToDoc(after, refA).y).toBeCloseTo(anchorBefore.y, 6);
    expect(after.transform.rotationDeg).toBe(22.5);
  });

  it('does not drift when someone recalibrates repeatedly', () => {
    // People get the first attempt wrong; three corrections must not walk the plan
    // across the document. This is why `transform.position` is not rounded to mm.
    let b = bg();
    const anchor = imageToDoc(b, refA);
    for (const length of [3000, 2750, 3048]) b = applyCalibration(b, refA, refB, length);

    expect(imageToDoc(b, refA).x).toBeCloseTo(anchor.x, 6);
    expect(imageToDoc(b, refA).y).toBeCloseTo(anchor.y, 6);
    expect(b.calibration?.mmPerPx).toBeCloseTo(3048 / 400, 9);
  });

  it('records the reference so the gate can be reopened with it', () => {
    const next = applyCalibration(bg(), refA, refB, 3000);
    expect(next.calibration).toEqual({
      refA: { x: 200, y: 300 },
      refB: { x: 600, y: 300 },
      realLengthMm: 3000,
      mmPerPx: 7.5,
    });
  });

  it('throws before touching the background when the numbers are unusable', () => {
    const before = bg();
    expect(() => applyCalibration(before, refA, { x: 202, y: 300 }, 3000)).toThrow(
      CalibrationError,
    );
    expect(isCalibrated(before)).toBe(false);
  });
});

describe('rotateBackground', () => {
  it('holds the pivot still', () => {
    const b = bg();
    const pivot = backgroundCentre(b);
    const turned = rotateBackground(b, 3, pivot);
    const centreAfter = backgroundCentre(turned);

    expect(centreAfter.x).toBeCloseTo(pivot.x, 6);
    expect(centreAfter.y).toBeCloseTo(pivot.y, 6);
    expect(turned.transform.rotationDeg).toBe(3);
  });

  it('accumulates, so nudges add up', () => {
    let b = bg();
    for (let i = 0; i < 4; i++) b = rotateBackground(b, 0.5, backgroundCentre(b));
    expect(b.transform.rotationDeg).toBeCloseTo(2, 9);
  });
});

describe('clampOpacity', () => {
  it('keeps the slider inside the range and survives nonsense', () => {
    expect(clampOpacity(0.5)).toBe(0.5);
    expect(clampOpacity(-1)).toBe(0);
    expect(clampOpacity(4)).toBe(1);
    expect(clampOpacity(Number.NaN)).toBe(DEFAULT_BACKGROUND_OPACITY);
  });
});

describe('the placement gate', () => {
  it('lets a floor with no background through', () => {
    const floor = createFloor('f1', 'Ground', 0);
    expect(placementBlockReason(floor)).toBeNull();
    expect(floorAcceptsPlacements(floor)).toBe(true);
  });

  it('blocks an uncalibrated plan, and says why', () => {
    const floor = createFloor('f1', 'Ground', 0);
    floor.background = bg();
    const reason = placementBlockReason(floor);

    expect(reason).toBeTruthy();
    // A refusal with no explanation reads as a bug, so the reason is part of the
    // contract, not a nicety.
    expect(reason).toMatch(/calibrat/i);
    expect(floorAcceptsPlacements(floor)).toBe(false);
  });

  it('opens up the moment a scale exists', () => {
    const floor = createFloor('f1', 'Ground', 0);
    floor.background = applyCalibration(bg(), { x: 0, y: 0 }, { x: 400, y: 0 }, 3000);
    expect(placementBlockReason(floor)).toBeNull();
  });
});
