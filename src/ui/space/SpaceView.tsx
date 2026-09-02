import { Component, useRef, type ErrorInfo, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { useShallow } from 'zustand/react/shallow';
import { look } from '../../core/walk';
import type { SpaceCamera } from '../../core/views';
import { activeFloor, useStore, type SelectionRef } from '../../state/store';
import { sceneFor } from './scene-cache';
import { CameraRig } from './CameraRig';
import { SpaceHud } from './SpaceHud';
import { SpaceScene } from './SpaceScene';
import { useWalkLoop } from './useWalkLoop';

/** Degrees of rotation per pixel dragged. Slow enough to aim, fast enough to turn. */
const LOOK_SENSITIVITY = 0.22;

/** Movement under this is a click, not a drag — so looking around does not select. */
const DRAG_THRESHOLD_PX = 4;

/**
 * A WebGL context can fail to come up — a blocklisted driver, a headless browser, a
 * tab that has run out of contexts — and React Three Fiber signals that by throwing
 * during render. Without a boundary that takes down the whole application, including
 * the plan view, which is still perfectly usable.
 */
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('3D view failed to start', error, info);
  }

  override render() {
    if (this.state.failed) {
      return (
        <div className="viewport__placeholder" data-testid="space-unavailable">
          <p className="viewport__title">3D is unavailable here</p>
          <p className="viewport__sub">
            This browser could not start WebGL. The plan view and everything in it still
            works, and the readout below still tracks where you are walking.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * The 3D space view (PLAN.md §10).
 *
 * The layering is the point: the walk loop and the HUD sit *outside* the canvas
 * boundary, so traversal, the position readout and the saved-view list all work when
 * the renderer does not. The camera consumes the walker; it never owns it.
 */
export function SpaceView() {
  const { doc, cameraMode, selection, showCeilings } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      cameraMode: s.cameraMode,
      selection: s.selection,
      showCeilings: s.showCeilings,
    })),
  );

  const poseRef = useRef<SpaceCamera | null>(null);
  const drag = useRef<{ active: boolean; x: number; y: number; moved: number }>({
    active: false,
    x: 0,
    y: 0,
    moved: 0,
  });

  useWalkLoop(true);

  const floor = activeFloor({ doc });
  const scene = sceneFor(doc, floor);

  const onPointerDown = (e: React.PointerEvent) => {
    if (cameraMode === 'orbit' || e.button !== 0) return;
    drag.current = { active: true, x: e.clientX, y: e.clientY, moved: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = {
      active: true,
      x: e.clientX,
      y: e.clientY,
      moved: drag.current.moved + Math.abs(dx) + Math.abs(dy),
    };

    const store = useStore.getState();
    if (!store.walker) return;
    // Dragging right turns right, dragging up looks up — the direction the scene
    // moves under the pointer, which is what a first-person view has always done.
    store.setWalker(look(store.walker, dx * LOOK_SENSITIVITY, -dy * LOOK_SENSITIVITY));
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = { ...drag.current, active: false };
  };

  const select = (ref: SelectionRef, additive: boolean) => {
    // A drag that happened to end on a mesh was a look, not a click. Without this,
    // turning around selects whatever you happened to finish facing.
    if (drag.current.moved > DRAG_THRESHOLD_PX) return;
    const store = useStore.getState();
    if (additive) store.toggleSelection(ref);
    else store.setSelection([ref]);
  };

  return (
    <div className="space" data-testid="space-view" data-mode={cameraMode}>
      <div
        className="space__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <CanvasBoundary>
          <Canvas camera={{ fov: 65, near: 0.05, far: 500, position: [6, 6, 6] }}>
            <color attach="background" args={['#e8eaee']} />
            <CameraRig
              mode={cameraMode}
              bounds={scene.bounds}
              ceilingHeightMm={scene.ceilingHeightMm}
              poseRef={poseRef}
            />
            <SpaceScene
              scene={scene}
              selection={selection}
              showCeilings={showCeilings}
              onSelect={select}
            />
          </Canvas>
        </CanvasBoundary>
      </div>

      <SpaceHud poseRef={poseRef} />
    </div>
  );
}
