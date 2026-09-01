import { describe, expect, it } from 'vitest';
import {
  EDIT_MODES,
  otherEditMode,
  placementsAreEditable,
  structureIsEditable,
  type EditMode,
} from './modes';

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
});
