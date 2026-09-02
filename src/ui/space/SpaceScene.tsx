import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { SceneModel, SceneSolid } from '../../core/scene';
import type { SelectionRef } from '../../state/store';
import { UPRIGHT, extrudePolygon, extrudeSlab } from './geometry';

type Props = {
  scene: SceneModel;
  selection: SelectionRef[];
  showCeilings: boolean;
  onSelect: (ref: SelectionRef, additive: boolean) => void;
};

const SELECTED_COLOR = '#2f6fed';

/**
 * The meshes.
 *
 * Geometry is rebuilt only when the scene model changes — which, because the scene is
 * derived from a document zustand replaces wholesale on every edit, means once per
 * edit rather than once per frame. Old geometries are disposed on the way out; three
 * allocates GPU buffers that React knows nothing about and will not collect.
 *
 * **Instancing is deliberately not done here.** PLAN.md §10.4 targets 500 placements
 * at 60fps with repeated catalog items merged into single draw calls; this draws one
 * mesh per solid. That is honest about what has been built rather than claiming a
 * number nothing has measured, and the seam for instancing — a scene model that
 * already groups by catalog item — is unchanged by it.
 */
export function SpaceScene({ scene, selection, showCeilings, onSelect }: Props) {
  const solids = useMemo(
    () => scene.solids.map((solid) => ({ solid, geometry: extrudePolygon(solid.outline, solid.span) })),
    [scene],
  );

  const slabs = useMemo(
    () =>
      scene.slabs.map((slab) => ({
        slab,
        geometry: extrudeSlab(slab.boundary, slab.elevationMm),
      })),
    [scene],
  );

  useEffect(() => {
    return () => {
      for (const { geometry } of solids) geometry.dispose();
      for (const { geometry } of slabs) geometry.dispose();
    };
  }, [solids, slabs]);

  const isSelected = (solid: SceneSolid) =>
    selection.some((s) => s.kind === solid.ref.kind && s.id === solid.ref.id);

  return (
    <>
      {/* Flat, soft light. A single directional source leaves whole walls black at
          the angles a room is actually viewed from. */}
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 10, 6]} intensity={1.5} />
      <directionalLight position={[-6, 6, -4]} intensity={0.6} />

      {slabs.map(({ slab, geometry }) =>
        slab.kind === 'ceiling' && !showCeilings ? null : (
          <mesh key={slab.id} geometry={geometry} rotation={UPRIGHT} receiveShadow={false}>
            <meshLambertMaterial color={slab.color} side={THREE.DoubleSide} />
          </mesh>
        ),
      )}

      {solids.map(({ solid, geometry }) => (
        <mesh
          key={solid.id}
          geometry={geometry}
          rotation={UPRIGHT}
          onClick={(e) => {
            // Only the nearest hit: without this a click passes through a wall and
            // selects everything behind it as well.
            e.stopPropagation();
            onSelect({ kind: solid.ref.kind, id: solid.ref.id }, e.nativeEvent.shiftKey);
          }}
        >
          <meshLambertMaterial color={isSelected(solid) ? SELECTED_COLOR : solid.color} />
        </mesh>
      ))}
    </>
  );
}
