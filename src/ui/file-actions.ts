/**
 * What happens to a file, once something has one.
 *
 * The button in the top bar and the window drop target hand files to the same two
 * functions, so a dropped `.space` and a picked one cannot come to differ in what
 * they load, what they clear, or what they say when the file is bad.
 *
 * Routing is by extension rather than by content. A `.space` is a zip and so is a
 * `.docx`; sniffing would tell them apart, but the honest signal for "the user meant
 * this to be a space" is what they named it. Everything else goes to the plan
 * importer, which sniffs properly and refuses what it cannot read.
 */

import { SPACE_EXTENSION, openDocumentFile } from './file-io';
import { beginImport } from './import/plan-import';
import { useStore } from '../state/store';

export function isSpaceFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(SPACE_EXTENSION);
}

/**
 * Open a `.space`, replacing what is loaded.
 *
 * A bad file is the user's problem to fix, not a crash to swallow: say what went
 * wrong and leave the document they already have untouched.
 */
export async function openSpace(file: File): Promise<void> {
  try {
    // The assets travel with the document into the runtime store; passing only
    // `.document` here is what made a reopened background render as nothing.
    const bundle = await openDocumentFile(file);
    useStore.getState().loadDocument(bundle.document, bundle.assets);
    useStore.getState().zoomToFit();
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'Could not open that file.');
  }
}

/** Import a floor plan (PDF or image), opening the calibration gate. */
export async function importPlan(file: File): Promise<void> {
  try {
    await beginImport(file);
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'That file could not be imported.');
  }
}

/** Route a file by what it is called. */
export async function acceptFile(file: File): Promise<void> {
  return isSpaceFile(file) ? openSpace(file) : importPlan(file);
}
