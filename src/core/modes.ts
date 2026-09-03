/**
 * Editor modes and viewports.
 *
 * `EditMode` is the layer toggle described in PLAN.md §8. It drives hit-testing,
 * the tool palette, and rendering in both viewports:
 *
 *   plan     — structure is editable; placements are dimmed and not selectable
 *   furnish  — structure is locked and cached; only placements are selectable
 *
 * `ViewMode` selects which renderer is showing the same document (PLAN.md §1).
 */

export const EDIT_MODES = ['plan', 'furnish'] as const;
export type EditMode = (typeof EDIT_MODES)[number];

export const VIEW_MODES = ['plan2d', 'space3d'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const EDIT_MODE_LABELS: Record<EditMode, string> = {
  plan: 'Edit floor plan',
  furnish: 'Arrange furniture',
};

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  plan2d: 'Plan',
  space3d: 'Space',
};

/** Structure (walls, rooms, openings, background) accepts input only in `plan`. */
export function structureIsEditable(mode: EditMode): boolean {
  return mode === 'plan';
}

/** Placements accept input only in `furnish`. */
export function placementsAreEditable(mode: EditMode): boolean {
  return mode === 'furnish';
}

export function otherEditMode(mode: EditMode): EditMode {
  return mode === 'plan' ? 'furnish' : 'plan';
}

/** Everything a click can land on, in either viewport. */
export type SelectableKind = 'wall' | 'room' | 'opening' | 'placement';

/**
 * Whether a click on a thing of this kind may select it, in this mode.
 *
 * Written as *placement or else structure* rather than as a check per kind, so a
 * kind added later is locked with the structure it belongs to instead of falling
 * through both branches and quietly becoming selectable everywhere. That is not
 * hypothetical: `opening` was added to the 3D scene's refs in phase 6, and a
 * two-branch guard would have let a door be selected — and deleted — in furnish
 * mode, where the plan view refuses to let you touch it.
 */
export function refIsEditable(mode: EditMode, kind: SelectableKind): boolean {
  return kind === 'placement' ? placementsAreEditable(mode) : structureIsEditable(mode);
}
