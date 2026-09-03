import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { Bounds } from '../../core/geometry/polygon';
import { docToThree } from '../../core/units';
import { eyePosition, lookTarget, type CameraMode } from '../../core/walk';
import type { SpaceCamera } from '../../core/views';
import { useStore } from '../../state/store';

type Props = {
  mode: CameraMode;
  bounds: Bounds | null;
  ceilingHeightMm: number;
  /** Written every frame so the HUD can bookmark wherever the camera actually is. */
  poseRef: RefObject<SpaceCamera | null>;
};

/**
 * The camera, in all three modes.
 *
 * In walk and fly it is a **consumer** of the walker: `useFrame` reads the store
 * imperatively and writes the camera, with no React subscription and therefore no
 * re-render per frame. The walk simulation itself is elsewhere (`useWalkLoop`), which
 * is what lets traversal keep working when this component never mounts because there
 * is no WebGL context.
 *
 * In orbit, drei's controls own the camera and this only frames the scene on entry.
 */
export function CameraRig({ mode, bounds, ceilingHeightMm, poseRef }: Props) {
  const camera = useThree((s) => s.camera);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const orbiting = mode === 'orbit';

  // Frame the whole floor when orbit is entered. Only on entry: doing it per render
  // would snap the camera back every time anything in the document changed.
  useEffect(() => {
    if (!orbiting) return;
    const framing = frameBounds(bounds, ceilingHeightMm);
    camera.position.set(framing.position.x, framing.position.y, framing.position.z);
    controls.current?.target.set(framing.target.x, framing.target.y, framing.target.z);
    controls.current?.update();
  }, [orbiting, bounds, ceilingHeightMm, camera]);

  useFrame(() => {
    const store = useStore.getState();

    // A bookmark being applied. One-shot: adopting it and clearing it is what keeps
    // the next orbit drag from fighting a value that would otherwise be reasserted.
    const pending = store.pendingCamera;
    if (pending) {
      const p = docToThree(pending.position);
      const t = docToThree(pending.target);
      camera.position.set(p.x, p.y, p.z);
      camera.lookAt(t.x, t.y, t.z);
      controls.current?.target.set(t.x, t.y, t.z);
      controls.current?.update();
      store.setPendingCamera(null);
    }

    if (store.cameraMode !== 'orbit' && store.walker) {
      const eye = docToThree(eyePosition(store.walker));
      const at = docToThree(lookTarget(store.walker));
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(at.x, at.y, at.z);
    }

    // Reported in document millimetres, so a saved view is expressed in the same
    // units as everything else in the file and does not depend on the renderer.
    poseRef.current = {
      position: threeToDocPoint(camera.position),
      target:
        store.cameraMode === 'orbit' && controls.current
          ? threeToDocPoint(controls.current.target)
          : store.walker
            ? lookTarget(store.walker)
            : threeToDocPoint(camera.position),
      mode: store.cameraMode,
    };
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={orbiting}
      enableDamping
      dampingFactor={0.12}
      maxPolarAngle={Math.PI / 2}
    />
  );
}

function threeToDocPoint(v: { x: number; y: number; z: number }) {
  // The inverse of `docToThree`, without the millimetre rounding `threeToDoc` applies
  // — a camera is not document geometry and does not want to be snapped to a grid.
  return { x: v.x * 1000, y: v.z * 1000, z: v.y * 1000 };
}

/**
 * A three-quarter view that contains the whole floor.
 *
 * Sized from the diagonal rather than from either side, so a long thin corridor is
 * framed by its length and not cropped by its width.
 */
function frameBounds(bounds: Bounds | null, ceilingHeightMm: number) {
  if (!bounds) {
    return {
      position: { x: 6, y: 6, z: 6 },
      target: { x: 0, y: ceilingHeightMm / 2000, z: 0 },
    };
  }
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const diagonal = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const distance = Math.max(diagonal, 3000) * 0.9;

  const target = docToThree({ x: cx, y: cy, z: ceilingHeightMm / 2 });
  const eye = docToThree({
    x: cx - distance * 0.4,
    y: cy + distance,
    z: ceilingHeightMm / 2 + distance * 0.8,
  });
  return { position: eye, target };
}
