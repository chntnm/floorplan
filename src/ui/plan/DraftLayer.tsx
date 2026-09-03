import { Circle, Layer, Line, Text } from 'react-konva';
import { distance, type Vec2 } from '../../core/geometry/vec';
import { shapeBoundary, type Draft } from '../../core/tools';
import { formatLength, type DisplayUnit } from '../../core/units';
import { docToScreen, flattenToScreen, type Viewport } from '../../core/viewport';
import type { SnapHint } from '../../core/snapping';
import type { CalibrationRef, Measurement } from '../../state/store';
import { isTooNarrow, type WalkwayProbe } from '../../core/walkway';
import type { PlanTheme } from './theme';

type Props = {
  draft: Draft | null;
  measurement: Measurement | null;
  /** The committed walkway route, and the narrowest gap found along it. */
  walkway: readonly Vec2[] | null;
  probe: WalkwayProbe | null;
  /** The calibration reference line, drawn while the gate is open. */
  calibrationRef: CalibrationRef | null;
  snapHints: SnapHint[];
  cursor: Vec2 | null;
  viewport: Viewport;
  theme: PlanTheme;
  displayUnit: DisplayUnit;
};

function rectPoints(a: Vec2, b: Vec2): Vec2[] {
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
}

/** A length label placed just off the midpoint of a segment. */
function SegmentLabel({
  from,
  to,
  viewport,
  displayUnit,
  color,
}: {
  from: Vec2;
  to: Vec2;
  viewport: Viewport;
  displayUnit: DisplayUnit;
  color: string;
}) {
  const len = distance(from, to);
  if (len < 1) return null;

  const mid = docToScreen(viewport, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  return (
    <Text
      x={mid.x - 60}
      y={mid.y - 20}
      width={120}
      align="center"
      text={formatLength(len, displayUnit)}
      fontSize={12}
      fontStyle="600"
      fill={color}
      listening={false}
    />
  );
}

/**
 * Everything in flight: the gesture being drawn, its live dimensions, and the snap
 * guides explaining where the cursor actually landed.
 *
 * Nothing here is in the document. The layer never listens — a rubber band you can
 * click is a rubber band that eats the click that was meant to finish it.
 */
export function DraftLayer({
  draft,
  measurement,
  walkway,
  probe,
  calibrationRef,
  snapHints,
  cursor,
  viewport,
  theme,
  displayUnit,
}: Props) {
  return (
    <Layer listening={false}>
      {draft?.tool === 'wall' ? (
        <>
          <Line
            points={flattenToScreen(
              viewport,
              cursor ? [...draft.points, cursor] : draft.points,
            )}
            stroke={theme.draft}
            strokeWidth={2}
            dash={[6, 4]}
          />
          {draft.points.map((p, i) => {
            const s = docToScreen(viewport, p);
            return (
              <Circle key={i} x={s.x} y={s.y} radius={3.5} fill={theme.draft} />
            );
          })}
          {cursor && draft.points.length > 0 ? (
            <SegmentLabel
              from={draft.points[draft.points.length - 1]!}
              to={cursor}
              viewport={viewport}
              displayUnit={displayUnit}
              color={theme.draft}
            />
          ) : null}
        </>
      ) : null}

      {draft?.tool === 'room' ? (
        <>
          <Line
            points={flattenToScreen(viewport, rectPoints(draft.start, draft.cursor))}
            closed
            fill={theme.roomFill}
            stroke={theme.draft}
            strokeWidth={2}
            dash={[6, 4]}
          />
          <SegmentLabel
            from={draft.start}
            to={{ x: draft.cursor.x, y: draft.start.y }}
            viewport={viewport}
            displayUnit={displayUnit}
            color={theme.draft}
          />
          <SegmentLabel
            from={{ x: draft.cursor.x, y: draft.start.y }}
            to={draft.cursor}
            viewport={viewport}
            displayUnit={displayUnit}
            color={theme.draft}
          />
        </>
      ) : null}

      {draft?.tool === 'shape' ? (
        <Line
          points={flattenToScreen(
            viewport,
            shapeBoundary(draft.kind, draft.start, draft.cursor).pts,
          )}
          closed
          fill={theme.roomFill}
          stroke={theme.draft}
          strokeWidth={2}
          dash={[6, 4]}
        />
      ) : null}

      {draft?.tool === 'dimension' ? (
        <>
          <Line
            points={flattenToScreen(viewport, [draft.start, draft.cursor])}
            stroke={theme.dimension}
            strokeWidth={2}
          />
          <SegmentLabel
            from={draft.start}
            to={draft.cursor}
            viewport={viewport}
            displayUnit={displayUnit}
            color={theme.dimensionText}
          />
        </>
      ) : null}

      {/* The walkway gesture in flight — the same dashes as a wall chain, in the
          measurement colour, because it measures rather than builds. */}
      {draft?.tool === 'walkway' ? (
        <>
          <Line
            points={flattenToScreen(
              viewport,
              draft.cursor ? [...draft.points, draft.cursor] : draft.points,
            )}
            stroke={theme.dimension}
            strokeWidth={2}
            dash={[8, 5]}
          />
          {draft.points.map((p, i) => {
            const s = docToScreen(viewport, p);
            return <Circle key={i} x={s.x} y={s.y} radius={3.5} fill={theme.dimension} />;
          })}
        </>
      ) : null}

      {/* The committed route, and a tick across it at the narrowest point. The tick
          is the answer: a number in a panel says 610mm, and this says *where*. */}
      {walkway && walkway.length > 1 && draft?.tool !== 'walkway' ? (
        <>
          <Line
            points={flattenToScreen(viewport, walkway)}
            stroke={theme.dimension}
            strokeWidth={1.5}
            dash={[8, 5]}
          />
          {probe ? (
            <>
              <Line
                points={flattenToScreen(viewport, [probe.left, probe.right])}
                stroke={isTooNarrow(probe) ? theme.warning : theme.dimension}
                strokeWidth={2.5}
              />
              <SegmentLabel
                from={probe.left}
                to={probe.right}
                viewport={viewport}
                displayUnit={displayUnit}
                color={isTooNarrow(probe) ? theme.warning : theme.dimensionText}
              />
            </>
          ) : null}
        </>
      ) : null}

      {measurement && !draft ? (
        <>
          <Line
            points={flattenToScreen(viewport, [measurement.from, measurement.to])}
            stroke={theme.dimension}
            strokeWidth={2}
          />
          <SegmentLabel
            from={measurement.from}
            to={measurement.to}
            viewport={viewport}
            displayUnit={displayUnit}
            color={theme.dimensionText}
          />
        </>
      ) : null}

      {/* The calibration reference. Labelled with what it measures *today*, under the
          provisional scale — which is exactly the number the gate is about to
          replace, and seeing it change is how the correction reads as having
          worked. End caps because the endpoints are what get anchored. */}
      {calibrationRef ? (
        <>
          <Line
            points={flattenToScreen(viewport, [calibrationRef.a, calibrationRef.b])}
            stroke={theme.snap}
            strokeWidth={2.5}
          />
          {[calibrationRef.a, calibrationRef.b].map((p, i) => {
            const s = docToScreen(viewport, p);
            return <Circle key={i} x={s.x} y={s.y} radius={4} fill={theme.snap} />;
          })}
          <SegmentLabel
            from={calibrationRef.a}
            to={calibrationRef.b}
            viewport={viewport}
            displayUnit={displayUnit}
            color={theme.snap}
          />
        </>
      ) : null}

      {snapHints.map((hint, i) => {
        if (hint.kind === 'point') {
          const s = docToScreen(viewport, hint.at);
          return (
            <Line
              key={i}
              points={[s.x - 6, s.y - 6, s.x + 6, s.y + 6, s.x, s.y, s.x - 6, s.y + 6, s.x + 6, s.y - 6]}
              stroke={theme.snap}
              strokeWidth={1.5}
            />
          );
        }
        if (hint.kind === 'angle' && cursor) {
          return (
            <Line
              key={i}
              points={flattenToScreen(viewport, [hint.from, cursor])}
              stroke={theme.snap}
              strokeWidth={1}
              dash={[3, 3]}
              opacity={0.7}
            />
          );
        }
        return null;
      })}
    </Layer>
  );
}
