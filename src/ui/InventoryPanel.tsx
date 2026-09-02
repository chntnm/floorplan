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
      ) : adding ? (
        <ItemForm unit={unit} submitLabel="Add" onSubmit={onAdd} onCancel={() => setAdding(false)} />
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
