import { Fragment, useLayoutEffect, useRef, type RefObject } from 'react';
import { Circle, Layer, Line, Text } from 'react-konva';
import type Konva from 'konva';
import type { Floor, Opening, Wall } from '../../core/document';
import { centroid } from '../../core/geometry/polygon';
import { wallOutline } from '../../core/geometry/wall';
import { normalize, perp, sub, type Vec2 } from '../../core/geometry/vec';
import { leafOf, leafPanel, parkRun, swingSweep } from '../../core/swing';
import { formatArea, formatLength, type DisplayUnit } from '../../core/units';
import { docToScreen, flattenToScreen, type Viewport } from '../../core/viewport';
import type { SelectionRef, WallTransform } from '../../state/store';
import type { PlanTheme } from './theme';

type Props = {
  floor: Floor;
  viewport: Viewport;
  theme: PlanTheme;
  displayUnit: DisplayUnit;
  selection: SelectionRef[];
  /** False in furnish mode — the structure renders but does not accept clicks. */
  interactive: boolean;
  /** False while a draw tool is armed: the click belongs to the drawing, not here. */
  selectable: boolean;
  /** The drag in flight, previewed here while the document still holds the original. */
  transform: WallTransform | null;
  onSelect: (ref: SelectionRef, additive: boolean) => void;
  onGrabWall: (wallId: string) => void;
  onGrabEndpoint: (wallId: string, end: 'a' | 'b') => void;
};

/**
 * Rebuild the hit graph as soon as its inputs change, rather than on the next draw.
 *
 * Konva writes hit-test geometry into a separate canvas that is only refreshed when
 * the layer is drawn, so anything that changes what is hittable is invisible to a
 * click arriving in the same frame. Two triggers matter:
 *
 *   **`listening` flipped** — switch back to plan mode and immediately click a wall
 *   and nothing is selected, because the layer is still deaf.
 *
 *   **A shape appeared or vanished** — draw a wall, click it straight away, and the
 *   click is tested against a hit canvas that does not contain it yet.
 *
 * `useLayoutEffect` runs after React has committed and before the browser paints,
 * which is exactly the window this needs to close. `count` keeps the work
 * proportional to structural change rather than to every render.
 */
function useSyncHitGraph(
  ref: RefObject<Konva.Layer | null>,
  listening: boolean,
  count: number,
): void {
  useLayoutEffect(() => {
    ref.current?.drawHit();
  }, [ref, listening, count]);
}

function isSelected(selection: SelectionRef[], kind: SelectionRef['kind'], id: string): boolean {
  return selection.some((s) => s.kind === kind && s.id === id);
}

/** An opening as the slice of wall it removes, drawn in the background colour. */
function openingQuad(wall: Wall, opening: Opening): number[] | null {
  const dir = normalize(sub(wall.b, wall.a));
  if (dir.x === 0 && dir.y === 0) return null;

  const n = perp(dir);
  const half = wall.thicknessMm / 2 + 1; // +1 so it covers the wall's own stroke
  const start = opening.offsetMm;
  const end = opening.offsetMm + opening.widthMm;

  const at = (t: number, s: number) => ({
    x: wall.a.x + dir.x * t + n.x * half * s,
    y: wall.a.y + dir.y * t + n.y * half * s,
  });

  return [at(start, 1), at(end, 1), at(end, -1), at(start, -1)].flatMap((p) => [p.x, p.y]);
}

/**
 * The door symbol, in document space.
 *
 * A hinged door draws as the sector `swingSweep` already computes: its boundary *is*
 * the closed leaf, the arc, and the open leaf, which is exactly the symbol drawn on
 * a plan. Nothing traces the arc a second time, so the drawing and the clearance
 * check can never disagree about where the door goes.
 *
 * A slider draws the leaf where it parks, dashed, because that is the wall it needs
 * kept clear. A pocket door draws the same run on the wall centreline — the cavity
 * is inside the wall, and showing it is the only way the drawing says why the door
 * cannot go 200mm from the corner.
 */
function swingSymbol(
  wall: Wall,
  opening: Opening,
): { points: Vec2[]; closed: boolean; dashed: boolean } | null {
  const leaf = leafOf(opening);

  if (leaf.style === 'hinged') {
    const sweep = swingSweep(wall, opening);
    return sweep ? { points: sweep.pts, closed: true, dashed: false } : null;
  }
  if (leaf.style === 'sliding') {
    const panel = leafPanel(wall, opening);
    return panel ? { points: panel.pts, closed: true, dashed: true } : null;
  }
  if (leaf.style === 'pocket') {
    const dir = normalize(sub(wall.b, wall.a));
    if (dir.x === 0 && dir.y === 0) return null;
    const run = parkRun(opening, leaf.pivot);
    const at = (t: number) => ({ x: wall.a.x + dir.x * t, y: wall.a.y + dir.y * t });
    return { points: [at(run.from), at(run.to)], closed: false, dashed: true };
  }
  return null;
}

/**
 * Rooms, walls and openings.
 *
 * `listening` is driven by the edit mode, which is the layer toggle from the brief:
 * in furnish mode the structure is still drawn but is not hit-testable, so a click
 * that lands on a wall passes through to whatever is beneath it.
 *
 * **`listening` deliberately does not track the active tool.** Konva rebuilds a
 * layer's hit graph on the next draw, not on the assignment, so a layer switched on
 * and clicked within the same frame is still deaf — pick Select and click a wall
 * fast enough and nothing happens. Tool state is therefore checked inside the
 * handlers, where it takes effect immediately, and a non-selectable click returns
 * *without* cancelling the bubble so the stage still receives it and can draw.
 */
export function StructureLayer({
  floor,
  viewport,
  theme,
  displayUnit,
  selection,
  interactive,
  selectable,
  transform,
  onSelect,
  onGrabWall,
  onGrabEndpoint,
}: Props) {
  const layerRef = useRef<Konva.Layer>(null);
  useSyncHitGraph(
    layerRef,
    interactive,
    floor.walls.length + floor.rooms.length + floor.openings.length,
  );

  // A wall being dragged renders from the preview; the document still has the
  // original until the pointer is released.
  const walls = transform
    ? floor.walls.map((w) =>
        w.id === transform.wallId ? { ...w, a: transform.a, b: transform.b } : w,
      )
    : floor.walls;
  const wallsById = new Map(walls.map((w) => [w.id, w]));

  return (
    <Layer ref={layerRef} listening={interactive}>
      {floor.rooms.map((room) => {
        const c = docToScreen(viewport, centroid(room.boundary));
        const selected = isSelected(selection, 'room', room.id);
        return (
          <Fragment key={room.id}>
            <Line
              points={flattenToScreen(viewport, room.boundary.pts)}
              closed
              fill={theme.roomFill}
              stroke={selected ? theme.selection : theme.roomStroke}
              strokeWidth={selected ? 2 : 1}
              onMouseDown={(e) => {
                if (!selectable) return;
                e.cancelBubble = true;
                onSelect({ kind: 'room', id: room.id }, e.evt.shiftKey);
              }}
            />
            <Text
              x={c.x - 60}
              y={c.y - 14}
              width={120}
              align="center"
              text={`${room.name}\n${formatArea(room.areaMm2, displayUnit)}`}
              fontSize={11}
              lineHeight={1.4}
              fill={theme.roomLabel}
              listening={false}
            />
          </Fragment>
        );
      })}

      {walls.map((wall) => {
        let points: number[];
        try {
          points = flattenToScreen(viewport, wallOutline(wall).pts);
        } catch {
          // A degenerate wall cannot be outlined. Skip it rather than fail the render;
          // the validation panel is where it should be reported.
          return null;
        }
        const selected = isSelected(selection, 'wall', wall.id);
        return (
          <Line
            key={wall.id}
            points={points}
            closed
            fill={selected ? theme.selection : theme.wallFill}
            stroke={selected ? theme.selection : theme.wallStroke}
            strokeWidth={selected ? 2 : 0.75}
            onMouseDown={(e) => {
              if (!selectable) return;
              e.cancelBubble = true;
              onSelect({ kind: 'wall', id: wall.id }, e.evt.shiftKey);
              // Selecting and grabbing are the same gesture; a press that never moves
              // commits nothing, because the commit skips an unchanged wall.
              if (!e.evt.shiftKey) onGrabWall(wall.id);
            }}
          />
        );
      })}

      {floor.openings.map((opening) => {
        const wall = wallsById.get(opening.wallId);
        if (!wall) return null;
        const quad = openingQuad(wall, opening);
        if (!quad) return null;

        const screen: number[] = [];
        for (let i = 0; i < quad.length; i += 2) {
          const p = docToScreen(viewport, { x: quad[i]!, y: quad[i + 1]! });
          screen.push(p.x, p.y);
        }
        const selected = isSelected(selection, 'opening', opening.id);
        return (
          <Line
            key={opening.id}
            points={screen}
            closed
            fill={theme.openingFill}
            stroke={selected ? theme.selection : theme.wallStroke}
            strokeWidth={selected ? 2 : 0.75}
            onMouseDown={(e) => {
              // Above the wall it sits in, so clicking a doorway addresses the
              // doorway. Same rule as everywhere else in this layer: a
              // non-selectable click is not cancelled, so the armed tool still
              // sees it — which is what lets the opening tool drop a second door
              // on a wall that already has one.
              if (!selectable) return;
              e.cancelBubble = true;
              onSelect({ kind: 'opening', id: opening.id }, e.evt.shiftKey);
            }}
          />
        );
      })}

      {/* Door symbols, over the openings they belong to and under the handles. Not
          hit-testable: clicking a swing arc should select the door, and the doorway
          itself is the target for that — an arc that swallowed clicks would cover a
          square metre of floor nobody could then select furniture through. */}
      {floor.openings.map((opening) => {
        const wall = wallsById.get(opening.wallId);
        if (!wall) return null;
        const symbol = swingSymbol(wall, opening);
        if (!symbol) return null;

        return (
          <Line
            key={`${opening.id}-swing`}
            points={flattenToScreen(viewport, symbol.points)}
            closed={symbol.closed}
            listening={false}
            stroke={isSelected(selection, 'opening', opening.id) ? theme.selection : theme.swingStroke}
            strokeWidth={1}
            {...(symbol.closed && !symbol.dashed ? { fill: theme.swingFill } : {})}
            {...(symbol.dashed ? { dash: [6, 4] } : {})}
          />
        );
      })}

      {/* Endpoint handles. These grab — a handle that only looks draggable is worse
          than no handle at all. `hitStrokeWidth` gives them a forgiving target
          without drawing a larger dot. */}
      {walls
        .filter((w) => isSelected(selection, 'wall', w.id))
        .flatMap((wall) =>
          (['a', 'b'] as const).map((end) => {
            const p = docToScreen(viewport, wall[end]);
            return (
              <Circle
                key={`${wall.id}-${end}`}
                x={p.x}
                y={p.y}
                radius={4}
                fill={theme.selection}
                stroke="#fff"
                strokeWidth={1}
                hitStrokeWidth={12}
                onMouseDown={(e) => {
                  if (!selectable) return;
                  e.cancelBubble = true;
                  onGrabEndpoint(wall.id, end);
                }}
              />
            );
          }),
        )}

      {/* Length label on a single selected wall — the answer to "how long is that?" */}
      {selection.length === 1 && selection[0]!.kind === 'wall'
        ? (() => {
            const wall = wallsById.get(selection[0]!.id);
            if (!wall) return null;
            const mid = docToScreen(viewport, {
              x: (wall.a.x + wall.b.x) / 2,
              y: (wall.a.y + wall.b.y) / 2,
            });
            const len = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y);
            return (
              <Text
                x={mid.x - 60}
                y={mid.y - 20}
                width={120}
                align="center"
                text={formatLength(len, displayUnit)}
                fontSize={12}
                fontStyle="600"
                fill={theme.selection}
                listening={false}
              />
            );
          })()
        : null}
    </Layer>
  );
}
