/**
 * Fixtures generated at test time rather than checked in as binaries.
 *
 * A committed PNG is a file nobody can read in a diff and nobody remembers the
 * dimensions of — and the dimensions are exactly what these tests assert against.
 * Building them here keeps the numbers in the spec that depends on them.
 */

import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A real, decodable PNG of exactly `width` × `height`.
 *
 * White with a black border and a diagonal, so a human looking at a failed test
 * screenshot can see the plan is actually there and which way up it is.
 */
export function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff);
  const rowStride = 1 + width * 3;

  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = y * rowStride + 1 + x * 3;
    raw[at] = 0;
    raw[at + 1] = 0;
    raw[at + 2] = 0;
  };

  for (let y = 0; y < height; y++) {
    raw[y * rowStride] = 0; // filter: none
    set(0, y);
    set(width - 1, y);
  }
  for (let x = 0; x < width; x++) {
    set(x, 0);
    set(x, height - 1);
    set(x, Math.floor((x * height) / width));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10..12: compression, filter, interlace — all zero.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * A minimal multi-page PDF with a real cross-reference table.
 *
 * Hand-assembled because the alternative — committing a binary — hides the one
 * property the page-picker test cares about, which is how many pages it has. Each
 * page draws a diagonal so a render that produced a blank raster is distinguishable
 * from one that worked.
 */
export function makePdf(pageCount: number, width = 400, height = 300): Buffer {
  const objects: string[] = [];
  const push = (body: string) => objects.push(body) && objects.length;

  const catalogId = 1;
  const pagesId = 2;
  objects.push(''); // 1: catalog, filled in below
  objects.push(''); // 2: pages

  const pageIds: number[] = [];
  for (let i = 0; i < pageCount; i++) {
    const content = `1 w 0 0 0 RG 10 10 m ${width - 10} ${height - 10} l S BT /F1 24 Tf 40 ${
      height / 2
    } Td (Page ${i + 1}) Tj ET`;
    const streamId = push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ` +
        `/Contents ${streamId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
