/**
 * Background rasters and the calibration gate. See PLAN.md §6.1.
 *
 * A floor plan raster has no intrinsic real-world scale. Vector CAD exports use
 * arbitrary drawing units; a scan is just pixels. Until someone says "this line is
 * 3 metres", every dimension traced over it is wrong — and wrong in a way that
 * looks entirely plausible, which is worse than obviously broken. That is why
 * calibration is a gate and not a setting.
 *
 * Two spaces are in play:
 *
 *   **image px** — the raster's own pixels, origin top-left, y down. `refA`/`refB`
 *   live here, and so does everything the user points at on the background.
 *
 *   **document mm** — the canonical space (PLAN.md §3), also y-down.
 *
 * The map between them is `position + rotate(px * mmPerPx, rotationDeg)`. Both
 * spaces are y-down and share a handedness, so there is no flip: `rotationDeg` uses
 * the same sign convention as `Placement.rotation` and the same `rotate` helper.
 *
 * **Before calibration the map still exists**, at a provisional scale. It has to:
 * the user draws the reference line on the stage, and turning that drag into image
 * pixels requires the very transform calibration is about to produce. A provisional
 * scale breaks that circle — the drawn line converts through it, and calibration
 * then rescales about `refA` so the point the user anchored on stays exactly where
 * they put it.
 *
 * Pure — no DOM, no store, no pdfjs.
 */

import type { Background, Floor } from './document';
import { add, distance, rotate, scale, sub, toRadians, type Vec2 } from './geometry/vec';

/**
 * The apparent width an uncalibrated background is shown at.
 *
 * Any provisional scale keeps the transform invertible; this one is chosen so the
 * image lands at a size a reference line can actually be drawn across at the default
 * zoom. 6m is a plausible room, so an uncalibrated plan looks roughly like a plan
 * rather than a postage stamp or a wall of pixels.
 */
export const NOMINAL_PLAN_WIDTH_MM = 6000;

export const DEFAULT_BACKGROUND_OPACITY = 0.45;

/** Reference lines shorter than this cannot be drawn precisely enough to trust. */
export const MIN_REFERENCE_PX = 8;

/** Below a millimetre there is nothing to calibrate against. */
export const MIN_REAL_LENGTH_MM = 1;

export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationError';
  }
}

export type Calibration = NonNullable<Background['calibration']>;

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/** The scale an uncalibrated raster is displayed at, from its pixel width. */
export function provisionalMmPerPx(pixelWidth: number): number {
  if (!(pixelWidth > 0) || !Number.isFinite(pixelWidth)) {
    throw new RangeError(`calibration: pixel width must be positive, got ${pixelWidth}`);
  }
  return NOMINAL_PLAN_WIDTH_MM / pixelWidth;
}

export function isCalibrated(bg: Background | undefined): boolean {
  return bg?.calibration !== undefined;
}

/** Millimetres per image pixel — the real value once calibrated, provisional before. */
export function effectiveMmPerPx(bg: Background): number {
  return bg.calibration?.mmPerPx ?? provisionalMmPerPx(bg.pixelSize.width);
}

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

/** A point on the raster, in image pixels, expressed in document millimetres. */
export function imageToDoc(bg: Background, p: Vec2): Vec2 {
  const k = effectiveMmPerPx(bg);
  const rad = toRadians(bg.transform.rotationDeg);
  return add(bg.transform.position, rotate(scale(p, k), rad));
}

/** The inverse: a document point as a pixel on the raster. */
export function docToImage(bg: Background, p: Vec2): Vec2 {
  const k = effectiveMmPerPx(bg);
  const rad = toRadians(bg.transform.rotationDeg);
  return scale(rotate(sub(p, bg.transform.position), -rad), 1 / k);
}

/** The raster's size in document millimetres, at its current scale. */
export function backgroundExtentMm(bg: Background): { width: number; height: number } {
  const k = effectiveMmPerPx(bg);
  return { width: bg.pixelSize.width * k, height: bg.pixelSize.height * k };
}

/** The centre of the raster, in document millimetres. */
export function backgroundCentre(bg: Background): Vec2 {
  return imageToDoc(bg, { x: bg.pixelSize.width / 2, y: bg.pixelSize.height / 2 });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createBackground(params: {
  assetId: string;
  pixelSize: { width: number; height: number };
  sourceAssetId?: string;
  pageIndex?: number;
  /** Document position of the raster's top-left corner. Defaults to the origin. */
  position?: Vec2;
}): Background {
  if (!(params.pixelSize.width > 0) || !(params.pixelSize.height > 0)) {
    throw new RangeError('calibration: background pixel size must be positive');
  }
  return {
    assetId: params.assetId,
    ...(params.sourceAssetId ? { sourceAssetId: params.sourceAssetId } : {}),
    ...(params.pageIndex !== undefined ? { pageIndex: params.pageIndex } : {}),
    pixelSize: { ...params.pixelSize },
    transform: { position: params.position ?? { x: 0, y: 0 }, rotationDeg: 0 },
    opacity: DEFAULT_BACKGROUND_OPACITY,
    locked: true,
  };
}

// ---------------------------------------------------------------------------
// Calibrating
// ---------------------------------------------------------------------------

/**
 * Solve `mmPerPx` from a reference line and the real length it spans.
 *
 * Throws rather than returning a sentinel: every caller is a user action with a
 * message to show, and a silently bad scale is exactly the failure this module
 * exists to prevent.
 */
export function mmPerPxFrom(refA: Vec2, refB: Vec2, realLengthMm: number): number {
  const pixels = distance(refA, refB);
  if (!Number.isFinite(pixels) || pixels < MIN_REFERENCE_PX) {
    throw new CalibrationError(
      'That reference line is too short to measure. Draw it across the longest dimension you know.',
    );
  }
  if (!Number.isFinite(realLengthMm) || realLengthMm < MIN_REAL_LENGTH_MM) {
    throw new CalibrationError(
      'Enter the real length of the line you drew — for example 3m, 10 ft, 813mm.',
    );
  }
  return realLengthMm / pixels;
}

/**
 * Apply a calibration, rescaling about `refA`.
 *
 * The user drew the reference across a feature they recognise, so that feature is
 * the one thing that must not move when the scale changes. Anchoring `refA` is the
 * same instinct as `zoomAt` holding the point under the cursor — and it is what
 * makes recalibration usable, since people do get the first attempt wrong.
 *
 * `transform.position` stays a float. Rounding it onto the integer-millimetre grid
 * would move the anchor by up to half a millimetre *per recalibration*, so a plan
 * corrected three times would visibly drift; and unlike a wall, nobody measures the
 * corner of a raster.
 */
export function applyCalibration(
  bg: Background,
  refA: Vec2,
  refB: Vec2,
  realLengthMm: number,
): Background {
  const mmPerPx = mmPerPxFrom(refA, refB, realLengthMm);

  // Where the anchor sits today, under whatever scale is currently in force.
  const anchorDoc = imageToDoc(bg, refA);
  const rad = toRadians(bg.transform.rotationDeg);
  const position = sub(anchorDoc, rotate(scale(refA, mmPerPx), rad));

  return {
    ...bg,
    calibration: {
      refA: { ...refA },
      refB: { ...refB },
      realLengthMm,
      mmPerPx,
    },
    transform: { ...bg.transform, position },
  };
}

/**
 * Rotate the background about a document point, keeping that point fixed.
 *
 * Used to square a scan that went through the scanner crooked; callers pass the
 * raster centre so the plan does not swing off screen.
 */
export function rotateBackground(bg: Background, degrees: number, pivot: Vec2): Background {
  const rad = toRadians(degrees);
  const position = add(pivot, rotate(sub(bg.transform.position, pivot), rad));
  return {
    ...bg,
    transform: {
      position,
      rotationDeg: bg.transform.rotationDeg + degrees,
    },
  };
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BACKGROUND_OPACITY;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Why this floor cannot accept placements, or `null` when it can.
 *
 * A document with an uncalibrated background has no trustworthy scale, so anything
 * placed on it is placed at a size that means nothing. Returning the reason rather
 * than a bare boolean is deliberate: the UI has to be able to say *why*, and a
 * refusal without an explanation reads as a bug.
 */
export function placementBlockReason(floor: Floor): string | null {
  const bg = floor.background;
  if (!bg || isCalibrated(bg)) return null;
  return 'This floor plan has not been calibrated, so its scale is unknown. Calibrate it before placing anything.';
}

export function floorAcceptsPlacements(floor: Floor): boolean {
  return placementBlockReason(floor) === null;
}
