import { Layer, Line } from 'react-konva';
import type { Floor } from '../../core/document';
import { wallOutline } from '../../core/geometry/wall';
import { flattenToScreen, type Viewport } from '../../core/viewport';
import type { PlanTheme } from './theme';

/**
 * The floor below, drawn faintly under the one being edited. See PLAN.md §11.
 *
 * This is how a staircase lands in the right place, and how an upstairs wall gets put
 * over the one holding it up. It is a tracing-paper underlay and nothing more.
 *
 * **It participates in nothing.** `listening={false}` keeps it out of the hit graph,
 * so a click always addresses the active floor even where a ghost wall sits directly
 * under the cursor. It is equally absent from the wall and room counts, from
 * `floorBounds` and therefore from zoom-to-fit — which is what stops the viewport
 * jumping when you change floors, and stops the status bar reporting walls you cannot
 * select. All of that follows from it reading `floorBelow` here rather than being
 * merged into `floor` anywhere upstream.
 *
 * Rooms are drawn as outlines rather than fills: two translucent room fills stacked
 * read as a third colour, and the underlay would start looking like part of the plan.
 */
export function GhostLayer({
  floor,
  viewport,
  theme,
}: {
  floor: Floor | undefined;
  viewport: Viewport;
  theme: PlanTheme;
}) {
  if (!floor) return null;

  return (
    <Layer listening={false} opacity={0.4}>
      {floor.rooms.map((room) => (
        <Line
          key={room.id}
          points={flattenToScreen(viewport, room.boundary.pts)}
          closed
          stroke={theme.ghost}
          strokeWidth={1}
          dash={[6, 4]}
        />
      ))}

      {floor.walls.map((wall) => {
        let points: number[];
        try {
          points = flattenToScreen(viewport, wallOutline(wall).pts);
        } catch {
          return null; // degenerate — the validation panel's problem, not the underlay's
        }
        return <Line key={wall.id} points={points} closed fill={theme.ghost} />;
      })}
    </Layer>
  );
}
