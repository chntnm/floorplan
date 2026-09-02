import { TopBar } from './ui/TopBar';
import { InventoryPanel } from './ui/InventoryPanel';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { Viewport } from './ui/Viewport';

/**
 * Layout only. Every panel reads what it needs from the store directly, so mode and
 * document changes do not re-render the shell.
 */
export function App() {
  return (
    <div className="app">
      <TopBar />
      <div className="app__body">
        <InventoryPanel />
        <Viewport />
        <PropertiesPanel />
      </div>
    </div>
  );
}
