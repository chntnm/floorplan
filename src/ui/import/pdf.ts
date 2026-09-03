/**
 * PDF → raster, via pdfjs. See PLAN.md §6.1.
 *
 * **PDF import is a background-image feature, not a geometry-extraction feature.**
 * Detecting walls in a raster is a computer-vision research problem, and pretending
 * otherwise sinks the schedule. What happens here is narrow and boring on purpose:
 * render a page to pixels at a resolution worth tracing over, and hand it on. Vector
 * path extraction through `getOperatorList` is v2 — the same foundation, an extra
 * input to the same tracing layer.
 *
 * DOM-dependent (canvas, worker). Never import this from `src/core/`.
 */

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { canvasToPng, type PixelSize } from './raster';

// Bundled and hashed by Vite, so this resolves in the production build too — which
// matters because the e2e suite runs against `vite build && vite preview`, not dev.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** PDF user space is 1/72 inch. 150dpi is legible line work without being enormous. */
export const DEFAULT_RENDER_DPI = 150;

/** Ceilings, so a poster-sized E1 sheet cannot allocate a gigabyte of canvas. */
const MAX_EDGE_PX = 6000;
const MAX_TOTAL_PX = 24_000_000;

export type PdfPageRender = {
  bytes: Uint8Array;
  mime: 'image/png';
  pixelSize: PixelSize;
};

/**
 * pdfjs takes ownership of the buffer it is handed and detaches it, which would
 * leave the caller holding an empty `Uint8Array` — and the caller needs those exact
 * bytes to store the original PDF as an asset. Always pass a copy.
 */
function loadingTask(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice() });
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  // `destroy` lives on the loading task, not the document proxy — tearing down the
  // task is what terminates the worker, and skipping it leaks one per import.
  const task = loadingTask(bytes);
  try {
    const doc = await task.promise;
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

/**
 * Render one page to PNG bytes.
 *
 * `pageIndex` is zero-based here and one-based in pdfjs; the conversion happens once,
 * in this function, and `Background.pageIndex` stores the zero-based value.
 */
export async function renderPdfPage(
  bytes: Uint8Array,
  pageIndex: number,
  dpi = DEFAULT_RENDER_DPI,
): Promise<PdfPageRender> {
  const task = loadingTask(bytes);
  try {
    const doc = await task.promise;
    if (pageIndex < 0 || pageIndex >= doc.numPages) {
      throw new Error(`That PDF has ${doc.numPages} page(s); page ${pageIndex + 1} is not one.`);
    }
    const page = await doc.getPage(pageIndex + 1);

    const base = page.getViewport({ scale: 1 });
    const wanted = dpi / 72;
    const scale = Math.min(
      wanted,
      MAX_EDGE_PX / Math.max(base.width, base.height),
      Math.sqrt(MAX_TOTAL_PX / (base.width * base.height)),
    );
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser did not provide a 2D canvas to render into.');

    // Paint white first. A PDF page is transparent where nothing is drawn, and a
    // transparent background over the dark theme renders black lines on black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, viewport }).promise;

    const pixelSize = { width: canvas.width, height: canvas.height };
    const png = await canvasToPng(canvas);

    // Release the backing store immediately; a 24MP canvas held by a closure is
    // 96MB the collector is in no hurry about. Read the size first — zeroing the
    // canvas is what frees it, and it also erases the dimensions.
    canvas.width = 0;
    canvas.height = 0;

    return { bytes: png, mime: 'image/png', pixelSize };
  } finally {
    await task.destroy();
  }
}
