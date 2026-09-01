/**
 * Placeholder for the catalog list (phase 4).
 *
 * Lists CatalogItems with owned/placed counts — deliberately independent of
 * placement, so "I own 6, 4 are placed" stays expressible (PLAN.md §4.3).
 */
export function InventoryPanel() {
  return (
    <aside className="panel panel--left">
      <h2 className="panel__heading">Inventory</h2>
      <p className="panel__empty">
        No items yet. Phase 4 adds manual entry, the preset library, and product-URL
        import.
      </p>
    </aside>
  );
}
