import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useMemo, useState } from "react";
import { BoxIcon, FolderIcon, ListTreeIcon, SquareFunctionIcon, VariableIcon, WorkflowIcon } from "lucide-react";
import type { AssetDiff, DiffStatus, GraphDiff, SceneDiff } from "@haptic/assets/asset-diff";
import { assetSummaryGroup } from "@haptic/assets/asset-diff";
import { PanelFrame, SearchInput, TreeView, type TreeViewNode } from "@haptic/editor-kit";
import { useSourceControlDiff, useSourceControlDiffState } from "../components/source-control-actions";
import { DiffCountBadges, DiffPlaceholder, StatusLetter } from "./diff-common";
import { hasDiff, STATUS_TONE } from "./diff-status";

/** One row of the tree before collapse and search: its parent and whether it changed. */
interface ItemRow {
  id: string;
  label: string;
  depth: number;
  parent: string | null;
  status: DiffStatus;
  /** Some row below it changed: shown at full strength though it did not. */
  changedBelow: boolean;
  hasChildren: boolean;
  icon: "folder" | "actor" | "graph" | "node" | "variable" | "function" | "group";
}

const ICONS = {
  folder: FolderIcon,
  actor: BoxIcon,
  graph: WorkflowIcon,
  node: BoxIcon,
  variable: VariableIcon,
  function: SquareFunctionIcon,
  group: ListTreeIcon,
} as const;

function sceneRows(view: SceneDiff): ItemRow[] {
  const rows: ItemRow[] = view.rows.map((row) => ({ ...row, label: row.name, icon: row.kind }));
  if (view.script) rows.push({ id: "script", label: "Scene Script", depth: 0, parent: null, status: "changed", changedBelow: false, hasChildren: false, icon: "graph" });
  return rows;
}

/** Each graph that changed with its nodes, then Variables, Functions and the other members. */
function graphRows(view: GraphDiff): ItemRow[] {
  const rows: ItemRow[] = [];
  for (const section of view.sections) {
    if (section.status === "unchanged") continue;
    rows.push({ id: section.id, label: section.title, depth: 0, parent: null, status: section.status, changedBelow: false, hasChildren: section.nodes.length > 0, icon: "graph" });
    for (const node of section.nodes) {
      rows.push({ id: `${section.id}/${node.id}`, label: node.title, depth: 1, parent: section.id, status: node.status, changedBelow: false, hasChildren: false, icon: "node" });
    }
  }
  const members = [
    ["variables", "Variables", view.variables, "variable"],
    ["functions", "Functions", view.functions, "function"],
    ["others", "Events And Dispatchers", view.others, "function"],
  ] as const;
  for (const [id, title, list, icon] of members) {
    if (list.length === 0) continue;
    rows.push({ id: `group:${id}`, label: title, depth: 0, parent: null, status: "unchanged", changedBelow: true, hasChildren: true, icon: "group" });
    for (const member of list) rows.push({ id: `member:${member.id}`, label: member.name, depth: 1, parent: `group:${id}`, status: member.status, changedBelow: false, hasChildren: false, icon });
  }
  return rows;
}

/** The asset's own header and chunks, then its document's groups. */
function groupRows(diff: AssetDiff): ItemRow[] {
  const groups = diff.view.kind === "properties" ? [assetSummaryGroup(diff), ...diff.view.groups] : [assetSummaryGroup(diff)];
  return groups.map((group) => ({ id: `group:${group.id}`, label: group.title, depth: 0, parent: null, status: group.status, changedBelow: false, hasChildren: false, icon: "group" }));
}

function itemRows(diff: AssetDiff): ItemRow[] {
  if (diff.view.kind === "scene") return sceneRows(diff.view);
  if (diff.view.kind === "graph") return graphRows(diff.view);
  return groupRows(diff);
}

/** Rows to show: matches of `query` with their ancestors, or everything not under a collapsed row. */
function visibleRows(rows: readonly ItemRow[], query: string, collapsed: ReadonlySet<string>): ItemRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const needle = query.trim().toLowerCase();
  if (needle) {
    const keep = new Set<string>();
    for (const row of rows) {
      if (!row.label.toLowerCase().includes(needle)) continue;
      for (let at: ItemRow | undefined = row; at && !keep.has(at.id); at = at.parent ? byId.get(at.parent) : undefined) keep.add(at.id);
    }
    return rows.filter((row) => keep.has(row.id));
  }
  const hidden = (row: ItemRow): boolean => {
    for (let parent = row.parent; parent; parent = byId.get(parent)?.parent ?? null) if (collapsed.has(parent)) return true;
    return false;
  };
  return rows.filter((row) => !hidden(row));
}

/**
 * The Source Control tab's Actors window: the chosen asset's items, each
 * marked and tinted by what changed, unchanged ones muted, with search and
 * the Added, Removed and Changed counts. Scenes list their folders and
 * actors; graphs their changed graphs and nodes, variables and functions;
 * other assets their groups of fields. Choosing one shows it in Diff.
 */
export function DiffActorsContents() {
  const diffService = useSourceControlDiff();
  const state = useSourceControlDiffState();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => (state.diff ? itemRows(state.diff) : []), [state.diff]);
  const shown = useMemo(() => visibleRows(rows, query, collapsed), [collapsed, query, rows]);
  const nodes = useMemo((): TreeViewNode[] => shown.map((row) => {
    const Icon = ICONS[row.icon];
    const changed = row.status !== "unchanged";
    return {
      id: row.id,
      label: row.label,
      depth: row.depth,
      hasChildren: row.hasChildren,
      expanded: !collapsed.has(row.id) || query.trim() !== "",
      icon: <Icon aria-hidden="true" />,
      trailing: changed ? <StatusLetter status={row.status} /> : undefined,
      muted: !changed && !row.changedBelow,
      ...(changed ? { tone: STATUS_TONE[row.status as Exclude<DiffStatus, "unchanged">] } : {}),
      draggable: false,
    };
  }), [collapsed, query, shown]);
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const select = useCallback((id: string) => diffService.select(id), [diffService]);

  if (!hasDiff(state)) return <DiffPlaceholder state={state} testId="diff-actors-panel" />;
  const view = state.diff!.view;
  const counts = view.kind === "scene" || view.kind === "graph" ? view.counts : null;
  const searchLabel = view.kind === "scene" ? "Search Actors" : "Search";

  return (
    <PanelFrame data-testid="diff-actors-panel">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-col gap-1.5 p-2">
          {counts ? <DiffCountBadges counts={counts} /> : null}
          <SearchInput value={query} onChange={setQuery} placeholder={searchLabel} aria-label={searchLabel} data-testid="diff-actors-search" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <TreeView
            nodes={nodes}
            selectedId={state.selection}
            onSelect={select}
            onToggleExpanded={toggle}
            emptyLabel={query.trim() ? "No Matches." : "Nothing Changed."}
            aria-label="Changed Items"
            data-testid="diff-actors-tree"
          />
        </div>
      </div>
    </PanelFrame>
  );
}

export function DiffActorsPanel(_props: IDockviewPanelProps) {
  void _props;
  return <DiffActorsContents />;
}
