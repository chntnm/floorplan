import {
  EDIT_MODES,
  EDIT_MODE_LABELS,
  VIEW_MODES,
  VIEW_MODE_LABELS,
  type EditMode,
  type ViewMode,
} from '../core/modes';

type Props = {
  editMode: EditMode;
  viewMode: ViewMode;
  onEditModeChange: (mode: EditMode) => void;
  onViewModeChange: (mode: ViewMode) => void;
};

export function TopBar({ editMode, viewMode, onEditModeChange, onViewModeChange }: Props) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true" />
        <span className="topbar__title">roomplan</span>
        <span className="topbar__doc">Untitled space</span>
      </div>

      <div className="topbar__group" role="group" aria-label="Edit mode">
        {EDIT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="seg"
            data-active={mode === editMode}
            aria-pressed={mode === editMode}
            onClick={() => onEditModeChange(mode)}
          >
            {EDIT_MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      <div className="topbar__group" role="group" aria-label="View">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="seg"
            data-active={mode === viewMode}
            aria-pressed={mode === viewMode}
            onClick={() => onViewModeChange(mode)}
          >
            {VIEW_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
    </header>
  );
}
