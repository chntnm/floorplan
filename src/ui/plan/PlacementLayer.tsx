import { useLayoutEffect, useRef } from 'react';
import { Circle, Layer, Line, Text } from 'react-konva';
import type Konva from 'konva';
import type { Floor, Id, Placement, SpaceDocument } from '../../core/document';
import { findItem } from '../../core/document';
import { worldOutline } from '../../core/placement';
import { zoneOutline } from '../../core/clearance';
import { backOffset } from '../../core/placement-snap';
import { rotate, toRadians } from '../../core/geometry/vec';
import { docToScreen, flattenToScreen, pxToMm, type Viewport } from '../../core/viewport';
import type { PlacementTransform, SelectionRef } from '../../state/store';
import type { PlanTheme } from './theme';

/** How far the rotate handle sits beyond the item's back edge, in screen pixels. */
const ROTATE_HANDLE_PX = 22;

type Props = {
  doc: SpaceDocument;
  floor: Floor;
  viewport: Viewport;
  theme: PlanTheme;
  selection: SelectionRef[];
  /** True in furnish mode only — the other half of the layer toggle. */
  interactive: boolean;
  /** False while a placing or measuring tool is armed: the click is not a selection. */
  selectable: boolean;
  /** The drag in flight, previewed here while the document still holds the original. */
  transform: PlacementTransform | null;
  /** Placements the validation panel is reporting on — drawn in the warning colour. */
  flagged: ReadonlySet<Id>;
  onSelect: (ref: SelectionRef, additive: boolean) => void;
  onGrab: (placementId: Id, mode: 'move' | 'rotate') => void;
};

/**
 * Furniture footprints.
 *
 * Geometry comes from `worldOutline`, which derives the world polygon from the stored
 * *local* footprint every time. Rotation is never baked into stored vertices: baking
 * accumulates floating-point error across repeated turns and makes "reset rotation"
 * impossible to implement correctly.
 */
export function PlacementLayer({
  doc,
  floor,
  viewport,
  theme,
  selection,
  interactive,
  selectable,
  transform,
  flagged,
  onSelect,
  onGrab,
}: Props) {
  // Same hazard as the structure layer: Konva refreshes hit geometry on draw, not on
  // assignment, so a click arriving in the frame the mode changed — or in the frame a
  // placement first appeared — is tested against the old state. See `useSyncHitGraph`
  // in StructureLayer for the full explanation.
  const layerRef = useRef<Konva.Layer>(null);
  useLayoutEffect(() => {
    layerRef.current?.drawHit();
  }, [interactive, floor.placements.length]);

  // A placement being dragged renders from the preview; the document still holds the
  // original until the pointer is released, which is what makes the drag one undo step.
  const placements: Placement[] = transform
    ? floor.placements.map((p) =>
        p.id === transform.placementId
          ? {
              ...p,
              position: transform.position,
              rotation: transform.rotation,
              mount: transform.mount,
            }
          : p,
      )
    : floor.placements;

  const only =
    selection.length === 1 && selection[0]!.kind === 'placement' ? selection[0]!.id : null;

  return (
    <Layer ref={layerRef} listening={interactive} opacity={interactive ? 1 : 0.4}>
      {placements.map((placement) => {
        const item = findItem(doc, placement.itemId);
        if (!item) return null; // dangling itemId — the validation panel reports it

        const selected = selection.some((s) => s.kind === 'placement' && s.id === placement.id);
        const warned = flagged.has(placement.id);

        return (
          <Line
            key={placement.id}
            points={flattenToScreen(viewport, worldOutline(placement, item).pts)}
            closed
            fill={placement.overrides?.color ?? item.color ?? theme.placementFill}
            stroke={selected ? theme.selection : warned ? theme.warning : theme.placementStroke}
            strokeWidth={selected || warned ? 2 : 1}
            opacity={0.85}
            onMouseDown={(e) => {
              // Same rule as the structure layer: a non-selectable click must not be
              // cancelled here, or the tool that was actually armed never sees it.
              if (!selectable) return;
              e.cancelBubble = true;
              onSelect({ kind: 'placement', id: placement.id }, e.evt.shiftKey);
              // Selecting and grabbing are one gesture; a press that never moves
              // commits nothing, because the commit skips an unchanged placement.
              if (!e.evt.shiftKey) onGrab(placement.id, 'move');
            }}
          />
        );
      })}

      {/* Clearance zones, on the selected item only.

          Drawn rather than merely reported, for the same reason the swing arc is: a
          warning that says "the bookcase blocks the drawer pull" is an argument, and
          the dashed rectangle it is about is the evidence. On the selection only,
          because six dining chairs with pull-out zones would otherwise cover the
          floor in hatching and tell you nothing. */}
      {only
        ? (() => {
            const placement = placements.find((p) => p.id === only);
            const item = placement ? findItem(doc, placement.itemId) : undefined;
            if (!placement || !item?.clearances) return null;

            return item.clearances.map((zone, i) => {
              const outline = zoneOutline(placement, item, zone);
              if (!outline) return null;
              return (
                <Line
                  key={`zone-${i}`}
                  points={flattenToScreen(viewport, outline.pts)}
                  closed
                  listening={false}
                  fill={theme.zoneFill}
                  stroke={theme.zoneStroke}
                  strokeWidth={1}
                  dash={[5, 4]}
                />
              );
            });
          })()
        : null}

      {/* The rotate handle, on a single selected placement. It sticks out of the
          item's back — the edge wall snap aligns — so "handle pointing up" and
          "rotation 0" mean the same thing everywhere in the app. */}
      {only && selectable
        ? (() => {
            const placement = placements.find((p) => p.id === only);
            const item = placement ? findItem(doc, placement.itemId) : undefined;
            if (!placement || !item) return null;

            const reach = backOffset(item.footprint) + pxToMm(viewport, ROTATE_HANDLE_PX);
            const offset = rotate({ x: 0, y: -reach }, toRadians(placement.rotation));
            const centre = docToScreen(viewport, placement.position);
            const handle = docToScreen(viewport, {
              x: placement.position.x + offset.x,
              y: placement.position.y + offset.y,
            });

            return (
              <>
                <Line
                  points={[centre.x, centre.y, handle.x, handle.y]}
                  stroke={theme.selection}
                  strokeWidth={1}
                  dash={[3, 3]}
                  listening={false}
                />
                <Circle
                  x={handle.x}
                  y={handle.y}
                  radius={5}
                  fill={theme.selection}
                  stroke="#fff"
                  strokeWidth={1}
                  hitStrokeWidth={14}
                  onMouseDown={(e) => {
                    e.cancelBubble = true;
                    onGrab(placement.id, 'rotate');
                  }}
                />
                {transform?.mode === 'rotate' ? (
                  <Text
                    x={handle.x - 40}
                    y={handle.y - 26}
                    width={80}
                    align="center"
                    text={`${Math.round(placement.rotation)}°`}
                    fontSize={12}
                    fontStyle="600"
                    fill={theme.selection}
                    listening={false}
                  />
                ) : null}
              </>
            );
          })()
        : null}
    </Layer>
  );
}
