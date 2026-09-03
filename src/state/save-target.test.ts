import { afterEach, describe, expect, it } from 'vitest';
import {
  SaveCancelled,
  clearSaveTarget,
  currentTarget,
  ensureWritable,
  pickSaveTarget,
  setSaveTarget,
  supportsSaveInPlace,
  writeToTarget,
  type SaveHandle,
} from './save-target';

/**
 * `window` does not exist in the node test environment, so these cases install one.
 * That is only possible because `supportsSaveInPlace` reads the global at call time —
 * the property under test as much as anything below it.
 */
function withWindow(props: Record<string, unknown>): void {
  (globalThis as { window?: unknown }).window = props;
}

function noWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}

type FakeHandle = SaveHandle & { written: Blob[]; closed: number };

function handle(over: Partial<SaveHandle> = {}): FakeHandle {
  const written: Blob[] = [];
  const fake = {
    name: 'plan.space',
    written,
    closed: 0,
    createWritable: () =>
      Promise.resolve({
        write: (data: Blob) => {
          written.push(data);
          return Promise.resolve();
        },
        close: () => {
          fake.closed++;
          return Promise.resolve();
        },
      }),
    ...over,
  } as FakeHandle;
  return fake;
}

afterEach(() => {
  noWindow();
  clearSaveTarget();
});

describe('whether this browser can save in place', () => {
  it('says no when there is no picker', () => {
    withWindow({});
    expect(supportsSaveInPlace()).toBe(false);
  });

  it('says yes once one appears', () => {
    // Read at call time, not captured at import. A module-level snapshot would decide
    // this for the life of the page from whatever was true during the first import,
    // and no test — or `addInitScript` stub — could ever reach the other branch.
    withWindow({});
    expect(supportsSaveInPlace()).toBe(false);
    withWindow({ showSaveFilePicker: () => Promise.resolve(handle()) });
    expect(supportsSaveInPlace()).toBe(true);
  });

  it('says no when there is no window at all', () => {
    noWindow();
    expect(supportsSaveInPlace()).toBe(false);
  });
});

describe('picking a file', () => {
  it('passes the suggested name through', async () => {
    let seen: unknown;
    withWindow({
      showSaveFilePicker: (options: unknown) => {
        seen = options;
        return Promise.resolve(handle());
      },
    });

    await pickSaveTarget('apartment.space');
    expect(seen).toMatchObject({ suggestedName: 'apartment.space' });
  });

  it('turns a dismissed dialog into SaveCancelled, not a failure', async () => {
    // Chromium throws `AbortError` when the picker is dismissed. Reported as an error
    // it becomes an alert saying the save failed, on a save the user chose not to
    // make — and, worse, it is indistinguishable from a real write failure.
    const abort = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
    withWindow({ showSaveFilePicker: () => Promise.reject(abort) });

    await expect(pickSaveTarget('a.space')).rejects.toBeInstanceOf(SaveCancelled);
  });

  it('lets a real failure through as itself', async () => {
    const boom = new Error('disk on fire');
    withWindow({ showSaveFilePicker: () => Promise.reject(boom) });

    await expect(pickSaveTarget('a.space')).rejects.toBe(boom);
  });
});

describe('permission on a retained handle', () => {
  it('writes without asking when permission is already granted', async () => {
    let asked = 0;
    const h = handle({
      queryPermission: () => Promise.resolve('granted'),
      requestPermission: () => {
        asked++;
        return Promise.resolve('granted');
      },
    });

    expect(await ensureWritable(h)).toBe(true);
    expect(asked).toBe(0);
  });

  it('asks when permission has lapsed', async () => {
    // A handle carried across a reload, or revoked from the omnibox mid-session.
    // Without this the failure surfaces from inside `createWritable`, as a stack
    // trace rather than as the prompt the user actually recognises.
    const h = handle({
      queryPermission: () => Promise.resolve('prompt'),
      requestPermission: () => Promise.resolve('granted'),
    });
    expect(await ensureWritable(h)).toBe(true);
  });

  it('reports a refusal rather than trying anyway', async () => {
    const h = handle({
      queryPermission: () => Promise.resolve('prompt'),
      requestPermission: () => Promise.resolve('denied'),
    });
    expect(await ensureWritable(h)).toBe(false);
  });

  it('takes a handle with no permission methods at its word', async () => {
    expect(await ensureWritable(handle())).toBe(true);
  });
});

describe('writing', () => {
  it('writes the bytes and closes the stream', async () => {
    const h = handle();
    await writeToTarget(h, new Uint8Array([1, 2, 3]));

    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.size).toBe(3);
    expect(h.closed).toBe(1);
  });

  it('writes only its own bytes out of a pooled buffer', async () => {
    // `Uint8Array#subarray` shares the backing store. Handing the view straight to a
    // Blob writes the whole buffer, and a padded zip is a corrupt `.space`.
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const h = handle();
    await writeToTarget(h, pool.subarray(2, 5));

    expect(h.written[0]?.size).toBe(3);
  });

  it('closes the stream even when the write fails', async () => {
    // An unclosed writable leaves a `.crswap` temp file sitting next to the real one.
    const h = handle();
    h.createWritable = () =>
      Promise.resolve({
        write: () => Promise.reject(new Error('quota')),
        close: () => {
          h.closed++;
          return Promise.resolve();
        },
      });

    await expect(writeToTarget(h, new Uint8Array([1]))).rejects.toThrow('quota');
    expect(h.closed).toBe(1);
  });
});

describe('the handle belongs to one document', () => {
  it('is held between saves', () => {
    const h = handle();
    setSaveTarget(h);
    expect(currentTarget()).toBe(h);
  });

  it('is dropped when the document is replaced', () => {
    // A handle that outlived its document sends the next Ctrl+S into the previous
    // space's file. There is no warning for that and no undo.
    setSaveTarget(handle());
    clearSaveTarget();
    expect(currentTarget()).toBeNull();
  });
});
