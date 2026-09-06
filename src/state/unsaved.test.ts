import { afterEach, describe, expect, it } from 'vitest';
import { UNSAVED_FLAG, publishUnsavedFlag } from './unsaved';
import { useStore } from './store';

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  useStore.getState().newDocument();
});

describe('the unsaved flag the desktop shell reads', () => {
  it('is published before anything changes', () => {
    // The window can be closed one second after launch. A flag that only appears
    // after the first edit reads as `undefined`, which the shell treats as clean —
    // correct here by luck, and wrong the moment the initial state is dirty.
    const target: Record<string, unknown> = {};
    stop = publishUnsavedFlag(target);
    expect(target[UNSAVED_FLAG]).toBe(false);
  });

  it('follows the document into and out of dirty', () => {
    const target: Record<string, unknown> = {};
    stop = publishUnsavedFlag(target);

    useStore.getState().mutate('rename', (d) => {
      d.title = 'a change';
    });
    expect(target[UNSAVED_FLAG]).toBe(true);

    useStore.getState().markSaved();
    expect(target[UNSAVED_FLAG]).toBe(false);
  });

  it('stops mirroring once stopped, and leaves nothing behind', () => {
    // A stale `true` outlives the subscription as a window that will not close
    // without an argument.
    const target: Record<string, unknown> = {};
    const end = publishUnsavedFlag(target);
    end();

    useStore.getState().mutate('rename', (d) => {
      d.title = 'a change';
    });
    expect(UNSAVED_FLAG in target).toBe(false);
  });
});
