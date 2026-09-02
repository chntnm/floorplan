import * as THREE from 'three';
import type { Polygon } from '../../core/geometry/polygon';
import type { Span } from '../../core/geometry/collision';

/**
 * Document polygons to three.js geometry — the one place the axis swap happens.
 *
 * Document space is `x` east, `y` south, `z` up, in millimetres. three.js is Y-up in
 * metres. `docToThree` states the mapping; this builds geometry that obeys it.
 *
 * `THREE.Shape` is always in the XY plane and `ExtrudeGeometry` always extrudes along
 * local +z, so the mesh has to be turned to stand up. Rotating −90° about X sends
 * local `(u, v, w)` to world `(u, w, −v)`: the extrusion becomes height, and the
 * shape's `v` becomes world `−z`. Feeding the shape `−y` therefore lands document `y`
 * on world `z` the right way round — **not** mirrored, which is the failure mode this
 * is easy to ship with, because a mirrored room looks perfectly plausible until you
 * notice the door is on the wrong side.
 *
 * The negated `v` also reverses the ring's winding, which earcut handles either way;
 * `ExtrudeGeometry` computes its own normals, so nothing downstream depends on it.
 */

const MM = 0.001;

export function shapeFromPolygon(poly: Polygon): THREE.Shape {
  const shape = new THREE.Shape();
  const pts = poly.pts;
  const first = pts[0]!;
  shape.moveTo(first.x * MM, -first.y * MM);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    shape.lineTo(p.x * MM, -p.y * MM);
  }
  shape.closePath();
  return shape;
}

/**
 * A polygon extruded between two elevations, positioned in world space.
 *
 * The geometry is translated so the mesh can sit at the origin with a fixed rotation
 * — one `rotation` value shared by every solid, rather than a transform per mesh that
 * has to be got right in three places.
 */
export function extrudePolygon(poly: Polygon, span: Span): THREE.ExtrudeGeometry {
  const height = Math.max(span.top - span.bottom, 1) * MM;
  const geometry = new THREE.ExtrudeGeometry(shapeFromPolygon(poly), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1,
  });
  // Local +z becomes world +y after the shared rotation, so shifting along local z
  // is what lifts the box to its elevation.
  geometry.translate(0, 0, span.bottom * MM);
  return geometry;
}

/** The rotation every extruded solid shares. See the module comment. */
export const UPRIGHT: [number, number, number] = [-Math.PI / 2, 0, 0];

/** A flat slab — a room floor or ceiling — as a thin extrusion. */
export function extrudeSlab(poly: Polygon, elevationMm: number, thicknessMm = 20): THREE.ExtrudeGeometry {
  return extrudePolygon(poly, { bottom: elevationMm - thicknessMm, top: elevationMm });
}
