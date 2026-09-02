import { Fragment, useLayoutEffect, useRef, type RefObject } from 'react';
import { Circle, Layer, Line, Text } from 'react-konva';
import type Konva from 'konva';
import type { Floor, Opening, Wall } from '../../core/document';
import { centroid } from '../../core/geometry/polygon';
import { wallOutline } from '../../core/geometry/wall';
import { normalize, perp, sub } from '../../core/geometry/vec';
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
 * Rebuild the hit graph as soon as `listening` changes, rather than on the next draw.
 *
 * Konva writes hit-test geometry into a separate canvas that is only refreshed when
 * the layer is drawn. Flip `listening` and click within the same frame and the click
 * is tested against the *previous* state — so switching back to plan mode and
 * immediately clicking a wall selects nothing. `useLayoutEffect` runs after React has
 * committed the prop and before the browser paints, which is exactly the window this
 * needs to close.
 */
function useSyncHitGraph(ref: RefObject<Konva.Layer | null>, listening: boolean): void {
  useLayoutEffect(() => {
    ref.current?.drawHit();
  }, [ref, listening]);
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
  useSyncHitGraph(layerRef, interactive);

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
        return (
          <Line
            key={opening.id}
            points={screen}
            closed
            fill={theme.openingFill}
            stroke={theme.wallStroke}
            strokeWidth={0.75}
            listening={false}
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
