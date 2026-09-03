/**
 * Raster decoding helpers.
 *
 * DOM-dependent by nature — `createImageBitmap`, `<canvas>`, `toBlob`. Nothing in
 * `src/core/` may import this file: the unit suite runs in a node environment, and
 * one core module reaching for a canvas takes the whole suite down with it.
 */

export type PixelSize = { width: number; height: number };

/**
 * The intrinsic pixel size of an encoded image.
 *
 * `createImageBitmap` is the direct route and is what Chrome and Firefox use; the
 * `<img>` fallback covers the rest. Both go through a blob URL that is revoked
 * either way, including on the error path — a leaked object URL pins the whole
 * decoded image in memory for the life of the tab.
 */
export async function decodeImageSize(bytes: Uint8Array, mime: string): Promise<PixelSize> {
  const blob = new Blob([bytes.slice()], { type: mime });

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<PixelSize>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('That image could not be decoded.'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Encode a canvas as PNG bytes. PNG because a traced plan must stay crisp. */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The page could not be encoded as an image.');
  return new Uint8Array(await blob.arrayBuffer());
}
