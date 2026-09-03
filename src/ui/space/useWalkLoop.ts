import { useEffect, useRef } from 'react';
import { useStore } from '../../state/store';
import { activeFloor } from '../../state/store';
import { defaultStandpoint } from '../../core/scene';
import { createWalker, stepWalker, type CameraMode, type WalkInput } from '../../core/walk';
import { blockersFor, sceneFor } from './scene-cache';

/**
 * The traversal loop — and it deliberately does **not** live inside three.js.
 *
 * `useFrame` would be the obvious home for this, and it is the wrong one. Putting the
 * walk simulation inside the render loop makes walking a thing that only happens when
 * a WebGL context exists: no context, no movement, and no way to test traversal
 * without a GPU. Here it is a plain `requestAnimationFrame` over pure functions, so
 * the camera is a *consumer* of the walker rather than its owner, the position
 * readout keeps working when the canvas does not, and an end-to-end test can press
 * ArrowUp and assert the walker moved.
 *
 * The store is written to only while a key is held. An idle walker produces no
 * updates at all, so nothing subscribed to the walker re-renders while you are
 * standing still.
 */

function readInput(held: ReadonlySet<string>, mode: CameraMode): WalkInput {
  const on = (...keys: string[]) => keys.some((k) => held.has(k));
  const axis = (positive: string[], negative: string[]) =>
    (on(...positive) ? 1 : 0) - (on(...negative) ? 1 : 0);

  return {
    forward: axis(['arrowup', 'w'], ['arrowdown', 's']),
    strafe: axis(['d'], ['a']),
    // Arrow left/right **turn**, which PLAN.md §10.2 assigned to strafing. Someone
    // using only the arrow keys — which is the stated requirement — could otherwise
    // never change direction, and would be stuck sliding along one axis forever.
    // A and D strafe instead; Q and E also turn, for anyone who learned it that way.
    turn: axis(['arrowright', 'e'], ['arrowleft', 'q']),
    run: on('shift'),
    crouch: on('c'),
    stepUp: on(' '),
    rise: mode === 'fly' ? axis(['r'], ['f']) : 0,
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

const MOVEMENT_KEYS = new Set([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'w',
  'a',
  's',
  'd',
  'q',
  'e',
  'r',
  'f',
  'c',
  ' ',
  'shift',
]);

export function useWalkLoop(active: boolean): void {
  const held = useRef<Set<string>>(new Set());
  const frame = useRef(0);
  const last = useRef(0);

  useEffect(() => {
    if (!active) {
      held.current.clear();
      return;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();

      if (key === 'tab') {
        e.preventDefault();
        const store = useStore.getState();
        const order: CameraMode[] = ['orbit', 'walk', 'fly'];
        const next = order[(order.indexOf(store.cameraMode) + 1) % order.length]!;
        store.setCameraMode(next);
        return;
      }
      if (!MOVEMENT_KEYS.has(key)) return;
      // Arrows and space scroll the page; a walker who scrolls the app away while
      // walking forward is not walking anywhere.
      e.preventDefault();
      held.current.add(key);
    };

    const onKeyUp = (e: KeyboardEvent) => held.current.delete(e.key.toLowerCase());
    // A window that loses focus never delivers the keyup, leaving the walker
    // sprinting into a wall until something else is pressed.
    const onBlur = () => held.current.clear();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    last.current = performance.now();

    const tick = (now: number) => {
      frame.current = requestAnimationFrame(tick);
      const dt = (now - last.current) / 1000;
      last.current = now;

      const store = useStore.getState();
      if (store.cameraMode === 'orbit') return;

      const input = readInput(held.current, store.cameraMode);
      const idle =
        input.forward === 0 &&
        input.strafe === 0 &&
        input.turn === 0 &&
        input.rise === 0 &&
        input.crouch === (store.walker?.crouching ?? false);
      if (idle && store.walker) return;

      const floor = activeFloor(store);
      // Cached on the document's identity, so a frame of walking costs a lookup
      // rather than a rebuild of every wall segment in the room.
      const walker =
        store.walker ?? createWalker(defaultStandpoint(floor, sceneFor(store.doc, floor)));

      store.setWalker(
        stepWalker(walker, input, dt, {
          blockers: blockersFor(store.doc, floor),
          mode: store.cameraMode,
        }),
      );
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [active]);
}
