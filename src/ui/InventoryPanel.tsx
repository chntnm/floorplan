import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CATEGORY_LABELS, CatalogError, draftFromItem, type ItemDraft } from '../core/catalog';
import { placedCount, type CatalogItem, type Id } from '../core/document';
import { PRESETS, findPreset } from '../core/presets';
import { placementBlockReason } from '../core/calibration';
import { formatLength } from '../core/units';
import { activeFloor, useStore } from '../state/store';
import {
  addCatalogItem,
  removeCatalogItem,
  setQuantityOwned,
  updateCatalogItem,
} from '../state/actions';
import { ItemForm } from './ItemForm';
import { NO_ENDPOINT_MESSAGE, lookUpProduct } from './product-lookup';
import { evidenceFor, itemDraftFrom, sourceFor } from '../core/product-import';
import type { ProductDraft } from '../core/product';

/**
 * The inventory (PLAN.md §7).
 *
 * Items exist independently of placement: you can build a shopping list before you
 * have a floor plan, and the unplaced count is the whole point of the exercise. That
 * is why the list shows owned and placed separately rather than one number — "I own
 * 6, 4 are placed, 2 to go" has to stay expressible.
 *
 * Placing starts here rather than from a tool: you pick the thing you want, then you
 * point at where it goes.
 */
export function InventoryPanel() {
  const { doc, editMode, placingItemId, notice } = useStore(
    useShallow((s) => ({
      doc: s.doc,
      editMode: s.editMode,
      placingItemId: s.placingItemId,
      notice: s.notice,
    })),
  );

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<Id | null>(null);
  const [error, setError] = useState<string | null>(null);

  // URL import (PLAN.md §7.2). `pendingUrl` is the form; `found` is what came back and
  // is what turns the item form into a confirm-before-add dialog.
  const [urlEntry, setUrlEntry] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [found, setFound] = useState<{ url: string; draft: ProductDraft } | null>(null);

  const floor = activeFloor({ doc });
  const unit = doc.displayUnit;
  const blocked = placementBlockReason(floor);
  const editing = editingId ? doc.catalog.find((i) => i.id === editingId) : undefined;

  const guarded = (fn: () => void) => {
    try {
      fn();
      setError(null);
    } catch (err) {
      // `CatalogError` messages are written to be read by whoever typed the number.
      setError(err instanceof CatalogError ? err.message : 'That item could not be saved.');
    }
  };

  const onAdd = (draft: ItemDraft) =>
    guarded(() => {
      addCatalogItem(draft);
      setAdding(false);
    });

  /**
   * Confirm a looked-up product.
   *
   * The source is attached here rather than in the form, because whether the item
   * counts as `parsed` or `confirmed` depends on what the user did to the numbers
   * between the lookup and this call — which is exactly the thing the form does not
   * know and this component does.
   */
  const onConfirmFound = (draft: ItemDraft) =>
    guarded(() => {
      if (!found) return;
      addCatalogItem({ ...draft, source: sourceFor({ url: found.url, scraped: found.draft, submitted: draft }) });
      setFound(null);
      setUrlEntry(null);
    });

  const onLookUp = async (url: string) => {
    setLookingUp(true);
    setError(null);
    try {
      const outcome = await lookUpProduct(url);
      if (outcome.kind === 'ok') {
        setFound({ url: outcome.url, draft: outcome.draft });
        return;
      }
      // "Unavailable" is not a failure to report as one — it is the stated
      // degradation, and the message says what to do instead.
      setError(outcome.kind === 'unavailable' ? NO_ENDPOINT_MESSAGE : outcome.message);
    } finally {
      setLookingUp(false);
    }
  };

  const onEdit = (draft: ItemDraft) =>
    guarded(() => {
      if (editingId) updateCatalogItem(editingId, draft);
      setEditingId(null);
    });

  const onPreset = (key: string) => {
    const preset = findPreset(key);
    if (!preset) return;
    // Spread away `key` and `group`: they are library metadata, not item fields.
    const { key: _key, group: _group, ...draft } = preset;
    guarded(() => addCatalogItem(draft));
  };

  const arm = (item: CatalogItem) => {
    const store = useStore.getState();
    if (store.editMode !== 'furnish') store.setEditMode('furnish');
    store.setPlacingItem(store.placingItemId === item.id ? null : item.id);
  };

  return (
    <aside className="panel panel--left">
      <h2 className="panel__heading">Inventory</h2>

      {placingItemId ? (
        <p className="panel__note" data-testid="placing-note">
          Click the plan to place it. Esc to stop.
        </p>
      ) : null}

      {blocked ? (
        <p className="panel__warn" data-testid="inventory-blocked">
          {blocked}
        </p>
      ) : null}

      {/* Set when an action could not do quite what was asked — a wall-mounted item
          dropped where there is no wall. Said out loud rather than silently done
          differently. */}
      {notice ? (
        <p className="panel__warn" data-testid="inventory-notice">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p className="panel__warn" role="alert" data-testid="inventory-error">
          {error}
        </p>
      ) : null}

      {doc.catalog.length === 0 && !adding ? (
        <p className="panel__empty">
          Nothing here yet. Add an item, or start from a standard size.
        </p>
      ) : null}

      <ul className="items" data-testid="item-list">
        {doc.catalog.map((item) => {
          const placed = placedCount(doc, item.id);
          const armed = placingItemId === item.id;
          return (
            <li key={item.id} className="item" data-armed={armed} data-testid="item-row">
              {editingId === item.id ? null : (
                <>
                  <div className="item__head">
                    <span className="item__name">{item.name}</span>
                    <span className="item__count" data-testid="item-count">
                      {placed}/{item.quantityOwned}
                    </span>
                  </div>
                  <div className="item__meta">
                    {CATEGORY_LABELS[item.category]} ·{' '}
                    {formatLength(item.widthMm, unit)} × {formatLength(item.depthMm, unit)} ×{' '}
                    {formatLength(item.heightMm, unit)}
                    {/* PLAN.md §7.2: an item still carrying a measurement nobody
                        checked. Shown here rather than only in the file, because the
                        moment it matters is when something does not fit and you are
                        looking down this list wondering which number to doubt. */}
                    {item.source?.confidence === 'parsed' ? (
                      <span
                        className="item__flag"
                        data-testid={`unverified-${item.id}`}
                        title={`Read from ${item.source.url} and not checked`}
                      >
                        {' '}· unverified
                      </span>
                    ) : null}
                  </div>
                  <div className="item__actions">
                    {/* Disabled rather than allowed-and-refused: the gate is going
                        to reject this, and offering an action that cannot work is
                        worse than showing why it is unavailable. `addPlacement`
                        still throws — that is the enforcement, this is the manners. */}
                    <button
                      type="button"
                      className="seg seg--small"
                      data-active={armed}
                      aria-pressed={armed}
                      disabled={blocked !== null}
                      title={blocked ?? undefined}
                      onClick={() => arm(item)}
                    >
                      {armed ? 'Placing…' : 'Place'}
                    </button>
                    <button
                      type="button"
                      className="seg seg--small"
                      aria-label={`Edit ${item.name}`}
                      onClick={() => setEditingId(item.id)}
                    >
                      Edit
                    </button>
                    <input
                      type="number"
                      min={0}
                      className="item__qty"
                      value={item.quantityOwned}
                      aria-label={`Quantity of ${item.name} owned`}
                      onChange={(e) => setQuantityOwned(item.id, Number(e.target.value))}
                    />
                    <button
                      type="button"
                      className="seg seg--small"
                      aria-label={`Remove ${item.name}`}
                      onClick={() => removeCatalogItem(item.id)}
                    >
                      ×
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {editing ? (
        <ItemForm
          unit={unit}
          initial={draftFromItem(editing)}
          submitLabel="Save"
          onSubmit={onEdit}
          onCancel={() => setEditingId(null)}
        />
      ) : found ? (
        /* The confirm-before-add dialog (§7.2). It is the ordinary item form, with
           every field editable, plus the URL and the text the numbers were read
           from — a scraped dimension a person cannot check against the page is one
           they have to take on trust. */
        <div className="lookup" data-testid="lookup-confirm">
          <p className="lookup__source">
            From <span data-testid="lookup-url">{found.url}</span>
          </p>
          {evidenceFor(found.draft) ? (
            <p className="lookup__evidence" data-testid="lookup-evidence">
              {evidenceFor(found.draft)}
            </p>
          ) : (
            <p className="lookup__evidence" data-testid="lookup-evidence">
              That page did not state any dimensions — they need typing in.
            </p>
          )}
          <ItemForm
            unit={unit}
            initial={itemDraftFrom(found.draft)}
            submitLabel="Add"
            onSubmit={onConfirmFound}
            onCancel={() => {
              setFound(null);
              setUrlEntry(null);
            }}
          />
        </div>
      ) : adding ? (
        <ItemForm unit={unit} submitLabel="Add" onSubmit={onAdd} onCancel={() => setAdding(false)} />
      ) : urlEntry !== null ? (
        <div className="panel__row" data-testid="lookup-form">
          <input
            className="field__input"
            type="url"
            value={urlEntry}
            aria-label="Product page URL"
            data-testid="lookup-url-input"
            placeholder="https://…"
            onChange={(e) => setUrlEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && urlEntry.trim()) void onLookUp(urlEntry.trim());
              if (e.key === 'Escape') setUrlEntry(null);
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={lookingUp || !urlEntry.trim()}
            data-testid="lookup-go"
            onClick={() => void onLookUp(urlEntry.trim())}
          >
            {lookingUp ? 'Looking…' : 'Look up'}
          </button>
          <button type="button" className="btn" onClick={() => setUrlEntry(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="panel__row">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="add-item"
            onClick={() => setAdding(true)}
          >
            Add item
          </button>
          <button
            type="button"
            className="btn"
            data-testid="add-from-url"
            title="Read a product page for its name and dimensions"
            onClick={() => {
              setError(null);
              setUrlEntry('');
            }}
          >
            From a URL
          </button>
        </div>
      )}

      {!adding && !editing ? (
        <label className="field field--input">
          <span className="field__label">Preset</span>
          <select
            value=""
            aria-label="Add from the preset library"
            data-testid="preset-picker"
            onChange={(e) => {
              if (e.target.value) onPreset(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">Standard sizes…</option>
            {PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.group} — {preset.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {editMode === 'plan' && doc.catalog.length > 0 ? (
        <p className="panel__empty">Switch to Arrange furniture to place these.</p>
      ) : null}
    </aside>
  );
}
