import { useEffect, useState } from 'react';
import { formatLength, parseLength, type DisplayUnit } from '../core/units';

/**
 * A length typed in any unit, held as text until it parses.
 *
 * Text rather than a number input, because `30"`, `0.76m` and `2ft 6in` are all
 * lengths and `<input type="number">` accepts none of them. The hint echoes back what
 * was understood, which is the only defence against a units mistake that produces a
 * plausible-looking 45m table.
 *
 * Controlled: the caller owns the text. Use this inside a form that validates on
 * submit.
 */
export function LengthField({
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
 * A length bound to a value in the document, committed on blur or Enter.
 *
 * Committing per keystroke would put one undo entry on the stack per character — the
 * same problem the room-name field solves the same way. Typing is local; the document
 * hears about it once.
 *
 * Escape reverts to the stored value, so a half-typed number can be abandoned without
 * having to remember what it was.
 */
export function LengthInput({
  label,
  valueMm,
  unit,
  onCommit,
  testId,
}: {
  label: string;
  valueMm: number;
  unit: DisplayUnit;
  onCommit: (mm: number) => void;
  testId?: string;
}) {
  const stored = formatLength(valueMm, unit);
  const [text, setText] = useState(stored);

  // Follow the document when it changes underneath — an undo, or a drag that moved
  // the thing this field is describing.
  useEffect(() => setText(stored), [stored]);

  const commit = () => {
    const parsed = parseLength(text, unit);
    if (parsed === null) {
      setText(stored); // unreadable input reverts rather than becoming zero
      return;
    }
    if (parsed !== valueMm) onCommit(parsed);
  };

  return (
    <label className="field field--input">
      <span className="field__label">{label}</span>
      <input
        value={text}
        aria-label={label}
        {...(testId ? { 'data-testid': testId } : {})}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(stored);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
