import { describe, expect, it } from 'vitest';
import {
  EDIT_MODES,
  otherEditMode,
  placementsAreEditable,
  refIsEditable,
  structureIsEditable,
  type EditMode,
  type SelectableKind,
} from './modes';

const KINDS: SelectableKind[] = ['wall', 'room', 'opening', 'placement'];

describe('edit modes', () => {
  it('makes structure and placements mutually exclusive in every mode', () => {
    // This is the whole point of the layer toggle: exactly one of the two
    // layers accepts input at any time.
    for (const mode of EDIT_MODES) {
      expect(structureIsEditable(mode)).not.toBe(placementsAreEditable(mode));
    }
  });

  it('round-trips through otherEditMode', () => {
    for (const mode of EDIT_MODES) {
      expect(otherEditMode(otherEditMode(mode))).toBe(mode);
    }
  });

  it('locks structure while furnishing', () => {
    const mode: EditMode = 'furnish';
    expect(structureIsEditable(mode)).toBe(false);
    expect(placementsAreEditable(mode)).toBe(true);
  });

  it('lets exactly one kind be selected in each mode', () => {
    // Exhaustive over the kinds, which is the point: a door is structure and locks
    // with the wall it is cut into, in both viewports.
    for (const kind of KINDS) {
      expect(refIsEditable('plan', kind)).toBe(kind !== 'placement');
      expect(refIsEditable('furnish', kind)).toBe(kind === 'placement');
    }
  });
});
