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
import {
  OPENING_KIND_LABELS,
  openingFitReason,
  openingRange,
  rangesOverlap,
} from './openings';
import { clearanceVolume, leafOf, pocketFitReason } from './swing';
import { EDGE_LABELS, findClearanceViolations } from './clearance';
import { findCollisions, volumesCollide, type Volume } from './geometry/collision';
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
  | 'below-floor'
  | 'missing-item'
  | 'broken-mount'
  | 'opening-fit'
  | 'opening-overlap'
  | 'swing-blocked'
  | 'pocket-blocked'
  | 'clearance';

export type IssueSeverity = 'blocking' | 'warning';

export type IssueRef = { kind: 'wall' | 'room' | 'opening' | 'placement'; id: Id };

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

  // Openings. A wall dragged shorter leaves its doors hanging past the end, and
  // nothing re-clamps them — deliberately, because silently sliding somebody's front
  // door along the wall would hide the mistake rather than report it.
  const wallsById = new Map(floor.walls.map((w) => [w.id, w]));
  for (const opening of floor.openings) {
    const wall = wallsById.get(opening.wallId);
    if (!wall) continue; // deletion takes openings with the wall; nothing to report

    const reason = openingFitReason(wall, opening);
    if (reason) {
      issues.push({
        kind: 'opening-fit',
        severity: 'warning',
        message: reason,
        refs: [
          { kind: 'opening', id: opening.id },
          { kind: 'wall', id: wall.id },
        ],
      });
    }

    // A pocket door with nowhere to slide is a pocket door in name only, and it is
    // the one thing about the kind that geometry cannot show you: the cavity is
    // inside the wall, so an unbuildable one looks perfectly fine in both views.
    const pocket = pocketFitReason(wall, opening, floor.openings);
    if (pocket) {
      issues.push({
        kind: 'pocket-blocked',
        severity: 'warning',
        message: pocket,
        refs: [
          { kind: 'opening', id: opening.id },
          { kind: 'wall', id: wall.id },
        ],
      });
    }
  }

  // Overlapping openings on the same wall. The geometry merges them into one gap, so
  // without this the user gets a wider doorway than either door they placed and no
  // indication of why.
  for (let i = 0; i < floor.openings.length; i++) {
    for (let j = i + 1; j < floor.openings.length; j++) {
      const a = floor.openings[i]!;
      const b = floor.openings[j]!;
      if (a.wallId !== b.wallId) continue;
      if (!rangesOverlap(openingRange(a), openingRange(b))) continue;

      issues.push({
        kind: 'opening-overlap',
        severity: 'warning',
        message: `${OPENING_KIND_LABELS[a.kind]} and ${OPENING_KIND_LABELS[
          b.kind
        ].toLowerCase()} overlap in the same wall.`,
        refs: [
          { kind: 'opening', id: a.id },
          { kind: 'opening', id: b.id },
        ],
      });
    }
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

    // A wall mount keeps its stored elevation whether or not the wall is still
    // there, so unlike a surface mount this one does not degrade to anything
    // visible — the shelf simply hangs in mid-air until someone is told.
    if (placement.mount.kind === 'wall' && !wallsById.has(placement.mount.wallId)) {
      issues.push({
        kind: 'broken-mount',
        severity: 'warning',
        message: `${item.name} is mounted on a wall that no longer exists.`,
        refs: [{ kind: 'placement', id: placement.id }],
      });
    }

    try {
      volumes.push(placementVolume(doc, placement, item));
      owners.push(placement.id);

      const span = placementSpan(doc, placement, item);
      const ceiling = ceilingHeightAt(doc, placement);

      // A ceiling mount resolves to `ceiling − drop − height`, which goes negative
      // for anything tall enough — a 2400mm pendant in a 2438mm room. `solidSpan`
      // will not object, so the item silently sinks through the floor.
      if (span.bottom < 0) {
        issues.push({
          kind: 'below-floor',
          severity: 'warning',
          message: `${item.name} hangs ${Math.round(-span.bottom)}mm below the floor. Reduce the drop, or lower the item.`,
          refs: [{ kind: 'placement', id: placement.id }],
        });
      }

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

  // What each leaf needs kept clear, against the furniture. Walls are deliberately
  // not tested: a door swinging back to rest against the adjacent wall is how doors
  // are hung, and flagging it would fire on every door in a corner.
  for (const opening of floor.openings) {
    const wall = wallsById.get(opening.wallId);
    if (!wall) continue;
    const clearance = clearanceVolume(wall, opening);
    if (!clearance) continue;

    const style = leafOf(opening).style;
    for (const [i, volume] of volumes.entries()) {
      if (!volumesCollide(clearance, volume)) continue;
      const who = label(doc, owners[i]!, floor);
      issues.push({
        kind: 'swing-blocked',
        severity: 'warning',
        message:
          style === 'sliding'
            ? `${OPENING_KIND_LABELS[opening.kind]} has nowhere to slide — ${who} is where it parks.`
            : `${OPENING_KIND_LABELS[opening.kind]} cannot open fully — ${who} is in its way.`,
        refs: [
          { kind: 'opening', id: opening.id },
          { kind: 'placement', id: owners[i]! },
        ],
      });
    }
  }

  // Clearance zones. Walls are deliberately not tested — see `clearance.ts`; the
  // walkway probe is the check that includes them.
  for (const violation of findClearanceViolations(doc, floor)) {
    issues.push({
      kind: 'clearance',
      severity: 'warning',
      message:
        `${label(doc, violation.intruderId, floor)} blocks the ${violation.zone.reason} ` +
        `clearance ${EDGE_LABELS[violation.zone.edge]} ${label(doc, violation.placementId, floor)}.`,
      refs: [
        { kind: 'placement', id: violation.placementId },
        { kind: 'placement', id: violation.intruderId },
      ],
    });
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
    'below-floor': 3,
    'opening-fit': 4,
    'opening-overlap': 5,
    'pocket-blocked': 6,
    'swing-blocked': 7,
    headroom: 8,
    clearance: 9,
    overlap: 10,
  };
  return issues.sort((x, y) => order[x.kind] - order[y.kind]);
}
