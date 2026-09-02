import { useState } from 'react';
import { CATEGORIES, CATEGORY_DEFAULTS, CATEGORY_LABELS, type ItemDraft } from '../core/catalog';
import { SHAPE_KINDS, SHAPE_KIND_LABELS, type ShapeKind } from '../core/tools';
import { formatLength, parseLength, type DisplayUnit } from '../core/units';
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

/** A length field: typed in any unit, held as text until it parses. */
function LengthField({
  label,
  value,
  unit,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  unit: DisplayUnit;
  onChange: (next: string) => void;
  hint?: string;
}) {
  const parsed = parseLength(value, unit);
  return (
    <label className="field field--input">
      <span className="field__label">{label}</span>
      <input
        value={value}
        aria-label={label}
        placeholder={unit === 'ft-in' ? '30"' : '760'}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="field__hint">
        {value && parsed === null ? '?' : parsed !== null ? formatLength(parsed, unit) : (hint ?? '')}
      </span>
    </label>
  );
}

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
  const [width, setWidth] = useState(base.widthMm ? String(base.widthMm) : '');
  const [depth, setDepth] = useState(base.depthMm ? String(base.depthMm) : '');
  const [height, setHeight] = useState(base.heightMm ? String(base.heightMm) : '');
  const [voidBelow, setVoidBelow] = useState(
    base.voidBelowMm !== undefined ? String(base.voidBelowMm) : '',
  );
  const [hosts, setHosts] = useState(base.canHostSurface ?? CATEGORY_DEFAULTS[base.category].canHostSurface);
  const [quantity, setQuantity] = useState(String(base.quantityOwned ?? 1));
  const [mount, setMount] = useState<MountKind>(base.defaultMount ?? 'floor');
  const [error, setError] = useState<string | null>(null);

  // Changing category re-suggests the two fields that follow from it, but only while
  // the user has not already made a choice of their own.
  const onCategory = (next: Category) => {
    setCategory(next);
    if (voidBelow === '' || voidBelow === String(CATEGORY_DEFAULTS[category].voidBelowMm)) {
      setVoidBelow(String(CATEGORY_DEFAULTS[next].voidBelowMm));
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
          {/* Stored, but not reachable when placing: a wall mount needs a wall to
              host against and a ceiling mount a ceiling to hang from, which is
              phase 5. Offering a choice that silently lands the item on the floor
              is the same mistake as offering a Place button that will be refused. */}
          <option value="wall" disabled>
            Wall (phase 5)
          </option>
          <option value="ceiling" disabled>
            Ceiling (phase 5)
          </option>
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
