/**
 * The validation report. See PLAN.md §9.2.
 *
 * Everything here **warns; nothing blocks** — except the calibration gate, which is
 * the one genuine refusal in the application because an unscaled plan makes every
 * number downstream meaningless. Sometimes you really do mean to put the ottoman
 * half under the coffee table, and an app that refuses to let you do something you
 * understand is worse than one that tells you and gets out of the way.
 *
 * Collision is genuinely three-dimensional: footprints must overlap in plan *and*
 * solid vertical spans must overlap. A rug under a table is not a collision, a bin
 * under a desk is not a collision, and boxes under a bed frame are not a collision —
 * each falls out of `voidBelowMm` rather than a special case.
 *
 * Pure — no DOM, no store. `IssueRef` mirrors the editor's selection shape so the UI
 * can select what an issue points at, without core knowing the store exists.
 */

import { placementBlockReason } from './calibration';
import { findItem, type Floor, type Id, type SpaceDocument } from './document';
import { findCollisions, type Volume } from './geometry/collision';
import {
  MountCycleError,
  ceilingHeightAt,
  placementVolume,
  placementSpan,
} from './placement';

export type IssueKind =
  | 'uncalibrated'
  | 'overlap'
  | 'headroom'
  | 'missing-item'
  | 'broken-mount';

export type IssueSeverity = 'blocking' | 'warning';

export type IssueRef = { kind: 'wall' | 'room' | 'placement'; id: Id };

export type Issue = {
  kind: IssueKind;
  severity: IssueSeverity;
  message: string;
  refs: IssueRef[];
};

/** Placement ids involved in any issue — what the plan renders in the warning colour. */
export function flaggedPlacements(issues: readonly Issue[]): Set<Id> {
  const ids = new Set<Id>();
  for (const issue of issues) {
    for (const ref of issue.refs) if (ref.kind === 'placement') ids.add(ref.id);
  }
  return ids;
}

function label(doc: SpaceDocument, placementId: Id, floor: Floor): string {
  const placement = floor.placements.find((p) => p.id === placementId);
  const item = placement ? findItem(doc, placement.itemId) : undefined;
  return item?.name ?? 'Unknown item';
}

/**
 * Every issue on one floor.
 *
 * Ordered blocking-first, then by kind, so the panel's top line is always the thing
 * most worth doing something about.
 */
export function validateFloor(doc: SpaceDocument, floor: Floor): Issue[] {
  const issues: Issue[] = [];

  const blocked = placementBlockReason(floor);
  if (blocked) {
    issues.push({ kind: 'uncalibrated', severity: 'blocking', message: blocked, refs: [] });
  }

  // Volumes, and the placements they belong to. A placement whose item or mount is
  // broken contributes an issue instead of a volume — colliding it against anything
  // would be asserting a position it does not really have.
  const volumes: Volume[] = [];
  const owners: Id[] = [];

  for (const placement of floor.placements) {
    const item = findItem(doc, placement.itemId);
    if (!item) {
      issues.push({
        kind: 'missing-item',
        severity: 'warning',
        message: 'This placement points at an item that is no longer in the inventory.',
        refs: [{ kind: 'placement', id: placement.id }],
      });
      continue;
    }

    if (placement.mount.kind === 'surface') {
      const hostId = placement.mount.hostId;
      const host = floor.placements.find((p) => p.id === hostId);
      if (!host) {
        issues.push({
          kind: 'broken-mount',
          severity: 'warning',
          message: `${item.name} was sitting on something that no longer exists, so it is resting on the floor.`,
          refs: [{ kind: 'placement', id: placement.id }],
        });
      }
    }

    try {
      volumes.push(placementVolume(doc, placement, item));
      owners.push(placement.id);

      const span = placementSpan(doc, placement, item);
      const ceiling = ceilingHeightAt(doc, placement);
      if (span.top > ceiling) {
        issues.push({
          kind: 'headroom',
          severity: 'warning',
          message: `${item.name} is ${Math.round(span.top - ceiling)}mm taller than the ceiling above it.`,
          refs: [{ kind: 'placement', id: placement.id }],
        });
      }
    } catch (err) {
      if (err instanceof MountCycleError) {
        issues.push({
          kind: 'broken-mount',
          severity: 'warning',
          message: `${item.name} is stacked on itself. Move it back to the floor.`,
          refs: err.chain.map((id) => ({ kind: 'placement' as const, id })),
        });
        continue;
      }
      throw err;
    }
  }

  for (const [i, j] of findCollisions(volumes)) {
    const a = owners[i]!;
    const b = owners[j]!;
    issues.push({
      kind: 'overlap',
      severity: 'warning',
      message: `${label(doc, a, floor)} overlaps ${label(doc, b, floor)}.`,
      refs: [
        { kind: 'placement', id: a },
        { kind: 'placement', id: b },
      ],
    });
  }

  const order: Record<IssueKind, number> = {
    uncalibrated: 0,
    'broken-mount': 1,
    'missing-item': 2,
    headroom: 3,
    overlap: 4,
  };
  return issues.sort((x, y) => order[x.kind] - order[y.kind]);
}
