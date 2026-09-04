/**
 * Traversal. See PLAN.md §10.2.
 *
 * Pure: a walker state in, a walker state out. No three.js, no DOM, no store. The
 * render loop calls `stepWalker` once a frame and hands the result to a camera; a
 * unit test calls it a hundred times with a fixed timestep and asserts where the
 * walker ended up. Nothing about walking through a doorway needs a GPU to verify.
 *
 * ## The body interval is the whole design
 *
 * Collision is 2D circle-vs-polygon against every solid whose vertical span overlaps
 * the walker's **body interval**, and that interval starts *above* the floor:
 *
 *     body = [ feet + stepClearance , feet + standingHeight ]
 *
 * `stepClearance` is not a key you press — it is the bottom of the interval, and it
 * is what a stride actually clears. With a body of `[0, 1800]` a 5mm rug reads as a
 * collision, because `[0, 5]` and `[0, 1800]` genuinely overlap; the walker would be
 * stopped dead by a carpet. With `[200, 1800]` the rug passes underneath, the dresser
 * at `[0, 810]` still blocks, the bed frame at `[250, 600]` still blocks, and the
 * lintel over a doorway at `[2032, 2438]` still lets you through. Same shape of fix as
 * `voidBelowMm`: one number, and every case falls out of it.
 *
 * Holding the step key raises the clearance to `STEP_UP_MM`, which is how you get onto
 * a low platform deliberately rather than by walking at it. Crouching lowers the top
 * of the interval instead, so you can duck under a wall-mounted shelf you cannot
 * otherwise pass.
 *
 * ## Sliding
 *
 * A blocked move is retried along the surface it was blocked by: the component going
 * into the contact normal is dropped and the rest is kept. On an axis-aligned wall
 * that is exactly the old "try x, then try y" — the tangent of a north wall *is* the
 * x axis — so the common case is unchanged. On a diagonal it is the case the axis
 * retries could never answer, because moving on one axis alone is the move that was
 * refused and moving on the other lands where the walker already stands.
 *
 * The axis retries are kept behind it. An inside corner has two normals and their
 * average points out of the corner rather than along either wall, so the tangent
 * there is a direction neither surface allows; falling back to one axis at a time is
 * what still gets a walker along the wall they are actually pressed against.
 */

import { circleIntersects, spansOverlap, type Span, type Volume } from './geometry/collision';
import { containsPoint } from './geometry/polygon';
import {
  closestPointOnSegment,
  distanceToSegment,
  dot,
  length,
  normalize,
  scale,
  sub,
  toRadians,
  type Vec2,
} from './geometry/vec';
import type { DocPoint3 } from './units';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Eye height of a standing adult, and of a crouching one. */
export const EYE_HEIGHT_MM = 1650;
export const CROUCH_EYE_MM = 1100;

/** Top of the body interval. Crouching narrows it so you can duck under things. */
export const STAND_HEIGHT_MM = 1800;
export const CROUCH_HEIGHT_MM = 1250;

/** What an ordinary stride clears — a threshold, a rug, a cable. */
export const STEP_OVER_MM = 200;
/** What a deliberate step up clears, with the step key held. A stair riser is ~190. */
export const STEP_UP_MM = 450;

/** Shoulder-width capsule. A 400mm gap is impassable; an 813mm door is not. */
export const BODY_RADIUS_MM = 250;

/** Comfortable indoor walking pace, and a run. */
export const WALK_SPEED_MMS = 1400;
export const RUN_MULTIPLIER = 2;
/** Vertical rate in fly mode. */
export const FLY_SPEED_MMS = 1400;

export const TURN_SPEED_DEG = 140;
/** Looking further than this puts the horizon behind you and reads as broken. */
export const MAX_PITCH_DEG = 85;

/** Longest timestep honoured. A backgrounded tab returns with a huge delta. */
export const MAX_STEP_SECONDS = 0.1;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const CAMERA_MODES = ['orbit', 'walk', 'fly'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  orbit: 'Orbit',
  walk: 'Walk',
  fly: 'Fly',
};

export type Walker = {
  /** Position in document mm. */
  position: Vec2;
  /**
   * Compass bearing in degrees: 0 faces document −y, 90 faces +x.
   *
   * A bearing rather than a maths angle because the document's y axis points south,
   * so "0 is north, 90 is east" is the reading that matches the plan on screen.
   */
  heading: number;
  /** Degrees above the horizon, clamped to ±`MAX_PITCH_DEG`. */
  pitch: number;
  /** Feet above the floor datum — derived each step from what is underfoot. */
  elevation: number;
  crouching: boolean;
};

export type WalkInput = {
  /** −1 back to +1 forward. */
  forward: number;
  /** −1 left to +1 right. */
  strafe: number;
  /** −1 turn left to +1 turn right. */
  turn: number;
  run: boolean;
  crouch: boolean;
  /** The step key: raises the body interval's floor for a deliberate step up. */
  stepUp: boolean;
  /** Fly mode only: −1 down to +1 up. */
  rise: number;
};

export const NO_INPUT: WalkInput = {
  forward: 0,
  strafe: 0,
  turn: 0,
  run: false,
  crouch: false,
  stepUp: false,
  rise: 0,
};

export type WalkWorld = {
  blockers: readonly Volume[];
  /** `fly` ignores collision and gravity entirely. */
  mode: CameraMode;
};

export function createWalker(position: Vec2, heading = 0): Walker {
  return { position: { ...position }, heading, pitch: 0, elevation: 0, crouching: false };
}

// ---------------------------------------------------------------------------
// Geometry of a walker
// ---------------------------------------------------------------------------

/** Unit vector the walker is facing, in document space. */
export function forwardVector(headingDeg: number): Vec2 {
  const t = toRadians(headingDeg);
  return { x: Math.sin(t), y: -Math.cos(t) };
}

/** Unit vector to the walker's right. Facing north (0°), that is east. */
export function rightVector(headingDeg: number): Vec2 {
  const t = toRadians(headingDeg);
  return { x: Math.cos(t), y: Math.sin(t) };
}

/**
 * The vertical interval the walker's body occupies.
 *
 * Read the module comment before changing the bottom of this: it is the single number
 * that decides whether a rug stops you.
 */
export function bodySpan(walker: Walker, stepUp = false): Span {
  const clearance = stepUp ? STEP_UP_MM : STEP_OVER_MM;
  const height = walker.crouching ? CROUCH_HEIGHT_MM : STAND_HEIGHT_MM;
  return { bottom: walker.elevation + clearance, top: walker.elevation + height };
}

export function eyeHeight(walker: Walker): number {
  return walker.elevation + (walker.crouching ? CROUCH_EYE_MM : EYE_HEIGHT_MM);
}

/** Where the camera sits, in document space. */
export function eyePosition(walker: Walker): DocPoint3 {
  return { x: walker.position.x, y: walker.position.y, z: eyeHeight(walker) };
}

/** A point one metre ahead of the eye, along the heading and pitch — the look target. */
export function lookTarget(walker: Walker, distanceMm = 1000): DocPoint3 {
  const f = forwardVector(walker.heading);
  const pitch = toRadians(walker.pitch);
  const horizontal = Math.cos(pitch) * distanceMm;
  return {
    x: walker.position.x + f.x * horizontal,
    y: walker.position.y + f.y * horizontal,
    z: eyeHeight(walker) + Math.sin(pitch) * distanceMm,
  };
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/** Whether a body of `span` centred at `at` clears everything in the world. */
export function isClear(
  at: Vec2,
  span: Span,
  blockers: readonly Volume[],
  radiusMm = BODY_RADIUS_MM,
): boolean {
  for (const blocker of blockers) {
    if (!spansOverlap(span, blocker.span)) continue;
    if (circleIntersects(blocker.outline, at, radiusMm)) return false;
  }
  return true;
}

/**
 * The surface the walker is standing on at a point.
 *
 * The highest solid top that is underfoot and no more than `maxRiseMm` above the
 * current feet — you step *up* only as far as a stride reaches, but you step *down*
 * as far as there is to fall, which is what lets you walk off a platform.
 *
 * Tested on the centre point rather than the capsule, so standing half off the edge
 * of a rug still counts as being on it. Anything finer would need a real support
 * polygon and buys nothing here.
 */
export function groundHeight(
  at: Vec2,
  feetMm: number,
  blockers: readonly Volume[],
  maxRiseMm: number,
): number {
  let ground = 0;
  const ceiling = feetMm + maxRiseMm;

  for (const blocker of blockers) {
    if (blocker.span.top > ceiling || blocker.span.top <= ground) continue;
    if (containsPoint(blocker.outline, at)) ground = blocker.span.top;
  }
  return ground;
}

/**
 * Which way the surfaces touching `at` face, averaged, or null if nothing touches it.
 *
 * Averaged rather than nearest-wins because a walker in an inside corner is against
 * two surfaces at once, and one of them alone would send them straight into the other.
 * The average points out of the corner, which is a direction that will fail `isClear`
 * — and failing is the right answer there, because it is what hands the move to the
 * axis retries that can still slide along one of the two walls.
 *
 * A body already *inside* a blocker takes the direction from itself to the nearest
 * edge instead, so the normal still points at open air rather than deeper in.
 */
function contactNormal(
  at: Vec2,
  span: Span,
  blockers: readonly Volume[],
  radiusMm: number,
): Vec2 | null {
  let sum: Vec2 = { x: 0, y: 0 };

  for (const blocker of blockers) {
    if (!spansOverlap(span, blocker.span)) continue;
    if (!circleIntersects(blocker.outline, at, radiusMm)) continue;

    const inside = containsPoint(blocker.outline, at);
    const pts = blocker.outline.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      // Only the edges actually being touched. A long wall's far edge is part of the
      // same polygon and points the opposite way; including it would cancel the
      // normal out to nothing.
      if (!inside && distanceToSegment(at, a, b) > radiusMm) continue;

      const closest = closestPointOnSegment(at, a, b);
      const away = inside ? sub(closest, at) : sub(at, closest);
      if (length(away) < 1e-6) continue;
      sum = { x: sum.x + normalize(away).x, y: sum.y + normalize(away).y };
    }
  }

  return length(sum) < 1e-6 ? null : normalize(sum);
}

/**
 * Move as far as the world allows, sliding along whatever is in the way.
 *
 * Full move, then along the surface, then x-only, then y-only. See the module comment
 * for why the axis retries survive the surface one.
 */
export function slide(
  from: Vec2,
  delta: Vec2,
  span: Span,
  blockers: readonly Volume[],
  radiusMm = BODY_RADIUS_MM,
): Vec2 {
  // Already inside something — a sofa placed on top of where you were standing, or a
  // wall dragged across it. Every candidate is blocked, so the walker would be frozen
  // in place with no way out but switching to fly. Let them move freely until they
  // are clear again; being stuck is a worse answer than being briefly inside a wall.
  if (!isClear(from, span, blockers, radiusMm)) {
    return { x: from.x + delta.x, y: from.y + delta.y };
  }

  const full = { x: from.x + delta.x, y: from.y + delta.y };
  if (isClear(full, span, blockers, radiusMm)) return full;

  const candidates: Vec2[] = [];

  // The normal is taken at the blocked position rather than at `from`, because `from`
  // is clear by the check above and so touches nothing to take a normal from.
  const normal = contactNormal(full, span, blockers, radiusMm);
  if (normal) {
    const into = dot(delta, normal);
    // Only a move that goes *into* the surface has a component to lose. A move that
    // is already leaving it was blocked by something else, and projecting would take
    // away the escape.
    if (into < 0) {
      const along = sub(delta, scale(normal, into));
      candidates.push({ x: from.x + along.x, y: from.y + along.y });
    }
  }

  candidates.push({ x: from.x + delta.x, y: from.y }, { x: from.x, y: from.y + delta.y });

  for (const candidate of candidates) {
    if (isClear(candidate, span, blockers, radiusMm)) return candidate;
  }
  return from;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/**
 * Advance the walker by one frame.
 *
 * Turning happens first, so strafing after a turn uses the heading you can already
 * see. In `fly` mode collision and ground-following are both skipped — that is the
 * mode's entire purpose, since inspecting a ceiling fan means being able to get to it.
 */
export function stepWalker(
  walker: Walker,
  input: WalkInput,
  deltaSeconds: number,
  world: WalkWorld,
): Walker {
  const dt = Math.min(Math.max(deltaSeconds, 0), MAX_STEP_SECONDS);
  if (dt === 0) return walker;

  const heading = normalizeHeading(walker.heading + input.turn * TURN_SPEED_DEG * dt);
  const crouching = world.mode === 'walk' ? input.crouch : false;
  const turned: Walker = { ...walker, heading, crouching };

  const speed = WALK_SPEED_MMS * (input.run ? RUN_MULTIPLIER : 1) * dt;
  const f = forwardVector(heading);
  const r = rightVector(heading);
  const delta = {
    x: (f.x * input.forward + r.x * input.strafe) * speed,
    y: (f.y * input.forward + r.y * input.strafe) * speed,
  };

  if (world.mode === 'fly') {
    return {
      ...turned,
      position: { x: turned.position.x + delta.x, y: turned.position.y + delta.y },
      elevation: Math.max(0, turned.elevation + input.rise * FLY_SPEED_MMS * dt),
    };
  }

  const span = bodySpan(turned, input.stepUp);
  const position = slide(turned.position, delta, span, world.blockers);
  const elevation = groundHeight(
    position,
    turned.elevation,
    world.blockers,
    input.stepUp ? STEP_UP_MM : STEP_OVER_MM,
  );

  return { ...turned, position, elevation };
}

/** Apply a mouse-look delta, in degrees. Pitch is clamped; heading wraps. */
export function look(walker: Walker, deltaYawDeg: number, deltaPitchDeg: number): Walker {
  return {
    ...walker,
    heading: normalizeHeading(walker.heading + deltaYawDeg),
    pitch: Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, walker.pitch + deltaPitchDeg)),
  };
}

export function normalizeHeading(degrees: number): number {
  const d = degrees % 360;
  return d < 0 ? d + 360 : d;
}
