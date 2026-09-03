/**
 * When the autosave runs. See PLAN.md §5.
 *
 * §5 asks for "every 20s **and** on every meaningful mutation", which as written are
 * two different schedules — one of them writes a megabyte-class record on every
 * mousemove of a wall drag. The reading that satisfies both without that is a debounce
 * with a deadline:
 *
 *   - **quiet** — two seconds after the last change, so a single edit is protected
 *     almost immediately rather than up to twenty seconds later.
 *   - **deadline** — never longer than twenty seconds since the last write, so a
 *     continuous drag cannot postpone the autosave indefinitely by resetting the
 *     debounce on every frame.
 *
 * `autosaveDelay` is that rule, pure and tested. Everything below it is a timer and a
 * store subscription.
 */

import { useStore } from './store';
import { allAssets } from './assets';
import { dropAutosave, writeAutosave } from './autosave-db';

/** Longest a change may go unwritten. */
export const AUTOSAVE_MAX_INTERVAL_MS = 20_000;
/** How long after the last change a quiet document is written. */
export const AUTOSAVE_QUIET_MS = 2_000;

/**
 * How long to wait before writing, given when the last write happened.
 *
 * The `min` is the deadline: as `now` approaches `lastWriteAt + MAX` the second term
 * shrinks past the quiet period and finally to zero, so continuous activity gets a
 * write every `MAX` rather than none at all. The `max` keeps an overdue write at zero
 * instead of a negative delay, which `setTimeout` would silently treat as zero anyway
 * — stated rather than relied on.
 */
export function autosaveDelay(
  now: number,
  lastWriteAt: number,
  quietMs = AUTOSAVE_QUIET_MS,
  maxMs = AUTOSAVE_MAX_INTERVAL_MS,
): number {
  return Math.max(0, Math.min(quietMs, lastWriteAt + maxMs - now));
}

let timer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = 0;
let running = false;

function cancel(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function write(): Promise<void> {
  timer = null;
  const { doc, dirty } = useStore.getState();
  // Re-checked at fire time, not only at schedule time: a save landing during the
  // debounce window would otherwise write a record for a document that is now on
  // disk, and the recovery prompt exists to mean "there is unsaved work".
  if (!dirty) return;

  lastWriteAt = Date.now();
  await writeAutosave(doc, allAssets());
}

function schedule(): void {
  if (timer !== null) return;
  const delay = autosaveDelay(Date.now(), lastWriteAt);
  timer = setTimeout(() => void write(), delay);
}

/**
 * Begin autosaving the open document. Returns a stop function.
 *
 * Idempotent, because React 19's StrictMode mounts effects twice in development and a
 * second subscription would double every write.
 */
export function startAutosave(): () => void {
  if (running) return () => undefined;
  running = true;
  lastWriteAt = Date.now();

  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.doc === previous.doc && state.dirty === previous.dirty) return;
    if (state.dirty) schedule();
    else cancel();
  });

  return () => {
    running = false;
    cancel();
    unsubscribe();
  };
}

/**
 * Forget the autosave for a document that has just been written to a file.
 *
 * This rule is what keeps the recovery prompt worth reading: a surviving record means
 * that document had unsaved changes when the tab went away. Without it every clean
 * reload would offer to recover work already saved, and the prompt would be trained
 * out of the user long before the one time it mattered.
 */
export function forgetAutosave(documentId: string): void {
  cancel();
  lastWriteAt = Date.now();
  void dropAutosave(documentId);
}

/** Test seam — resets the module's timing state between cases. */
export function resetAutosaveTiming(): void {
  cancel();
  running = false;
  lastWriteAt = 0;
}
