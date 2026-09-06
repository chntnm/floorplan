import { useEffect } from 'react';
import { TopBar } from './ui/TopBar';
import { InventoryPanel } from './ui/InventoryPanel';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { Viewport } from './ui/Viewport';
import { DropZone } from './ui/DropZone';
import { RecoveryBanner } from './ui/RecoveryBanner';
import { startAutosave } from './state/autosave';
import { publishUnsavedFlag } from './state/unsaved';

/**
 * Layout, plus the things that have to be alive for the whole session: the autosave
 * subscription, the flag the desktop shell reads before closing, and the window-wide
 * drop target. Every panel reads what it needs from the store directly, so mode and
 * document changes do not re-render the shell.
 */
export function App() {
  useEffect(() => startAutosave(), []);
  useEffect(() => publishUnsavedFlag(), []);

  return (
    <div className="app">
      <TopBar />
      <RecoveryBanner />
      <div className="app__body">
        <InventoryPanel />
        <Viewport />
        <PropertiesPanel />
      </div>
      <DropZone />
    </div>
  );
}
