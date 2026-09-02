import { Layer, Line } from 'react-konva';
import type { Floor, SpaceDocument } from '../../core/document';
import { findItem } from '../../core/document';
import { worldOutline } from '../../core/placement';
import { flattenToScreen, type Viewport } from '../../core/viewport';
import type { SelectionRef } from '../../state/store';
import type { PlanTheme } from './theme';

type Props = {
  doc: SpaceDocument;
  floor: Floor;
  viewport: Viewport;
  theme: PlanTheme;
  selection: SelectionRef[];
  /** True in furnish mode only — the other half of the layer toggle. */
  interactive: boolean;
  onSelect: (ref: SelectionRef, additive: boolean) => void;
};

/**
 * Furniture footprints.
 *
 * Phase 2 has no way to *create* a placement — that is phase 4 — but a `.space` file
 * opened here may well contain them, and the mode toggle is only demonstrable if both
 * halves of it render. Footprints come from `worldOutline`, which derives world
 * geometry from the stored local footprint rather than reading baked vertices.
 */
export function PlacementLayer({
  doc,
  floor,
  viewport,
  theme,
  selection,
  interactive,
  onSelect,
}: Props) {
  return (
    <Layer listening={interactive} opacity={interactive ? 1 : 0.4}>
      {floor.placements.map((placement) => {
        const item = findItem(doc, placement.itemId);
        if (!item) return null; // dangling itemId — the validation panel's problem

        const selected = selection.some((s) => s.kind === 'placement' && s.id === placement.id);
        return (
          <Line
            key={placement.id}
            points={flattenToScreen(viewport, worldOutline(placement, item).pts)}
            closed
            fill={placement.overrides?.color ?? item.color ?? theme.placementFill}
            stroke={selected ? theme.selection : theme.placementStroke}
            strokeWidth={selected ? 2 : 1}
            opacity={0.85}
            onMouseDown={(e) => {
              e.cancelBubble = true;
              onSelect({ kind: 'placement', id: placement.id }, e.evt.shiftKey);
            }}
          />
        );
      })}
    </Layer>
  );
}
