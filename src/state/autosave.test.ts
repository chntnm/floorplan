import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_MAX_INTERVAL_MS,
  AUTOSAVE_QUIET_MS,
  autosaveDelay,
  resetAutosaveTiming,
  startAutosave,
} from './autosave';
import { useStore } from './store';

const writes = vi.hoisted(() => ({ count: 0 }));

vi.mock('./autosave-db', () => ({
  writeAutosave: () => {
    writes.count++;
    return Promise.resolve(true);
  },
  dropAutosave: () => Promise.resolve(true),
}));

/**
 * §5 asks for "every 20s **and** on every meaningful mutation". Taken literally those
 * are two schedules, one of which writes on every frame of a wall drag. `autosaveDelay`
 * is the reading that satisfies both: a quiet debounce with a hard deadline.
 */
describe('when the next autosave runs', () => {
  it('waits for the user to stop, not for the interval', () => {
    // One edit, then nothing. Twenty seconds of exposure for a two-second wait is a
    // bad trade, and the deadline is not the point of the debounce.
    const now = 100_000;
    expect(autosaveDelay(now, now)).toBe(AUTOSAVE_QUIET_MS);
  });

  it('does not let continuous activity postpone it forever', () => {
    // A drag reschedules on every mousemove. A pure debounce would then never fire
    // while the user keeps working — which is precisely when there is most to lose.
    const lastWrite = 0;
    const now = AUTOSAVE_MAX_INTERVAL_MS - 500;
    expect(autosaveDelay(now, lastWrite)).toBe(500);
  });

  it('fires immediately once the deadline has passed', () => {
    expect(autosaveDelay(AUTOSAVE_MAX_INTERVAL_MS + 5_000, 0)).toBe(0);
  });

  it('never returns a negative delay', () => {
    // `setTimeout` would treat one as zero anyway; stated rather than relied upon.
    expect(autosaveDelay(1_000_000, 0)).toBeGreaterThanOrEqual(0);
  });

  it('is bounded by the quiet period and the deadline, whatever the inputs', () => {
    for (let elapsed = 0; elapsed <= AUTOSAVE_MAX_INTERVAL_MS + 5_000; elapsed += 250) {
      const delay = autosaveDelay(elapsed, 0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(AUTOSAVE_QUIET_MS);
      // The invariant that matters: a write lands by the deadline, or at once if the
      // deadline has already gone by.
      if (elapsed >= AUTOSAVE_MAX_INTERVAL_MS) expect(delay).toBe(0);
      else expect(elapsed + delay).toBeLessThanOrEqual(AUTOSAVE_MAX_INTERVAL_MS);
    }
  });
});

/**
 * The scheduling rule, wired up.
 *
 * `autosaveDelay` can be exhaustively correct while nothing ever hands it the input it
 * is proudest of. An earlier version of `schedule()` left a pending timer standing
 * instead of re-arming it, so the deadline term never bound and the whole thing was a
 * two-second throttle — with every delay it returned still individually correct.
 *
 * So the assertion here is a **count of writes under sustained change**, which is the
 * only thing the two behaviours disagree about.
 */
describe('the schedule, driven', () => {
  let stop: () => void;

  beforeEach(() => {
    writes.count = 0;
    resetAutosaveTiming();
    vi.useFakeTimers();
    useStore.getState().newDocument();
    stop = startAutosave();
  });

  afterEach(() => {
    stop();
    resetAutosaveTiming();
    vi.useRealTimers();
  });

  /** One ordinary document change. */
  function touch(n: number): void {
    useStore.getState().mutate('Grid', (draft) => {
      draft.gridMm = n;
    });
  }

  it('writes once, shortly after a single edit stops', async () => {
    touch(10);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_QUIET_MS - 100);
    expect(writes.count).toBe(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(writes.count).toBe(1);
  });

  it('does not write again while nothing changes', async () => {
    touch(10);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_INTERVAL_MS * 3);
    expect(writes.count).toBe(1);
  });

  it('writes once at the deadline, not every quiet period, under sustained change', async () => {
    // A slider sweep: `mutate` coalesces the history entry but still produces a new
    // document on every input event. With the debounce re-armed each time, the only
    // thing that can fire is the deadline.
    for (let elapsed = 0; elapsed < AUTOSAVE_MAX_INTERVAL_MS - 500; elapsed += 100) {
      touch(10 + (elapsed % 7));
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(writes.count).toBe(0);

    await vi.advanceTimersByTimeAsync(600);
    expect(writes.count).toBe(1);
  });

  it('stops writing once the document is saved', async () => {
    touch(10);
    useStore.getState().markSaved();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_INTERVAL_MS * 2);
    // Re-checked at fire time, not only when scheduled: a save landing inside the
    // debounce window would otherwise write a record for a document now on disk, and
    // a surviving record is supposed to mean there is unsaved work.
    expect(writes.count).toBe(0);
  });
});
