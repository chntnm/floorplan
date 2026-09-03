/**
 * Where Ctrl+S writes. See PLAN.md §5.
 *
 * The File System Access API hands back a *handle* the first time you pick a file, and
 * keeping it is the whole feature: the second save writes the same file with no dialog
 * and no download shelf. Everything else here exists because that handle is less
 * durable than it looks.
 *
 * ## Read the API at call time
 *
 * `supportsSaveInPlace()` looks at `window` on every call rather than snapshotting it
 * at module load. A snapshot decides for the life of the page based on whatever was
 * true during the first import, which makes the branch impossible to exercise from a
 * test — and this is a branch where the two sides behave visibly differently.
 *
 * ## A handle is session state, not document state
 *
 * It does not serialize, it does not survive a reload, and it belongs to one document.
 * So it lives here beside the asset store — the other half of the open document that
 * is deliberately not in the document — and `loadDocument`/`newDocument` clear it. A
 * handle that outlived its document would send the next Ctrl+S into the previous
 * space's file, which is a data loss with no warning and no undo.
 *
 * After a reload or a crash recovery there is no handle, so the next save asks where
 * to put it. That is correct, and it is the reason recovery does not pretend to
 * restore "the file you were working on".
 */

/**
 * Structural, rather than the DOM lib's `FileSystemFileHandle`.
 *
 * `queryPermission`/`requestPermission` are a Chromium extension to the spec and are
 * not in every `lib.dom`, so a nominal type would either fail to compile or need a
 * cast at each use. Structural also means a test fake is just an object literal.
 */
export type SaveHandle = {
  readonly name: string;
  createWritable: () => Promise<WritableTarget>;
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
};

export type WritableTarget = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type PickerOptions = {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
};

type Picker = (options: PickerOptions) => Promise<SaveHandle>;

/** Raised when the user dismisses the file picker. Not an error to report. */
export class SaveCancelled extends Error {
  constructor() {
    super('Save cancelled.');
    this.name = 'SaveCancelled';
  }
}

function picker(): Picker | null {
  if (typeof window === 'undefined') return null;
  const fn = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  return typeof fn === 'function' ? (fn.bind(window) as Picker) : null;
}

export function supportsSaveInPlace(): boolean {
  return picker() !== null;
}

let target: SaveHandle | null = null;

export function currentTarget(): SaveHandle | null {
  return target;
}

export function setSaveTarget(handle: SaveHandle | null): void {
  target = handle;
}

/** Called whenever the open document is replaced. See the note above. */
export function clearSaveTarget(): void {
  target = null;
}

/**
 * Ask where to save.
 *
 * A dismissed picker throws `AbortError`, which is a decision, not a failure — it is
 * translated to `SaveCancelled` so the caller can tell "the user changed their mind"
 * apart from "the write failed", and show a dialog for exactly one of them.
 */
export async function pickSaveTarget(suggestedName: string): Promise<SaveHandle> {
  const show = picker();
  if (!show) throw new Error('This browser cannot save in place.');

  try {
    return await show({
      suggestedName,
      types: [{ description: 'floorplan space', accept: { 'application/zip': ['.space'] } }],
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new SaveCancelled();
    throw err;
  }
}

/**
 * Whether this handle may still be written to.
 *
 * A permission granted in one session is not carried into the next, and can be revoked
 * mid-session from the omnibox. Asking first turns a silent failure deep inside
 * `createWritable` into a prompt the user recognises. A handle that predates the
 * Chromium permission extension has neither method, and is taken at its word.
 */
export async function ensureWritable(handle: SaveHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;

  const descriptor = { mode: 'readwrite' } as const;
  if ((await handle.queryPermission(descriptor)) === 'granted') return true;
  return (await handle.requestPermission(descriptor)) === 'granted';
}

/**
 * Write bytes through a handle.
 *
 * `bytes.slice()` because `bytes.buffer` may be a pooled ArrayBuffer larger than the
 * data — the same reason the download path slices. A padded `.space` is a corrupt zip.
 */
export async function writeToTarget(handle: SaveHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([bytes.slice()], { type: 'application/zip' }));
  } finally {
    // Always close: an open writable holds a `.crswap` temp file next to the real one.
    await writable.close();
  }
}
