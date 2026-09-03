import { describe, expect, it } from 'vitest';
import { AUTOSAVE_MAX_INTERVAL_MS, AUTOSAVE_QUIET_MS, autosaveDelay } from './autosave';

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
