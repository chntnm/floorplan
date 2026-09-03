import { describe, expect, it } from 'vitest';
import {
  ARC_STEP_DEG,
  DEFAULT_SWING,
  LEAF_THICKNESS_MM,
  clampSwingAngle,
  clearanceVolume,
  leafOf,
  leafPanel,
  movingLeafOf,
  parkRun,
  pocketFitReason,
  swingSweep,
} from './swing';
import { volumesCollide } from './geometry/collision';
import { area, bounds, containsPoint, polygon } from './geometry/polygon';
import type { Opening, Wall } from './document';

/** A 5m wall running east from the origin, 2438 high, 114 thick. Front is +y. */
const WALL: Wall = {
  id: 'w1',
  a: { x: 0, y: 0 },
  b: { x: 5000, y: 0 },
  thicknessMm: 114,
  heightMm: 2438,
  baseElevationMm: 0,
};

function opening(over: Partial<Opening> = {}): Opening {
  return {
    id: 'o1',
    wallId: 'w1',
    offsetMm: 1000,
    widthMm: 813,
    heightMm: 2032,
    sillMm: 0,
    kind: 'door',
    ...over,
  };
}

/**
 * Whether the sweep covers a point.
 *
 * Deliberately not "is vertex 0 the hinge": `ensureCounterClockwise` reverses the
 * ring when the turn goes the other way, so vertex *order* is not a contract — and
 * a mirrored door is exactly the case that reverses it. What the sector covers is
 * the thing that matters to every consumer anyway.
 */
function covers(wall: Wall, o: Opening, p: { x: number; y: number }): boolean {
  return containsPoint(swingSweep(wall, o)!, p);
}

function hasVertex(poly: { pts: readonly { x: number; y: number }[] }, p: { x: number; y: number }) {
  return poly.pts.some((v) => Math.abs(v.x - p.x) < 1e-6 && Math.abs(v.y - p.y) < 1e-6);
}

describe('reading a leaf off an opening', () => {
  it('gives a door a hinge, a side and an angle', () => {
    expect(leafOf(opening())).toEqual({
      style: 'hinged',
      pivot: 'a',
      face: 'front',
      angleDeg: 90,
    });
  });

  it('gives a sliding door no angle to read', () => {
    // The point of the kind-aware shape: nothing downstream can take a swing angle
    // off a door that does not swing.
    expect(leafOf(opening({ kind: 'sliding' }))).toEqual({
      style: 'sliding',
      pivot: 'a',
      face: 'front',
    });
  });

  it('gives a pocket door no side, because it goes inside the wall', () => {
    expect(leafOf(opening({ kind: 'pocket' }))).toEqual({ style: 'pocket', pivot: 'a' });
  });

  it('gives a cased opening and a window no moving leaf', () => {
    expect(leafOf(opening({ kind: 'cased' }))).toEqual({ style: 'none' });
    expect(leafOf(opening({ kind: 'window' }))).toEqual({ style: 'pane' });
  });

  it('falls back to a standard swing when the document has none', () => {
    // Every opening written before this phase has no `swing`, and none of them
    // should read as a door hinged nowhere.
    const legacy = opening();
    delete legacy.swing;
    expect(leafOf(legacy)).toEqual({
      style: 'hinged',
      pivot: DEFAULT_SWING.hinge,
      face: DEFAULT_SWING.into,
      angleDeg: DEFAULT_SWING.angleDeg,
    });
  });

  it('keeps a stored swing readable through a kind that ignores it', () => {
    const stored = opening({ kind: 'cased', swing: { hinge: 'b', into: 'back', angleDeg: 45 } });
    expect(leafOf(stored)).toEqual({ style: 'none' });
    expect(leafOf({ ...stored, kind: 'door' })).toEqual({
      style: 'hinged',
      pivot: 'b',
      face: 'back',
      angleDeg: 45,
    });
  });

  it('clamps a nonsense angle rather than drawing one', () => {
    expect(clampSwingAngle(0)).toBe(15);
    expect(clampSwingAngle(400)).toBe(180);
    expect(clampSwingAngle(Number.NaN)).toBe(90);
  });

  it('offers a leaf to hang only where there is one', () => {
    for (const kind of ['door', 'sliding', 'pocket'] as const) {
      expect(movingLeafOf(opening({ kind }))?.pivot).toBe('a');
    }
    expect(movingLeafOf(opening({ kind: 'cased' }))).toBeNull();
    expect(movingLeafOf(opening({ kind: 'window' }))).toBeNull();
  });
});

describe('the swept sector', () => {
  it('hinges on the face it opens onto, not on the centreline', () => {
    // Half a wall thickness off the centre: 57mm on a 114 wall. Small enough to be
    // invisible in a drawing and large enough to bias every clearance answer.
    expect(hasVertex(swingSweep(WALL, opening())!, { x: 1000, y: 57 })).toBe(true);
  });

  it('opens a quarter turn onto the front of the wall', () => {
    const sweep = swingSweep(WALL, opening())!;
    expect(hasVertex(sweep, { x: 1000, y: 870 })).toBe(true); // 57 + 813
    expect(bounds(sweep)).toEqual({ minX: 1000, minY: 57, maxX: 1813, maxY: 870 });
  });

  it('mirrors when the hinge moves to the other jamb, and stays on the same side', () => {
    // The two sectors have the same bounding box — they are reflections of each
    // other about the middle of the opening — so the assertion has to be about what
    // each one covers. Near the far jamb is inside one and outside the other.
    const byA = opening();
    const byB = opening({ swing: { hinge: 'b', into: 'front', angleDeg: 90 } });

    expect(covers(WALL, byA, { x: 1050, y: 800 })).toBe(true);
    expect(covers(WALL, byA, { x: 1760, y: 800 })).toBe(false);
    expect(covers(WALL, byB, { x: 1760, y: 800 })).toBe(true);
    expect(covers(WALL, byB, { x: 1050, y: 800 })).toBe(false);
  });

  it('turns the other way when it opens onto the back', () => {
    const back = opening({ swing: { hinge: 'a', into: 'back', angleDeg: 90 } });
    expect(hasVertex(swingSweep(WALL, back)!, { x: 1000, y: -57 })).toBe(true);
    expect(covers(WALL, back, { x: 1050, y: -800 })).toBe(true);
    expect(covers(WALL, back, { x: 1050, y: 800 })).toBe(false);
  });

  it('covers the true sector area, not a chord-cut approximation of it', () => {
    // The polygon is inscribed, so it always under-reports; what matters is by how
    // little. A quarter of an 813 radius circle is 519,163mm², and 18 chords over
    // 90° leave a sagitta of 0.8mm — under the width of anything worth reporting.
    const sweep = swingSweep(WALL, opening())!;
    const exact = (Math.PI * 813 * 813) / 4;
    expect(area(sweep)).toBeGreaterThan(exact * 0.998);
    expect(area(sweep)).toBeLessThanOrEqual(exact);
  });

  it('uses more vertices for a wider swing', () => {
    // One hinge, then a vertex per step plus the closing one.
    expect(swingSweep(WALL, opening())!.pts).toHaveLength(2 + 90 / ARC_STEP_DEG);
    const half = swingSweep(WALL, opening({ swing: { hinge: 'a', into: 'front', angleDeg: 180 } }))!;
    expect(half.pts).toHaveLength(2 + 180 / ARC_STEP_DEG);
  });

  it('is nothing at all for the styles that do not swing', () => {
    for (const kind of ['sliding', 'pocket', 'cased', 'window'] as const) {
      expect(swingSweep(WALL, opening({ kind }))).toBeNull();
    }
  });
});

describe('the leaf panel', () => {
  it('stands where the door comes to rest', () => {
    const panel = leafPanel(WALL, opening())!;
    const box = bounds(panel);
    expect(box.maxY).toBeCloseTo(870, 6);
    expect(box.maxX - box.minX).toBeCloseTo(LEAF_THICKNESS_MM, 6);
  });

  it('parks a sliding leaf over the wall beside the opening, standing off its face', () => {
    const panel = leafPanel(WALL, opening({ kind: 'sliding' }))!;
    const box = bounds(panel);
    expect(box.minX).toBeCloseTo(187, 6); // 1000 − 813
    expect(box.maxX).toBeCloseTo(1000, 6);
    // 57 wall + 20 standoff, then the leaf's own 35.
    expect(box.minY).toBeCloseTo(77, 6);
    expect(box.maxY).toBeCloseTo(112, 6);
  });

  it('draws no pocket leaf, because it is inside the wall', () => {
    expect(leafPanel(WALL, opening({ kind: 'pocket' }))).toBeNull();
    expect(leafPanel(WALL, opening({ kind: 'cased' }))).toBeNull();
  });

  it('glazes a window in the plane of the wall', () => {
    const pane = leafPanel(WALL, opening({ kind: 'window', sillMm: 914, heightMm: 1219 }))!;
    const box = bounds(pane);
    expect(box.minX).toBeCloseTo(1000, 6);
    expect(box.maxX).toBeCloseTo(1813, 6);
    expect(box.maxY - box.minY).toBeCloseTo(LEAF_THICKNESS_MM / 2, 6);
  });
});

describe('what has to stay clear', () => {
  /** A 600 × 600 box, floor to 900, centred at `x, y`. */
  function box(x: number, y: number) {
    return {
      outline: polygon([
        { x: x - 300, y: y - 300 },
        { x: x + 300, y: y - 300 },
        { x: x + 300, y: y + 300 },
        { x: x - 300, y: y + 300 },
      ]),
      span: { bottom: 0, top: 900 },
    };
  }

  it('reports a chest of drawers standing in the swing', () => {
    const volume = clearanceVolume(WALL, opening())!;
    expect(volumesCollide(volume, box(1400, 400))).toBe(true);
  });

  it('leaves the same chest alone once the door is hung the other way', () => {
    const other = opening({ swing: { hinge: 'a', into: 'back', angleDeg: 90 } });
    expect(volumesCollide(clearanceVolume(WALL, other)!, box(1400, 400))).toBe(false);
  });

  it('catches a thin object at the outer edge of the arc', () => {
    // The chord-versus-arc case the vertex count exists for. This box sits at 22.5°
    // from the hinge, 750–803mm out — comfortably inside the true sector, and
    // outside the polygon a 45°-per-step arc would produce, because the chord
    // between two coarse vertices cuts across in front of it.
    const sliver = {
      outline: polygon([
        { x: 1700, y: 330 },
        { x: 1740, y: 330 },
        { x: 1740, y: 370 },
        { x: 1700, y: 370 },
      ]),
      span: { bottom: 0, top: 900 },
    };
    expect(volumesCollide(clearanceVolume(WALL, opening())!, sliver)).toBe(true);
  });

  it('lets a rug lie under the door', () => {
    // The sweep has the opening's own vertical extent, so anything below the sill
    // is not in the way — the same span test every other collision here uses.
    const rug = { outline: box(1400, 400).outline, span: { bottom: 0, top: 5 } };
    const door = opening({ sillMm: 20 });
    expect(volumesCollide(clearanceVolume(WALL, door)!, rug)).toBe(false);
  });

  it('reports a bookcase where a sliding door has to park', () => {
    const slider = opening({ kind: 'sliding' });
    expect(volumesCollide(clearanceVolume(WALL, slider)!, box(600, 120))).toBe(true);
  });

  it('asks nothing of the room for a pocket door — that is the whole point of one', () => {
    expect(clearanceVolume(WALL, opening({ kind: 'pocket' }))).toBeNull();
    expect(clearanceVolume(WALL, opening({ kind: 'cased' }))).toBeNull();
    expect(clearanceVolume(WALL, opening({ kind: 'window' }))).toBeNull();
  });
});

describe('a pocket door needs a cavity', () => {
  it('is happy with a leaf width of wall beside it', () => {
    expect(parkRun(opening(), 'a')).toEqual({ from: 187, to: 1000 });
    expect(pocketFitReason(WALL, opening({ kind: 'pocket' }), [])).toBeNull();
  });

  it('says how much wall it is short of when it runs off the end', () => {
    const tooNearTheCorner = opening({ kind: 'pocket', offsetMm: 400 });
    expect(pocketFitReason(WALL, tooNearTheCorner, [])).toContain('413mm short');
  });

  it('slides the other way when the hinge end is flipped', () => {
    const flipped = opening({
      kind: 'pocket',
      offsetMm: 400,
      swing: { hinge: 'b', into: 'front', angleDeg: 90 },
    });
    expect(parkRun(flipped, 'b')).toEqual({ from: 1213, to: 2026 });
    expect(pocketFitReason(WALL, flipped, [])).toBeNull();
  });

  it('refuses to share a cavity with another opening', () => {
    const pocket = opening({ kind: 'pocket' });
    const window = opening({ id: 'o2', offsetMm: 300, widthMm: 914, kind: 'window' });
    expect(pocketFitReason(WALL, pocket, [pocket, window])).toContain('window');
  });

  it('has nothing to say about a door that swings', () => {
    expect(pocketFitReason(WALL, opening(), [])).toBeNull();
  });
});
