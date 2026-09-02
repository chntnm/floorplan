import { describe, expect, it } from 'vitest';
import type { Placement, Wall } from './document';
import { rectFootprint, type Footprint } from './geometry/footprint';
import { makeFootprint } from './geometry/footprint';
import { worldOutline } from './placement';
import {
  ROTATION_STEP_DEG,
  backOffset,
  hostAt,
  snapPlacement,
  snapRotation,
  snapToWall,
  type PlacementSnapContext,
  type SnapHost,
} from './placement-snap';
import { polygon } from './geometry/polygon';

const SOFA = rectFootprint(2000, 900); // backOffset 450

function wall(a: { x: number; y: number }, b: { x: number; y: number }, thicknessMm = 200): Wall {
  return { id: 'w1', a, b, thicknessMm, heightMm: 2438, baseElevationMm: 0 };
}

function placementAt(position: { x: number; y: number }, rotation: number): Placement {
  return {
    id: 'p1',
    itemId: 'i1',
    floorId: 'f1',
    position,
    rotation,
    mount: { kind: 'floor' },
    elevation: 0,
  };
}

/** Perpendicular distance from a point to the infinite line through a wall. */
function distanceToLine(w: Wall, p: { x: number; y: number }): number {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const len = Math.hypot(dx, dy);
  return Math.abs((p.x - w.a.x) * (dy / len) - (p.y - w.a.y) * (dx / len));
}

/**
 * The nearest the item's outline comes to the wall's centreline after snapping.
 *
 * A flush item touches the face exactly, so this equals the wall's half-thickness —
 * more means a gap, less means the item is inside the wall.
 */
function nearestApproach(w: Wall, footprint: Footprint, snap: { position: { x: number; y: number }; rotation: number }): number {
  const outline = worldOutline(placementAt(snap.position, snap.rotation), {
    footprint,
  } as never);
  return Math.min(...outline.pts.map((p) => distanceToLine(w, p)));
}

describe('backOffset', () => {
  it('is the half-depth of a centred footprint', () => {
    expect(backOffset(SOFA)).toBe(450);
  });

  it('is the true offset for a footprint that does not straddle its origin', () => {
    // A shape whose local origin sits at its front edge: the back is a full depth away.
    const offCentre = makeFootprint({
      kind: 'poly',
      pts: [
        { x: -500, y: -800 },
        { x: 500, y: -800 },
        { x: 500, y: 0 },
        { x: -500, y: 0 },
      ],
    });
    expect(backOffset(offCentre)).toBe(800);
  });
});

describe('snapToWall', () => {
  it('seats the back edge on the wall face, not the centre on the centreline', () => {
    // The bug this guards: centring a 2000x900 sofa on a wall puts half of it inside.
    const w = wall({ x: 0, y: 0 }, { x: 5000, y: 0 });
    const snap = snapToWall({ x: 2000, y: 700 }, w, SOFA, 1000);
    expect(snap).not.toBeNull();

    expect(snap!.rotation).toBe(0);
    expect(snap!.position).toEqual({ x: 2000, y: 550 });
    expect(nearestApproach(w, SOFA, snap!)).toBeCloseTo(100, 6); // half of 200
  });

  it('turns the item so its back faces the wall, whichever side it is on', () => {
    const w = wall({ x: 0, y: 0 }, { x: 5000, y: 0 });

    const below = snapToWall({ x: 2000, y: 700 }, w, SOFA, 1000)!;
    const above = snapToWall({ x: 2000, y: -700 }, w, SOFA, 1000)!;

    expect(below.rotation).toBe(0);
    expect(Math.abs(above.rotation)).toBe(180);
    expect(below.position.y).toBeGreaterThan(0);
    expect(above.position.y).toBeLessThan(0);
  });

  it('stays flush at angles that are not axis-aligned', () => {
    // The case where a half-extent shortcut silently stops working.
    for (const degrees of [0, 30, 45, 67.5, 90, 143, 200, 315]) {
      const rad = (degrees * Math.PI) / 180;
      const end = { x: Math.round(5000 * Math.cos(rad)), y: Math.round(5000 * Math.sin(rad)) };
      const w = wall({ x: 0, y: 0 }, end);

      // A point offset perpendicular from the wall's midpoint, on one side.
      const n = { x: -Math.sin(rad), y: Math.cos(rad) };
      const raw = { x: end.x / 2 + n.x * 600, y: end.y / 2 + n.y * 600 };

      const snap = snapToWall(raw, w, SOFA, 1000);
      expect(snap, `no snap at ${degrees}deg`).not.toBeNull();
      // Within half a millimetre, which is the most that can be asserted: the
      // canonical unit is the integer millimetre and `worldOutline` rounds its
      // vertices onto it, so an off-axis edge lands within a rounding step of the
      // face rather than exactly on it.
      expect(nearestApproach(w, SOFA, snap!), `${degrees}deg`).toBeCloseTo(100, 0);
    }
  });

  it('pulls an item back out when it is already inside the wall', () => {
    // A negative gap still snaps — that is exactly the correction the user wants.
    const w = wall({ x: 0, y: 0 }, { x: 5000, y: 0 });
    const snap = snapToWall({ x: 2000, y: 50 }, w, SOFA, 100);
    expect(snap).not.toBeNull();
    expect(nearestApproach(w, SOFA, snap!)).toBeCloseTo(100, 6);
  });

  it('does not snap to a wall it is nowhere near', () => {
    const w = wall({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(snapToWall({ x: 2000, y: 4000 }, w, SOFA, 200)).toBeNull();
  });

  it('does not snap to the wall extension past either end', () => {
    // Standing off the end of a wall is not standing against it.
    const w = wall({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(snapToWall({ x: -3000, y: 600 }, w, SOFA, 200)).toBeNull();
    expect(snapToWall({ x: 9000, y: 600 }, w, SOFA, 200)).toBeNull();
  });

  it('ignores a degenerate wall rather than dividing by zero', () => {
    const w = wall({ x: 100, y: 100 }, { x: 100, y: 100 });
    expect(snapToWall({ x: 100, y: 200 }, w, SOFA, 500)).toBeNull();
  });
});

describe('hostAt', () => {
  const table: SnapHost = {
    id: 'table',
    canHostSurface: true,
    outline: polygon([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ]),
  };
  const sofa: SnapHost = { ...table, id: 'sofa', canHostSurface: false };

  it('finds a host under the point', () => {
    expect(hostAt({ x: 500, y: 500 }, [table])?.id).toBe('table');
  });

  it('ignores anything that cannot host', () => {
    // Without the flag a lamp carried across the room would mount to every sofa it
    // passed over.
    expect(hostAt({ x: 500, y: 500 }, [sofa])).toBeUndefined();
  });

  it('returns nothing when the point is outside', () => {
    expect(hostAt({ x: 5000, y: 5000 }, [table])).toBeUndefined();
  });
});

describe('snapPlacement', () => {
  const base = (over: Partial<PlacementSnapContext> = {}): PlacementSnapContext => ({
    walls: [],
    hosts: [],
    footprint: SOFA,
    gridMm: 25,
    gridEnabled: true,
    toleranceMm: 200,
    suppressed: false,
    ...over,
  });

  it('prefers a host over a wall', () => {
    // Something standing on a table is not also standing against a wall, and rotating
    // it to a wall it happens to be near would spin it under the cursor.
    const host: SnapHost = {
      id: 'table',
      canHostSurface: true,
      outline: polygon([
        { x: 0, y: 0 },
        { x: 2000, y: 0 },
        { x: 2000, y: 2000 },
        { x: 0, y: 2000 },
      ]),
    };
    const ctx = base({ hosts: [host], walls: [wall({ x: 0, y: 0 }, { x: 5000, y: 0 })] });
    const result = snapPlacement({ x: 1000, y: 600 }, 42, ctx);

    expect(result.mount).toEqual({ kind: 'surface', hostId: 'table' });
    expect(result.rotation).toBe(42); // untouched
  });

  it('falls through to the wall, then to the grid', () => {
    const w = wall({ x: 0, y: 0 }, { x: 5000, y: 0 });
    expect(snapPlacement({ x: 2000, y: 620 }, 0, base({ walls: [w] })).hints).toEqual([
      { kind: 'wall', wallId: 'w1' },
    ]);
    expect(snapPlacement({ x: 2000, y: 4013 }, 0, base({ walls: [w] })).hints).toEqual([
      { kind: 'grid' },
    ]);
  });

  it('picks the nearer of two walls', () => {
    const near = { ...wall({ x: 0, y: 0 }, { x: 5000, y: 0 }), id: 'near' };
    const far = { ...wall({ x: 0, y: 1400 }, { x: 5000, y: 1400 }), id: 'far' };
    const result = snapPlacement({ x: 2000, y: 620 }, 0, base({ walls: [near, far] }));
    expect(result.hints).toEqual([{ kind: 'wall', wallId: 'near' }]);
  });

  it('rounds to the grid when nothing else applies', () => {
    const result = snapPlacement({ x: 1013, y: 2007 }, 0, base());
    expect(result.position).toEqual({ x: 1025, y: 2000 });
  });

  it('leaves the raw point alone with the grid off', () => {
    const result = snapPlacement({ x: 1013, y: 2007 }, 0, base({ gridEnabled: false }));
    expect(result.position).toEqual({ x: 1013, y: 2007 });
    expect(result.hints).toEqual([]);
  });

  it('suppresses everything under Alt, including the wall', () => {
    const ctx = base({ walls: [wall({ x: 0, y: 0 }, { x: 5000, y: 0 })], suppressed: true });
    const result = snapPlacement({ x: 2000, y: 620 }, 33, ctx);

    expect(result.position).toEqual({ x: 2000, y: 620 });
    expect(result.rotation).toBe(33);
    expect(result.mount).toEqual({ kind: 'floor' });
  });
});

describe('snapRotation', () => {
  it('rounds onto the 15 degree ladder', () => {
    expect(snapRotation(7, false)).toBe(0);
    expect(snapRotation(8, false)).toBe(ROTATION_STEP_DEG);
    expect(snapRotation(-8, false)).toBe(-ROTATION_STEP_DEG);
    expect(snapRotation(91, false)).toBe(90);
  });

  it('leaves the angle alone when suppressed', () => {
    expect(snapRotation(37.4, true)).toBe(37.4);
  });
});
