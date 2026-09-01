import { structureIsEditable, type EditMode } from '../core/modes';

type Props = {
  editMode: EditMode;
};

/**
 * Placeholder for the selection inspector and the validation list
 * (overlap / headroom / clearance / door swing — PLAN.md §9).
 */
export function PropertiesPanel({ editMode }: Props) {
  return (
    <aside className="panel panel--right">
      <h2 className="panel__heading">Properties</h2>
      <p className="panel__empty">
        Nothing selected.{' '}
        {structureIsEditable(editMode)
          ? 'Walls, rooms and openings are editable.'
          : 'Structure is locked; furniture is editable.'}
      </p>

      <h2 className="panel__heading">Validation</h2>
      <p className="panel__empty">No issues.</p>
    </aside>
  );
}
