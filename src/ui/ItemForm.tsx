import { useState } from 'react';
import { CATEGORIES, CATEGORY_DEFAULTS, CATEGORY_LABELS, type ItemDraft } from '../core/catalog';
import { SHAPE_KINDS, SHAPE_KIND_LABELS, type ShapeKind } from '../core/tools';
import type { DisplayUnit } from '../core/units';
import { formatLength, parseLength } from '../core/units';
import { LengthField } from './LengthField';
import type { Category, MountKind } from '../core/document';

type Props = {
  unit: DisplayUnit;
  initial?: ItemDraft;
  submitLabel: string;
  onSubmit: (draft: ItemDraft) => void;
  onCancel: () => void;
};

const EMPTY: ItemDraft = {
  name: '',
  category: 'other',
  widthMm: 0,
  depthMm: 0,
  heightMm: 0,
  shape: 'rect',
};

/**
 * Manual entry — the primary path into the inventory (PLAN.md §7.1).
 *
 * Dimensions are typed in whatever unit is convenient and parsed through the same
 * `parseLength` the rest of the app uses, so `30"`, `760`, `0.76m` and `2ft 6in` all
 * work and the field echoes back what it understood. A number that will not parse is
 * shown as unparsed rather than silently becoming zero.
 *
 * `voidBelowMm` is pre-filled from the category, not left at zero. It is the field
 * that decides whether a rug under this table reads as a collision, and a user typing
 * in a dining table should not have to know that before the app stops shouting at them.
 */
export function ItemForm({ unit, initial, submitLabel, onSubmit, onCancel }: Props) {
  const base = initial ?? EMPTY;
  const [name, setName] = useState(base.name);
  const [category, setCategory] = useState<Category>(base.category);
  const [shape, setShape] = useState<ShapeKind>(base.shape);
  // Formatted, never `String(mm)`. A bare number is read back in the document's
  // display unit, so a 1524mm bed prefilled as "1524" is re-read as 1524 *inches* the
  // moment the form is submitted — an edit that only changed the name would multiply
  // every dimension by 25.4. `formatLength` writes a value that parses back to itself.
  const [width, setWidth] = useState(base.widthMm ? formatLength(base.widthMm, unit) : '');
  const [depth, setDepth] = useState(base.depthMm ? formatLength(base.depthMm, unit) : '');
  const [height, setHeight] = useState(base.heightMm ? formatLength(base.heightMm, unit) : '');
  const [voidBelow, setVoidBelow] = useState(
    base.voidBelowMm !== undefined ? formatLength(base.voidBelowMm, unit) : '',
  );
  const [hosts, setHosts] = useState(base.canHostSurface ?? CATEGORY_DEFAULTS[base.category].canHostSurface);
  const [quantity, setQuantity] = useState(String(base.quantityOwned ?? 1));
  const [mount, setMount] = useState<MountKind>(base.defaultMount ?? 'floor');
  const [error, setError] = useState<string | null>(null);

  // Changing category re-suggests the two fields that follow from it, but only while
  // the user has not already made a choice of their own.
  const onCategory = (next: Category) => {
    setCategory(next);
    // Formatted for the same reason as the fields above: a suggestion written as a
    // bare number would be read back in the display unit, so the category default for
    // a dining table would arrive as 720 inches.
    const suggested = formatLength(CATEGORY_DEFAULTS[category].voidBelowMm, unit);
    if (voidBelow === '' || voidBelow === suggested) {
      setVoidBelow(formatLength(CATEGORY_DEFAULTS[next].voidBelowMm, unit));
    }
    setHosts(CATEGORY_DEFAULTS[next].canHostSurface);
  };

  const submit = () => {
    const w = parseLength(width, unit);
    const d = parseLength(depth, unit);
    const h = parseLength(height, unit);
    if (w === null || d === null || h === null) {
      setError('Width, depth and height all need a length — 30", 760, 0.76m all work.');
      return;
    }
    let v: number | undefined;
    if (voidBelow.trim() !== '') {
      const parsed = parseLength(voidBelow, unit);
      if (parsed === null) {
        setError('Open space beneath is not a length I can read.');
        return;
      }
      v = parsed;
    }

    try {
      onSubmit({
        name,
        category,
        shape,
        widthMm: w,
        depthMm: d,
        heightMm: h,
        ...(v !== undefined ? { voidBelowMm: v } : {}),
        canHostSurface: hosts,
        defaultMount: mount,
        quantityOwned: Math.max(0, Math.round(Number(quantity) || 0)),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That item could not be added.');
    }
  };

  return (
    <div className="itemform" data-testid="item-form">
      <label className="field field--input">
        <span className="field__label">Name</span>
        <input
          autoFocus
          value={name}
          aria-label="Item name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </label>

      <label className="field field--input">
        <span className="field__label">Category</span>
        <select
          value={category}
          aria-label="Category"
          onChange={(e) => onCategory(e.target.value as Category)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      <LengthField label="Width" value={width} unit={unit} onChange={setWidth} />
      <LengthField label="Depth" value={depth} unit={unit} onChange={setDepth} />
      <LengthField label="Height" value={height} unit={unit} onChange={setHeight} />
      <LengthField
        label="Open below"
        value={voidBelow}
        unit={unit}
        onChange={setVoidBelow}
        hint="legs"
      />

      <label className="field field--input">
        <span className="field__label">Shape</span>
        <select value={shape} aria-label="Shape" onChange={(e) => setShape(e.target.value as ShapeKind)}>
          {SHAPE_KINDS.map((k) => (
            <option key={k} value={k}>
              {SHAPE_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>

      <label className="field field--input">
        <span className="field__label">Mount</span>
        <select
          value={mount}
          aria-label="Mount"
          onChange={(e) => setMount(e.target.value as MountKind)}
        >
          <option value="floor">Floor</option>
          <option value="surface">On a surface</option>
          {/* Both reachable now. An item that says it is wall-mounted lands on the
              nearest wall when dropped near one, and lands on the floor with a note
              saying why when there is no wall in reach — never on a wall it guessed. */}
          <option value="wall">Wall</option>
          <option value="ceiling">Ceiling</option>
        </select>
      </label>

      <label className="field field--input">
        <span className="field__label">Owned</span>
        <input
          type="number"
          min={0}
          value={quantity}
          aria-label="Quantity owned"
          onChange={(e) => setQuantity(e.target.value)}
        />
      </label>

      <label className="field field--input">
        <span className="field__label">Hosts items</span>
        <input
          type="checkbox"
          checked={hosts}
          aria-label="Other items can sit on top"
          onChange={(e) => setHosts(e.target.checked)}
        />
      </label>

      {error ? (
        <p className="panel__warn" role="alert" data-testid="item-form-error">
          {error}
        </p>
      ) : null}

      <div className="panel__row">
        <button type="button" className="btn btn--primary" onClick={submit}>
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
