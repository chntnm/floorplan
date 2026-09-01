import { useState } from 'react';
import type { EditMode, ViewMode } from './core/modes';
import { TopBar } from './ui/TopBar';
import { InventoryPanel } from './ui/InventoryPanel';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { Viewport } from './ui/Viewport';

/**
 * Phase 0 shell. Layout and mode plumbing only — the viewports are placeholders
 * until the Konva stage (phase 2) and the three.js scene (phase 5) land.
 */
export function App() {
  const [editMode, setEditMode] = useState<EditMode>('plan');
  const [viewMode, setViewMode] = useState<ViewMode>('plan2d');

  return (
    <div className="app">
      <TopBar
        editMode={editMode}
        viewMode={viewMode}
        onEditModeChange={setEditMode}
        onViewModeChange={setViewMode}
      />
      <div className="app__body">
        <InventoryPanel />
        <Viewport editMode={editMode} viewMode={viewMode} />
        <PropertiesPanel editMode={editMode} />
      </div>
    </div>
  );
}
