import { Layer, Shape } from 'react-konva';
import type Konva from 'konva';
import { docToScreen, gridLines, gridStepMm, type Size, type Viewport } from '../../core/viewport';
import type { PlanTheme } from './theme';

type Props = {
  viewport: Viewport;
  size: Size;
  gridMm: number;
  theme: PlanTheme;
};

/** Below this on-screen spacing the grid reads as a grey wash, so it coarsens. */
const MIN_MINOR_PX = 10;
/** Emphasised lines want to be far enough apart to be countable. */
const MIN_MAJOR_PX = 64;

/**
 * The grid, drawn as a single Konva `Shape`.
 *
 * One node with a hand-rolled `sceneFunc` rather than a `Line` per gridline: at a
 * plan-sized extent that is the difference between one scene object and several
 * hundred, on every pan frame. The step also coarsens with zoom (see `gridStepMm`) so
 * the visible line count stays roughly constant rather than growing without bound as
 * you zoom out.
 */
export function GridLayer({ viewport, size, gridMm, theme }: Props) {
  const minor = gridStepMm(viewport, gridMm, MIN_MINOR_PX);
  const major = gridStepMm(viewport, gridMm, MIN_MAJOR_PX);

  // The shape paints itself entirely; there is no fill or stroke for Konva to apply
  // afterwards, so `fillStrokeShape` is deliberately not called.
  const draw = (ctx: Konva.Context) => {
    const raw = ctx as unknown as CanvasRenderingContext2D;
    const { xs, ys } = gridLines(viewport, size, minor);

    raw.save();
    raw.lineWidth = 1;

    // Minor lines first, then major over the top — cheaper than testing membership
    // per line, and the overdraw is one extra stroke of a much smaller set.
    raw.beginPath();
    for (const x of xs) {
      const px = Math.round(docToScreen(viewport, { x, y: 0 }).x) + 0.5;
      raw.moveTo(px, 0);
      raw.lineTo(px, size.height);
    }
    for (const y of ys) {
      const py = Math.round(docToScreen(viewport, { x: 0, y }).y) + 0.5;
      raw.moveTo(0, py);
      raw.lineTo(size.width, py);
    }
    raw.strokeStyle = theme.gridMinor;
    raw.stroke();

    if (major > minor) {
      const majorLines = gridLines(viewport, size, major);
      raw.beginPath();
      for (const x of majorLines.xs) {
        const px = Math.round(docToScreen(viewport, { x, y: 0 }).x) + 0.5;
        raw.moveTo(px, 0);
        raw.lineTo(px, size.height);
      }
      for (const y of majorLines.ys) {
        const py = Math.round(docToScreen(viewport, { x: 0, y }).y) + 0.5;
        raw.moveTo(0, py);
        raw.lineTo(size.width, py);
      }
      raw.strokeStyle = theme.gridMajor;
      raw.stroke();
    }

    // The document origin, so "where is 0,0" is always answerable.
    const origin = docToScreen(viewport, { x: 0, y: 0 });
    raw.beginPath();
    raw.moveTo(Math.round(origin.x) + 0.5, 0);
    raw.lineTo(Math.round(origin.x) + 0.5, size.height);
    raw.moveTo(0, Math.round(origin.y) + 0.5);
    raw.lineTo(size.width, Math.round(origin.y) + 0.5);
    raw.strokeStyle = theme.axis;
    raw.stroke();

    raw.restore();
  };

  return (
    <Layer listening={false}>
      <Shape sceneFunc={draw} perfectDrawEnabled={false} />
    </Layer>
  );
}
