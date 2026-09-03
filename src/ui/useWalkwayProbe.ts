import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { activeFloor, useStore } from '../state/store';
import { narrowestGap, walkwayObstructions, type WalkwayProbe } from '../core/walkway';

/**
 * The narrowest gap along the walkway path, recomputed whenever the plan changes.
 *
 * The store holds the *path*, not the answer, so this is derived rather than cached:
 * drag the sofa 100mm and the number moves with it. That is the whole reason a probe
 * is worth having over a measurement — it stays true while you rearrange, instead of
 * describing a room you have since changed.
 *
 * Cheap enough to derive in two places. Two rays per sample over the walls and the
 * furniture solid at body height is a few thousand line intersections at worst, and
 * `useMemo` keeps it off every render.
 */
export function useWalkwayProbe(): { path: readonly { x: number; y: number }[] | null; probe: WalkwayProbe | null } {
  const { doc, walkway } = useStore(
    useShallow((s) => ({ doc: s.doc, walkway: s.walkway })),
  );

  const probe = useMemo(() => {
    if (!walkway || walkway.length < 2) return null;
    const floor = activeFloor({ doc });
    return narrowestGap(walkway, walkwayObstructions(doc, floor));
  }, [doc, walkway]);

  return { path: walkway, probe };
}
