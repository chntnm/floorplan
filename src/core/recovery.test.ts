import { describe, expect, it } from 'vitest';
import {
  chooseRecovery,
  isUntouched,
  recoveryMessage,
  type AutosaveSummary,
} from './recovery';
import { createDocument, type SpaceDocument } from './document';
import { polygon } from './geometry/polygon';

function doc(over: Partial<SpaceDocument> = {}): SpaceDocument {
  return {
    ...createDocument({ id: 'doc-a', floorId: 'ground', now: '2026-01-01T00:00:00.000Z' }),
    ...over,
  };
}

function record(over: Partial<AutosaveSummary> = {}): AutosaveSummary {
  return {
    documentId: 'doc-a',
    title: 'Apartment',
    savedAt: '2026-01-01T12:00:00.000Z',
    modifiedAt: '2026-01-01T12:00:00.000Z',
    ...over,
  };
}

describe('is there anything here to lose', () => {
  it('a fresh document holds nothing', () => {
    expect(isUntouched(doc())).toBe(true);
  });

  it('a renamed empty document still holds nothing', () => {
    // Otherwise someone who typed a name and then crashed is refused their own work
    // back, because naming an empty space counted as content.
    expect(isUntouched(doc({ title: 'The new flat' }))).toBe(true);
  });

  it('one wall is content', () => {
    const d = doc();
    d.floors[0]!.walls.push({
      id: 'w',
      a: { x: 0, y: 0 },
      b: { x: 1000, y: 0 },
      thicknessMm: 114,
      heightMm: 2438,
      baseElevationMm: 0,
    });
    expect(isUntouched(d)).toBe(false);
  });

  it('a room drawn with the area tool is content, though it has no walls', () => {
    const d = doc();
    d.floors[0]!.rooms.push({
      id: 'r',
      name: 'Room',
      boundary: polygon([
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
      ]),
      ceilingHeightMm: 2438,
      areaMm2: 500_000,
    });
    expect(isUntouched(d)).toBe(false);
  });

  it('a shopping list with no floor plan is content', () => {
    // The inventory-first document. Nothing is drawn, and losing it is still a loss.
    const d = doc();
    d.catalog.push({
      id: 'i',
      name: 'Sofa',
      category: 'seating',
      widthMm: 2000,
      depthMm: 900,
      heightMm: 800,
      voidBelowMm: 0,
      canHostSurface: false,
      footprint: { generator: { kind: 'rect', w: 2000, d: 900 }, outline: polygon([
        { x: -1000, y: -450 },
        { x: 1000, y: -450 },
        { x: 1000, y: 450 },
      ]) },
      defaultMount: 'floor',
      color: '#888',
      quantityOwned: 1,
    });
    expect(isUntouched(d)).toBe(false);
  });

  it('an imported floor plan is content, even before a line is drawn', () => {
    const d = doc();
    d.floors[0]!.background = {
      assetId: 'a',
      pixelSize: { width: 100, height: 100 },
      transform: { position: { x: 0, y: 0 }, rotationDeg: 0 },
      opacity: 0.45,
      locked: true,
    };
    expect(isUntouched(d)).toBe(false);
  });
});

describe('choosing a recovery', () => {
  it('offers nothing when the database is empty', () => {
    expect(chooseRecovery([], doc(), { dirty: false })).toBeNull();
  });

  it('offers an autosave that is ahead of the file that was opened', () => {
    const opened = doc({ modifiedAt: '2026-01-01T10:00:00.000Z' });
    const offer = chooseRecovery([record({ modifiedAt: '2026-01-01T11:00:00.000Z' })], opened, {
      dirty: false,
    });
    expect(offer?.reason).toBe('newer');
  });

  it('does not offer an autosave the opened file has already caught up with', () => {
    // Saved, then reloaded. The record and the file describe the same state, and an
    // offer here is a prompt with nothing behind it.
    const opened = doc({ modifiedAt: '2026-01-01T12:00:00.000Z' });
    expect(chooseRecovery([record()], opened, { dirty: false })).toBeNull();
  });

  it('compares how far along the documents are, not which write happened last', () => {
    // The autosave ran *after* the file was written but holds an *earlier* state —
    // a background flush that lost the race with a manual save. Going by `savedAt`
    // would hand the user back the older document.
    const opened = doc({ modifiedAt: '2026-01-01T12:00:00.000Z' });
    const stale = record({ savedAt: '2026-01-01T13:00:00.000Z', modifiedAt: '2026-01-01T11:00:00.000Z' });
    expect(chooseRecovery([stale], opened, { dirty: false })).toBeNull();
  });

  it('offers an orphan when this session has nothing to lose', () => {
    // The case §5 does not describe and the one that matters after a crash: the tab
    // came back on a fresh document and the work belongs to an id it has never seen.
    const offer = chooseRecovery([record({ documentId: 'other', title: 'Flat' })], doc(), {
      dirty: false,
    });
    expect(offer?.reason).toBe('orphan');
    expect(offer?.record.documentId).toBe('other');
  });

  it('will not offer another document over work in progress', () => {
    const d = doc();
    d.floors[0]!.walls.push({
      id: 'w',
      a: { x: 0, y: 0 },
      b: { x: 1000, y: 0 },
      thicknessMm: 114,
      heightMm: 2438,
      baseElevationMm: 0,
    });
    expect(chooseRecovery([record({ documentId: 'other' })], d, { dirty: false })).toBeNull();
  });

  it('offers nothing at all once the session is dirty', () => {
    // Not a startup any more. Every accept path replaces the open document, so an
    // offer here proposes destroying the work it claims to be protecting.
    expect(chooseRecovery([record({ documentId: 'other' })], doc(), { dirty: true })).toBeNull();
  });

  it('picks the most recent of several orphans', () => {
    const offer = chooseRecovery(
      [
        record({ documentId: 'old', savedAt: '2026-01-01T08:00:00.000Z' }),
        record({ documentId: 'new', savedAt: '2026-01-01T09:00:00.000Z' }),
      ],
      doc(),
      { dirty: false },
    );
    expect(offer?.record.documentId).toBe('new');
  });

  it('prefers this document over a newer orphan', () => {
    // An offer for the document you are looking at is the one you can act on without
    // losing your place, even when another one was written more recently.
    const opened = doc({ modifiedAt: '2026-01-01T10:00:00.000Z' });
    const offer = chooseRecovery(
      [
        record({ modifiedAt: '2026-01-01T11:00:00.000Z', savedAt: '2026-01-01T11:00:00.000Z' }),
        record({ documentId: 'other', savedAt: '2026-01-01T23:00:00.000Z' }),
      ],
      opened,
      { dirty: false },
    );
    expect(offer?.reason).toBe('newer');
    expect(offer?.record.documentId).toBe('doc-a');
  });

  it('treats an unreadable timestamp as old rather than throwing', () => {
    const opened = doc({ modifiedAt: '2026-01-01T10:00:00.000Z' });
    expect(chooseRecovery([record({ modifiedAt: 'not a date' })], opened, { dirty: false })).toBeNull();
  });
});

describe('what the prompt says', () => {
  it('names the other document when it is not this one', () => {
    const message = recoveryMessage({
      record: record({ documentId: 'other', title: 'Riverside flat' }),
      reason: 'orphan',
    });
    expect(message).toContain('Riverside flat');
  });

  it('survives a corrupt timestamp', () => {
    const message = recoveryMessage({ record: record({ savedAt: 'nonsense' }), reason: 'newer' });
    expect(message).toContain('earlier');
    expect(message).not.toContain('Invalid Date');
  });
});
