/**
 * Media type detection for imported files. See PLAN.md §6.1.
 *
 * The browser gives a `File.type`, and it lies often enough to matter: a `.pdf`
 * dragged from some archives arrives as `application/octet-stream`, and a file
 * renamed `plan.png` that is really a JPEG arrives as `image/png`. Both would then
 * be handed to the wrong decoder. Magic bytes are the only thing that actually
 * knows, so nothing downstream reads `File.type`.
 *
 * Pure — no DOM. `src/ui/import/` does the decoding; this decides what to decode.
 */

export const IMPORT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
export type ImportMime = (typeof IMPORT_MIMES)[number];

/** What a background raster is stored as. PDFs are rendered to one of these. */
export type RasterMime = Exclude<ImportMime, 'application/pdf'>;

const EXTENSIONS: Record<ImportMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * The real type of a file, from its leading bytes. `null` for anything this
 * application cannot import — the caller turns that into a message naming the
 * formats that do work, rather than failing later inside a decoder.
 */
export function sniffMime(bytes: Uint8Array): ImportMime | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  // A PDF is allowed to carry junk before the header, but only a little — the spec
  // says a reader may accept the marker within the first 1024 bytes.
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  return null;
}

export function isRaster(mime: ImportMime): mime is RasterMime {
  return mime !== 'application/pdf';
}

export function extensionFor(mime: ImportMime): string {
  return EXTENSIONS[mime];
}

/** Where an asset lives inside the `.space` container. */
export function assetPath(id: string, mime: ImportMime): string {
  return `assets/${id}.${extensionFor(mime)}`;
}

/** The list shown in an error message and in the file picker's `accept`. */
export const IMPORT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp';
export const IMPORT_FORMATS_LABEL = 'PDF, PNG, JPEG or WebP';
