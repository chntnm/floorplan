/**
 * The import flow, end to end. See PLAN.md §6.1.
 *
 *   pick a file
 *     → sniff its real type from the magic bytes
 *     → [PDF] page picker, then render the chosen page to a raster
 *     → store the raster as an asset, and the original file alongside it
 *     → attach it to the active floor as an uncalibrated background
 *     → ▶ open the calibration gate ◀  (blocking)
 *
 * Split in two on purpose. `inspectFile` is cheap and answers the one question the
 * UI needs before it can ask anything ("how many pages?"); `attachPlan` does the
 * expensive render once a page is chosen. A single call would have to either render
 * every page up front or guess.
 *
 * The viewport is deliberately **not** re-fitted on import. An uncalibrated raster is
 * shown at a nominal 6m wide (`NOMINAL_PLAN_WIDTH_MM`), which is already a drawable
 * size at the default zoom, and leaving the transform alone keeps every screen-to-
 * document coordinate the user — and the e2e suite — has already learned.
 */

import { createBackground } from '../../core/calibration';
import type { AssetRef } from '../../core/document';
import {
  IMPORT_FORMATS_LABEL,
  isRaster,
  sniffMime,
  type ImportMime,
  type Inspection,
  type RasterMime,
} from '../../core/media';
import { putAsset } from '../../state/assets';
import { setBackground } from '../../state/actions';
import { useStore } from '../../state/store';
import { decodeImageSize } from './raster';

/**
 * pdfjs and its worker are ~450kB of the bundle, and most people draw their plan by
 * hand or import a photo. Loading it on demand keeps that off the first paint for
 * everyone who never opens a PDF; the chunk arrives while the file picker is still
 * closing, so nothing waits on it in practice.
 */
const pdfModule = () => import('./pdf');

export type { Inspection };

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * Identify a picked file.
 *
 * The type comes from the leading bytes, never from `File.type` — browsers hand out
 * `application/octet-stream` for perfectly good PDFs from some archives, and a JPEG
 * renamed `.png` arrives claiming to be a PNG. Either would reach the wrong decoder.
 */
export async function inspectFile(file: File): Promise<Inspection> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime: ImportMime | null = sniffMime(bytes);

  if (!mime) {
    throw new ImportError(
      `${file.name} is not a format this can read. Import a ${IMPORT_FORMATS_LABEL} file.`,
    );
  }

  if (isRaster(mime)) return { kind: 'image', fileName: file.name, mime, bytes };

  const pageCount = await (await pdfModule()).pdfPageCount(bytes);
  if (pageCount < 1) throw new ImportError(`${file.name} has no pages to import.`);
  return { kind: 'pdf', fileName: file.name, bytes, pageCount };
}

/**
 * Attach an inspected file to the active floor and open the calibration gate.
 *
 * A PDF stores two assets: the render that gets traced, and the original document.
 * Retaining the source is what makes re-rendering at a different resolution — or
 * extracting vector paths in v2 — possible on someone else's machine, and it costs
 * only the bytes they already gave us.
 */
export async function attachPlan(inspection: Inspection, pageIndex = 0): Promise<void> {
  const assets: AssetRef[] = [];
  let rasterBytes: Uint8Array;
  let rasterMime: RasterMime;
  let pixelSize: { width: number; height: number };
  let sourceRef: AssetRef | undefined;
  let page: number | undefined;

  if (inspection.kind === 'image') {
    rasterBytes = inspection.bytes;
    rasterMime = inspection.mime;
    pixelSize = await decodeImageSize(rasterBytes, rasterMime);
  } else {
    const render = await (await pdfModule()).renderPdfPage(inspection.bytes, pageIndex);
    rasterBytes = render.bytes;
    rasterMime = render.mime;
    pixelSize = render.pixelSize;
    page = pageIndex;
    sourceRef = putAsset({ mime: 'application/pdf', bytes: inspection.bytes });
    assets.push(sourceRef);
  }

  if (!(pixelSize.width > 0) || !(pixelSize.height > 0)) {
    throw new ImportError(`${inspection.fileName} decoded to an empty image.`);
  }

  const rasterRef = putAsset({ mime: rasterMime, bytes: rasterBytes });
  assets.push(rasterRef);

  const background = createBackground({
    assetId: rasterRef.id,
    pixelSize,
    ...(sourceRef ? { sourceAssetId: sourceRef.id } : {}),
    ...(page !== undefined ? { pageIndex: page } : {}),
  });

  setBackground(background, assets);
  useStore.getState().beginCalibration();
}

/**
 * The one import path, whether the file was picked or dropped on the window.
 *
 * A multi-page PDF stops here and parks in the store; the page picker renders from
 * that and calls `attachPlan` once a page is chosen. Everything else attaches
 * immediately — asking which page to use when there is exactly one is a dialog whose
 * only correct answer is the one already selected.
 *
 * Two entry points each calling `inspectFile` and then deciding for themselves is how
 * a dropped file quietly grows different behaviour from a picked one, and §6's "both
 * paths produce identical structures, one code path" is a claim about this function.
 */
export async function beginImport(file: File): Promise<void> {
  const inspection = await inspectFile(file);
  if (inspection.kind === 'pdf' && inspection.pageCount > 1) {
    useStore.getState().setPendingImport(inspection);
    return;
  }
  await attachPlan(inspection);
}
