/**
 * Whether this document has unsaved changes, in a form a window shell can read.
 *
 * The desktop build asks before closing on unsaved work, and the question is asked in
 * the main process where the store does not exist. Everything else the shell needs it
 * arranges around the app; this is the one fact only the app knows.
 *
 * A property on `window` rather than an IPC bridge on purpose. It keeps the browser
 * and desktop builds the same bundle — this module runs in both and the browser simply
 * has nobody reading the flag — and it keeps the desktop window free of a preload
 * script, which is one fewer place for privilege to leak into the renderer. The shell
 * only ever reads it, so nothing here needs to be writable from outside.
 */

import { useStore } from './store';

/** The name the shell reads. Changing it means changing `desktop/main.ts` too. */
export const UNSAVED_FLAG = '__floorplanUnsaved';

let running = false;

/**
 * Begin mirroring the dirty flag. Returns a stop function.
 *
 * Idempotent for the same reason `startAutosave` is: StrictMode mounts effects twice
 * in development.
 */
export function publishUnsavedFlag(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): () => void {
  if (running) return () => undefined;
  running = true;

  target[UNSAVED_FLAG] = useStore.getState().dirty;

  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.dirty === previous.dirty) return;
    target[UNSAVED_FLAG] = state.dirty;
  });

  return () => {
    running = false;
    unsubscribe();
    delete target[UNSAVED_FLAG];
  };
}
