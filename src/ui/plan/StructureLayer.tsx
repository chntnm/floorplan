import { Fragment } from 'react';
import { Circle, Layer, Line, Text } from 'react-konva';
import type { Floor, Opening, Wall } from '../../core/document';
import { centroid } from '../../core/geometry/polygon';
import { wallOutline } from '../../core/geometry/wall';
import { normalize, perp, sub } from '../../core/geometry/vec';
import { formatArea, formatLength, type DisplayUnit } from '../../core/units';
import { docToScreen, flattenToScreen, type Viewport } from '../../core/viewport';
import type { SelectionRef } from '../../state/store';
import type { PlanTheme } from './theme';

type Props = {
  floor: Floor;
  viewport: Viewport;
  theme: PlanTheme;
  displayUnit: DisplayUnit;
  selection: SelectionRef[];
  /** False in furnish mode — the structure renders but does not accept clicks. */
  interactive: boolean;
  onSelect: (ref: SelectionRef, additive: boolean) => void;
};

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
 */
export function StructureLayer({
  floor,
  viewport,
  theme,
  displayUnit,
  selection,
  interactive,
  onSelect,
}: Props) {
  const wallsById = new Map(floor.walls.map((w) => [w.id, w]));

  return (
    <Layer listening={interactive}>
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

      {floor.walls.map((wall) => {
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
              e.cancelBubble = true;
              onSelect({ kind: 'wall', id: wall.id }, e.evt.shiftKey);
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

      {/* Endpoint handles, so a selected wall reads as something you could grab. */}
      {floor.walls
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
                listening={false}
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
