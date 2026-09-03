/**
 * Turning `core/thumbnail`'s numbers into a PNG.
 *
 * The thin half of the split: every decision about what is drawn and where it lands is
 * in the core module and tested there. What is left here is `ctx.fill()`, a canvas and
 * an encoder — the parts a unit test could only assert by re-implementing them.
 *
 * ## Fixed colours, not the plan theme
 *
 * The thumbnail is read by someone else's file browser, on a machine whose dark-mode
 * setting has nothing to do with yours. A plan that renders as light-on-dark because
 * of how the *author's* laptop was configured is a worse picture, not a personalised
 * one.
 *
 * ## A thumbnail never blocks a save
 *
 * Every failure path returns `undefined` and the container is written without the
 * entry, which `writeSpace` already treats as optional. Losing a preview is a
 * cosmetic loss; losing the save because the preview failed is not a trade worth
 * making, and there is no environment where the fix is "give up on the document".
 */

import { findFloor, type SpaceDocument } from '../core/document';
import {
  THUMBNAIL_PX,
  thumbnailBounds,
  thumbnailFit,
  thumbnailShapes,
} from '../core/thumbnail';
import type { Vec2 } from '../core/geometry/vec';

const PAPER = '#f6f5f2';
const ROOM = '#e4e6ea';
const WALL = '#3a3f4b';
const PLACEMENT = '#7c8aa5';

function path(ctx: CanvasRenderingContext2D, ring: readonly Vec2[]): void {
  const first = ring[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i];
    if (p) ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

/**
 * A 512px PNG of the active floor, or `undefined` when there is nothing to draw or
 * no canvas to draw it on.
 */
export async function renderThumbnail(doc: SpaceDocument): Promise<Uint8Array | undefined> {
  try {
    if (typeof document === 'undefined') return undefined;

    const floor = findFloor(doc, doc.activeFloorId) ?? doc.floors[0];
    if (!floor) return undefined;

    const box = thumbnailBounds(doc, floor);
    if (!box) return undefined;

    const fit = thumbnailFit(box, THUMBNAIL_PX);
    const shapes = thumbnailShapes(doc, floor, fit);

    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_PX;
    canvas.height = THUMBNAIL_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, THUMBNAIL_PX, THUMBNAIL_PX);

    // Painting order is the plan view's: rooms are the ground, furniture sits on it,
    // walls are on top of both so a wall is never hidden by what stands against it.
    ctx.fillStyle = ROOM;
    for (const ring of shapes.rooms) {
      path(ctx, ring);
      ctx.fill();
    }

    ctx.fillStyle = PLACEMENT;
    for (const ring of shapes.placements) {
      path(ctx, ring);
      ctx.fill();
    }

    ctx.fillStyle = WALL;
    for (const ring of shapes.walls) {
      path(ctx, ring);
      ctx.fill();
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
    if (!blob) return undefined;

    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return undefined;
  }
}
