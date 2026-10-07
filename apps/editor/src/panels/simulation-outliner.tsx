import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { PanelFrame, SearchInput, TreeView, TypeVisualIcon, resolveTypeVisual, type TreeViewNode } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { useSimulationInspection } from "../context/simulation-inspection-context";
import { runtimeIdentityKey, type SimulationInspectionStore } from "../services/simulation-inspection-store";

export function SimulationOutliner({ store, panel }: { store: SimulationInspectionStore; panel: IDockviewPanelProps }) {
  const state = useSimulationInspection(store, panel, "identities");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const byId = useMemo(() => new Map(state.rows.map(row => [runtimeIdentityKey(row.identity), row])), [state.rows]);
  const nodes = useMemo(() => {
    const children = new Map<string | null, string[]>();
    for (const [key, row] of byId) {
      const parentKey = row.parent ? runtimeIdentityKey(row.parent) : null;
      const parent = parentKey && byId.has(parentKey) ? parentKey : null;
      const list = children.get(parent) ?? []; list.push(key); children.set(parent, list);
    }
    const result: TreeViewNode[] = [];
    const seen = new Set<string>();
    const query = search.trim().toLocaleLowerCase();
    const visit = (key: string, depth: number) => {
      if (seen.has(key)) return;
      seen.add(key);
      const row = byId.get(key)!;
      const descendants = children.get(key) ?? [];
      if (!query || `${row.name} ${row.classId}`.toLocaleLowerCase().includes(query)) result.push({
        id: key, label: row.name || row.classId, depth: query ? 0 : depth,
        hasChildren: !query && descendants.length > 0, expanded: !collapsed.has(key),
        icon: <TypeVisualIcon visual={resolveTypeVisual({ classId: row.classId, parentClass: row.kind === "actor" ? "Actor" : "ActorComponent" })} />,
      });
      if (query || !collapsed.has(key)) for (const child of descendants) visit(child, depth + 1);
    };
    for (const root of children.get(null) ?? []) visit(root, 0);
    // Paging may temporarily omit a parent. Never lose an explicitly delivered identity.
    for (const key of byId.keys()) if (!seen.has(key) && query) visit(key, 0);
    return result;
  }, [byId, collapsed, search]);
  return <PanelFrame title="Simulation Outliner" data-testid="simulation-outliner">
    <div className="p-2"><SearchInput value={search} onChange={setSearch} placeholder="Search Runtime Objects" /></div>
    {state.identityError ? <p role="status" className="px-2 text-xs text-destructive">{state.identityError}</p> : null}
    <TreeView nodes={nodes} selectedId={state.selected ? runtimeIdentityKey(state.selected) : null}
      onSelect={key => { const row = byId.get(key); if (row) store.select(row.identity); }}
      onToggleExpanded={key => setCollapsed(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next; })}
      emptyLabel={state.connected ? "No Runtime Objects" : "Preparing Simulation…"} />
    {state.moreIdentities && !state.identitiesLimited ? <Button size="sm" variant="outline" className="m-2" onClick={store.loadMoreIdentities}>Load More Objects</Button> : null}
    {state.identitiesLimited ? <p className="p-2 text-xs text-muted-foreground">Runtime tree reached its 4,096 object or 512 KiB display limit.</p> : null}
  </PanelFrame>;
}
