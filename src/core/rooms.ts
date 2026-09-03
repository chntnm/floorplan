/**
 * Room detection from the wall graph. See PLAN.md §11.
 *
 * A room is a named polygon. You can trace one directly — that is what the Room and
 * Area tools do — or derive one from the walls that already enclose it, which is what
 * this module is. Deriving is the useful half once a plan has been traced over an
 * imported raster: you drew forty walls, and asking "which of these enclose a space?"
 * is a question the geometry can answer.
 *
 * ## The algorithm
 *
 * Wall centrelines form a planar graph once they are **split at every crossing and
 * every T-junction**. Its faces are found by the standard half-edge walk: arriving at
 * a node along `u → v`, leave by the first edge encountered rotating *clockwise* from
 * the direction back towards `u`. Every directed edge belongs to exactly one face, so
 * walking each unvisited one enumerates the faces exhaustively.
 *
 * That rule makes interior faces come out with **positive signed area** and each
 * connected component's outer face negative — which is the test used here, rather
 * than "discard the biggest". Magnitude fails on a courtyard, where the outer face of
 * an inner ring of walls is smaller than the room around it.
 *
 * ## Four decisions
 *
 * **Boundaries are centrelines, not inner faces.** `commitRoomRect` already draws its
 * boundary on the wall centrelines, and matching it is what lets a drawn room and a
 * detected one describe the same walls with the same number. The alternative — insetting
 * by half a thickness — is more nearly the floor area you could carpet, and would make
 * the two paths disagree about every room you drew by hand.
 *
 * **Detection adds and updates; it never deletes.** A room traced with the Area tool
 * has no walls at all — that is the whole point of `commitShapeRoom` — so removing
 * rooms with no supporting loop would delete a legitimate one every single run. An
 * unmatched room is reported and left alone. (Reporting it as a *validation issue*
 * was considered and rejected for the same reason: it would flag every shape room
 * forever, which is noise, not a finding.)
 *
 * **A detected room is a simple ring.** An island of walls standing inside a room does
 * not punch a hole in it — `Polygon` has no holes — so a courtyard is detected as its
 * own room *and* left inside the ring around it. Stated rather than silently wrong.
 *
 * **Matching is by area overlap, greedily, worst case first.** Centroid containment is
 * cheaper and breaks exactly where it matters: put a partition down the middle of a
 * room and the old centroid may land in either half, or in the partition. Overlap area
 * gives the larger half the old name, which is the one a person would still call the
 * living room. The smaller half becomes a new room with a fresh name.
 *
 * Pure — no DOM, no store.
 */

import type { Floor, Id, Room, Wall } from './document';
import { DEFAULT_CEILING_HEIGHT_MM } from './document';
import { intersectionArea } from './geometry/collision';
import {
  area,
  bounds,
  boundsOverlap,
  polygon,
  signedArea,
  type Polygon,
} from './geometry/polygon';
import { distanceToSegment, type Vec2 } from './geometry/vec';

/**
 * How close two points have to be to be the same corner.
 *
 * Endpoints that were snapped together are exact, but a wall traced by hand over an
 * imported plan lands a millimetre or two out, and two nodes a millimetre apart break
 * the cycle they were meant to close. Also the reach for a T-junction: a partition
 * drawn *at* another wall rather than exactly onto its centreline still splits it.
 */
export const JOIN_TOLERANCE_MM = 20;

/**
 * Below this a face is a sliver between near-parallel walls, not a room.
 *
 * 0.01 m² — a 100mm square. Deliberately its own threshold rather than a reuse of the
 * Room tool's minimum side: that one rejects a stray click, this one rejects geometry.
 */
export const MIN_DETECTED_AREA_MM2 = 10_000;

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

type Segment = { a: Vec2; b: Vec2 };

/** Parameter along `seg` of the point on it closest to `p`, unclamped. */
function projectParam(seg: Segment, p: Vec2): number {
  const dx = seg.b.x - seg.a.x;
  const dy = seg.b.y - seg.a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / lenSq;
}

function at(seg: Segment, t: number): Vec2 {
  return { x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t };
}

function segmentLength(seg: Segment): number {
  return Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
}

/**
 * Where two segments properly cross, as a parameter on each. Null when they do not.
 *
 * Only true crossings — an intersection at either segment's endpoint is already a
 * shared node once the endpoints weld, and touching ends are the common case at every
 * corner of every room.
 */
function crossingParams(p: Segment, q: Segment): { tp: number; tq: number } | null {
  const rx = p.b.x - p.a.x;
  const ry = p.b.y - p.a.y;
  const sx = q.b.x - q.a.x;
  const sy = q.b.y - q.a.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null; // parallel or collinear — the T-junction pass covers it

  const tp = ((q.a.x - p.a.x) * sy - (q.a.y - p.a.y) * sx) / denom;
  const tq = ((q.a.x - p.a.x) * ry - (q.a.y - p.a.y) * rx) / denom;

  const edgeP = JOIN_TOLERANCE_MM / Math.max(1, segmentLength(p));
  const edgeQ = JOIN_TOLERANCE_MM / Math.max(1, segmentLength(q));
  if (tp <= edgeP || tp >= 1 - edgeP) return null;
  if (tq <= edgeQ || tq >= 1 - edgeQ) return null;
  return { tp, tq };
}

/**
 * Every wall cut at every crossing and every T-junction.
 *
 * The T-junction pass is what makes detection work on a real plan. A partition drawn
 * to butt into the middle of another wall has an endpoint on that wall's *interior*,
 * so without a node there the graph has no branch at all and the walk returns the
 * single loop around the outside — the "detection does not see my partition" report.
 */
function splitWalls(walls: readonly Wall[], tolerance: number): Segment[] {
  const segments: Segment[] = walls
    .map((w) => ({ a: w.a, b: w.b }))
    .filter((s) => segmentLength(s) > tolerance);

  const cuts: Set<number>[] = segments.map(() => new Set<number>());

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const hit = crossingParams(segments[i]!, segments[j]!);
      if (hit) {
        cuts[i]!.add(hit.tp);
        cuts[j]!.add(hit.tq);
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const edge = tolerance / Math.max(1, segmentLength(seg));
    for (let j = 0; j < segments.length; j++) {
      if (i === j) continue;
      for (const end of [segments[j]!.a, segments[j]!.b]) {
        if (distanceToSegment(end, seg.a, seg.b) > tolerance) continue;
        const t = projectParam(seg, end);
        if (t > edge && t < 1 - edge) cuts[i]!.add(t);
      }
    }
  }

  const out: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const ts = [0, ...[...cuts[i]!].sort((x, y) => x - y), 1];
    for (let k = 0; k < ts.length - 1; k++) {
      const piece = { a: at(seg, ts[k]!), b: at(seg, ts[k + 1]!) };
      if (segmentLength(piece) > tolerance) out.push(piece);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

type Graph = {
  nodes: Vec2[];
  /** Neighbours of each node, already sorted by the angle of the edge leaving it. */
  adjacency: number[][];
};

function buildGraph(segments: readonly Segment[], tolerance: number): Graph {
  const nodes: Vec2[] = [];

  const nodeAt = (p: Vec2): number => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (Math.hypot(n.x - p.x, n.y - p.y) <= tolerance) return i;
    }
    nodes.push(p);
    return nodes.length - 1;
  };

  const edges = new Set<string>();
  for (const seg of segments) {
    const u = nodeAt(seg.a);
    const v = nodeAt(seg.b);
    if (u === v) continue; // welded to nothing — a wall shorter than the tolerance
    edges.add(u < v ? `${u}:${v}` : `${v}:${u}`);
  }

  const adjacency: number[][] = nodes.map(() => []);
  for (const key of edges) {
    const [u, v] = key.split(':').map(Number) as [number, number];
    adjacency[u]!.push(v);
    adjacency[v]!.push(u);
  }

  for (let i = 0; i < nodes.length; i++) {
    const from = nodes[i]!;
    adjacency[i]!.sort(
      (a, b) =>
        Math.atan2(nodes[a]!.y - from.y, nodes[a]!.x - from.x) -
        Math.atan2(nodes[b]!.y - from.y, nodes[b]!.x - from.x),
    );
  }

  return { nodes, adjacency };
}

const TWO_PI = Math.PI * 2;

/**
 * Leaving `v` having arrived from `u`: the first edge clockwise from the way back.
 *
 * Turning back the way you came is `2π` and therefore last, so it happens only at a
 * dead end — which is right, because a spur wall is walked out and back and
 * contributes no area either way.
 */
function nextNode(graph: Graph, u: number, v: number): number {
  const from = graph.nodes[v]!;
  const back = Math.atan2(graph.nodes[u]!.y - from.y, graph.nodes[u]!.x - from.x);

  let best = u;
  let bestTurn = Infinity;
  for (const w of graph.adjacency[v]!) {
    const ang = Math.atan2(graph.nodes[w]!.y - from.y, graph.nodes[w]!.x - from.x);
    let turn = back - ang;
    while (turn <= 0) turn += TWO_PI;
    while (turn > TWO_PI) turn -= TWO_PI;
    if (turn < bestTurn) {
      bestTurn = turn;
      best = w;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

/** Drop vertices that sit on the line between their neighbours. */
function dropCollinear(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length < 4) return pts;
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length]!;
    const here = pts[i]!;
    const next = pts[(i + 1) % pts.length]!;
    if (distanceToSegment(here, prev, next) > tolerance) out.push(here);
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Rotate the ring to start at its lowest vertex, x then y.
 *
 * The walk can enter a face at any of its corners, so without this the same square
 * detected twice is two different point lists describing one shape — and re-running
 * detection would rewrite every boundary in the document with an identical one,
 * dirtying the file and costing an undo step to say nothing. `commitRoomRect` already
 * starts its rectangle at the minimum corner, so this is also what makes a drawn room
 * and its detected twin compare equal.
 */
function canonicalRing(pts: Vec2[]): Vec2[] {
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[start]!;
    if (a.x < b.x || (a.x === b.x && a.y < b.y)) start = i;
  }
  return [...pts.slice(start), ...pts.slice(0, start)];
}

export function sameRing(a: Polygon, b: Polygon): boolean {
  if (a.pts.length !== b.pts.length) return false;
  return a.pts.every((p, i) => p.x === b.pts[i]!.x && p.y === b.pts[i]!.y);
}

/**
 * Every enclosed loop in a floor's walls, as canonical counter-clockwise rings.
 *
 * Exported on its own because it is worth testing without a document around it, and
 * because the plan view may one day want to preview what detection would find.
 */
export function detectLoops(
  walls: readonly Wall[],
  tolerance = JOIN_TOLERANCE_MM,
): Polygon[] {
  const graph = buildGraph(splitWalls(walls, tolerance), tolerance);
  const seen = new Set<string>();
  const loops: Polygon[] = [];

  for (let u = 0; u < graph.nodes.length; u++) {
    for (const v0 of graph.adjacency[u]!) {
      if (seen.has(`${u}>${v0}`)) continue;

      const ring: number[] = [u];
      let a = u;
      let b = v0;
      // The walk closes on the directed edge it started from. The node bound is a
      // guard against a malformed graph, not an expected exit.
      for (let guard = 0; guard <= graph.nodes.length * 4; guard++) {
        seen.add(`${a}>${b}`);
        const c = nextNode(graph, a, b);
        if (b === u && c === v0) break;
        ring.push(b);
        a = b;
        b = c;
      }

      if (ring.length < 3) continue;
      const pts = dropCollinear(
        ring.map((i) => graph.nodes[i]!),
        tolerance,
      );
      if (pts.length < 3) continue;

      const poly = polygon(pts);
      // Interior faces wind positive under the clockwise-next rule; a component's
      // outer face is the one that comes back negative.
      if (signedArea(poly) <= 0) continue;
      if (area(poly) < MIN_DETECTED_AREA_MM2) continue;

      loops.push({ pts: canonicalRing(pts).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) });
    }
  }

  return loops;
}

// ---------------------------------------------------------------------------
// Reconciling against the rooms already there
// ---------------------------------------------------------------------------

export type RoomDetection = {
  /** Rooms whose boundary genuinely moved. Unchanged rooms are omitted, so a second run is a no-op. */
  updated: { roomId: Id; boundary: Polygon; areaMm2: number }[];
  added: Room[];
  /** Rooms no loop supports — an Area-tool room, or one whose walls were removed. Left alone. */
  unmatched: Id[];
};

export function uniqueRoomName(base: string, existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * What detection would do to a floor's rooms.
 *
 * Returns a plan rather than a new room list so the caller can apply the minimum: a
 * whole-array replacement would record a patch even when every room came back
 * identical, which is exactly the case a second run produces.
 */
export function detectRooms(
  floor: Floor,
  options: { makeId: () => Id; tolerance?: number } ,
): RoomDetection {
  const loops = detectLoops(floor.walls, options.tolerance ?? JOIN_TOLERANCE_MM);

  // Every (loop, room) pair that overlaps at all, worst case first, then claimed
  // greedily — so the larger half of a room that has just been partitioned keeps the
  // name, and the smaller half becomes a new room.
  const pairs: { loop: number; room: number; overlap: number }[] = [];
  loops.forEach((loop, li) => {
    const lb = bounds(loop);
    floor.rooms.forEach((room, ri) => {
      if (!boundsOverlap(lb, bounds(room.boundary))) return;
      const overlap = intersectionArea(loop, room.boundary);
      if (overlap > 0) pairs.push({ loop: li, room: ri, overlap });
    });
  });
  pairs.sort((x, y) => y.overlap - x.overlap);

  const loopToRoom = new Map<number, number>();
  const claimed = new Set<number>();
  for (const pair of pairs) {
    if (loopToRoom.has(pair.loop) || claimed.has(pair.room)) continue;
    loopToRoom.set(pair.loop, pair.room);
    claimed.add(pair.room);
  }

  const updated: RoomDetection['updated'] = [];
  const added: Room[] = [];
  const names = [...floor.rooms.map((r) => ({ name: r.name }))];

  loops.forEach((boundary, li) => {
    const areaMm2 = Math.round(area(boundary));
    const ri = loopToRoom.get(li);
    if (ri === undefined) {
      const name = uniqueRoomName(`Room ${names.length + 1}`, names);
      names.push({ name });
      added.push({
        id: options.makeId(),
        name,
        boundary,
        ceilingHeightMm: floor.defaultCeilingHeightMm || DEFAULT_CEILING_HEIGHT_MM,
        areaMm2,
      });
      return;
    }

    const room = floor.rooms[ri]!;
    if (sameRing(room.boundary, boundary) && room.areaMm2 === areaMm2) return;
    updated.push({ roomId: room.id, boundary, areaMm2 });
  });

  const unmatched = floor.rooms
    .filter((_, ri) => !claimed.has(ri))
    .map((r) => r.id);

  return { updated, added, unmatched };
}
