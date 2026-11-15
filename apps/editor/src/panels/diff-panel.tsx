import type { IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { ExternalLinkIcon, Undo2Icon } from "lucide-react";
import { assetSummaryGroup, valueRow, type AssetDiff, type GraphDiff, type PropertyDiffGroup, type PropertyDiffRow, type SceneDiff } from "@haptic/assets/asset-diff";
import { documentKindForAssetType, humanizePropertyLabel } from "@haptic/core";
import { PanelFrame, SelectableText } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Label } from "@haptic/ui/components/label";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { Switch } from "@haptic/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { useSourceControlActions, useSourceControlDiff, useSourceControlDiffState } from "../components/source-control-actions";
import { useDocumentActions, useIntegratedSyncState } from "../context/document-context";
import { refLabel, type DiffTarget } from "../services/source-control-diff";
import { DiffPlaceholder, StatusBadge } from "./diff-common";
import { ASSET_ITEM, hasDiff } from "./diff-status";
import { PropertyDiffTable, type DiffLayout as Layout } from "./diff-property-table";
import { TextureDiffView } from "./diff-texture-view";

/** The graph canvas brings the graph editor, so it loads with the first graph diff. */
const GraphDiffView = lazy(() => import("./diff-graph-view"));

function kindLabel(type: string): string {
  return humanizePropertyLabel(type.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

interface Shown {
  title: string;
  groups: PropertyDiffGroup[] | null;
  status: AssetDiff["status"];
}

/** The asset itself: its header and chunks, then its document-level fields. */
function assetGroups(diff: AssetDiff): Shown {
  const view = diff.view;
  const fields = view.kind === "scene" ? view.scene : view.kind === "graph" || view.kind === "properties" ? view.groups : [];
  return { title: diff.name, groups: [assetSummaryGroup(diff), ...fields], status: diff.status };
}

/** What the Scene view shows for the chosen row: an actor's groups, the asset itself, or why there is nothing. */
function sceneGroups(diff: AssetDiff, view: SceneDiff, selection: string | null): Shown {
  const row = selection ? view.rows.find((entry) => entry.id === selection) : undefined;
  if (row?.kind === "actor") return { title: row.name, groups: view.actors[row.id] ?? null, status: row.status };
  if (row?.kind === "folder") return { title: row.name, groups: null, status: row.status };
  return assetGroups(diff);
}

/** A changed node as properties: its pin values and fields, for graph families the canvas does not draw. */
function nodeRows(node: GraphDiff["sections"][number]["nodes"][number]): PropertyDiffRow[] {
  const rows: PropertyDiffRow[] = node.pins.map((pin) => ({ id: `pin:${pin.id}`, label: pin.name, base: pin.base, compare: pin.compare, changed: true }));
  rows.push(...node.fields.map((field) => ({ ...field, id: `field:${field.id}` })));
  if (node.status !== "changed") rows.unshift(valueRow("node", "Node", node.status === "added" ? undefined : node.title, node.status === "removed" ? undefined : node.title, String));
  if (node.moved) rows.push({ id: "position", label: "Position", base: "Moved", compare: "Moved", changed: true });
  if (node.connections > 0) rows.push({ id: "wires", label: "Wires", base: null, compare: node.connections === 1 ? "1 Changed" : `${node.connections} Changed`, changed: true });
  return rows;
}

/** The chosen graph's (or node's) changes as one group per node. */
function graphGroups(diff: AssetDiff, graph: GraphDiff, selection: string | null): Shown {
  const [sectionId, nodeId] = selection?.includes("/") ? selection.split("/", 2) : [selection, null];
  const section = graph.sections.find((entry) => entry.id === sectionId && entry.status !== "unchanged") ?? graph.sections.find((entry) => entry.status !== "unchanged");
  if (!section) return assetGroups(diff);
  const nodes = section.nodes.filter((node) => !nodeId || node.id === nodeId);
  return {
    title: nodeId && nodes[0] ? nodes[0].title : section.title,
    groups: nodes.map((node) => ({ id: `node:${node.id}`, title: node.title, status: node.status, rows: nodeRows(node) })),
    status: nodeId && nodes[0] ? nodes[0].status : section.status,
  };
}

function Toolbar({ children, target, diff }: { children: ReactNode; target: DiffTarget; diff: AssetDiff }) {
  const { openDocument } = useDocumentActions();
  const actions = useSourceControlActions();
  const kind = diff.type ? documentKindForAssetType(diff.type) : null;
  const label = diff.type ? kindLabel(diff.type) : "Asset";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-1.5" data-testid="diff-toolbar">
      {children}
      <span className="flex-1" />
      <Button
        variant="outline"
        size="sm"
        data-testid="diff-open-asset"
        disabled={!kind || diff.status === "removed"}
        onClick={() => { if (kind) void openDocument({ kind, path: target.path, label: target.name }); }}
      >
        <ExternalLinkIcon data-icon="inline-start" />
        Open {label}
      </Button>
      <Button
        variant="outline"
        size="sm"
        data-testid="diff-revert"
        // Reverting writes the base version; the working copy as base has nothing to write.
        disabled={target.base.kind === "working"}
        onClick={() => actions.requestRevert({ path: target.path, name: target.name, ref: target.base })}
      >
        <Undo2Icon data-icon="inline-start" />
        Revert Asset
      </Button>
    </div>
  );
}

function LayoutControls({ layout, onLayout, changedOnly, onChangedOnly }: { layout: Layout; onLayout: (layout: Layout) => void; changedOnly: boolean; onChangedOnly: (value: boolean) => void }) {
  return (
    <>
      <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="Layout" value={[layout]} onValueChange={(value) => { if (value[0]) onLayout(value[0] as Layout); }}>
        <ToggleGroupItem value="side-by-side" data-testid="diff-layout-side-by-side">Side By Side</ToggleGroupItem>
        <ToggleGroupItem value="inline" data-testid="diff-layout-inline">Inline</ToggleGroupItem>
      </ToggleGroup>
      <div className="flex items-center gap-1.5">
        <Switch id="diff-changed-only" checked={changedOnly} onCheckedChange={onChangedOnly} data-testid="diff-changed-only" />
        <Label htmlFor="diff-changed-only" className="text-sm font-normal">Changed Only</Label>
      </div>
    </>
  );
}

/**
 * The Source Control tab's Diff window: the chosen asset's two versions in
 * the view for its kind (Scenes and other assets as properties, graphs on
 * the canvas, Textures as images), with **Open <Kind>** and **Revert Asset**.
 */
export function DiffContents() {
  const state = useSourceControlDiffState();
  const diffService = useSourceControlDiff();
  const snapshot = useIntegratedSyncState();
  const [layout, setLayout] = useState<Layout>("side-by-side");
  const [changedOnly, setChangedOnly] = useState(false);
  if (!hasDiff(state)) return <DiffPlaceholder state={state} testId="diff-panel" />;
  const diff = state.diff!;
  const target = state.target!;
  const baseLabel = refLabel(target.base, snapshot);
  const compareLabel = refLabel(target.compare, snapshot);
  const view = diff.view;

  // The canvas draws script graphs (Class and the Scene Script) with the graph editor's own node components.
  const canvas = state.selection !== ASSET_ITEM && ((view.kind === "graph" && diff.type !== "" && documentKindForAssetType(diff.type) === "graph") || (view.kind === "scene" && state.selection === "script" && view.script));
  if (canvas) {
    const graph = view.kind === "graph" ? view : view.script!;
    return (
      <PanelFrame data-testid="diff-panel">
        <Suspense fallback={null}>
          <GraphDiffView
            graph={graph}
            selection={view.kind === "graph" ? state.selection : null}
            onSelect={(id) => diffService.select(id)}
            baseLabel={baseLabel}
            compareLabel={compareLabel}
            toolbar={(controls) => <Toolbar target={target} diff={diff}>{controls}</Toolbar>}
          />
        </Suspense>
      </PanelFrame>
    );
  }

  if (view.kind === "texture" && state.selection !== ASSET_ITEM) {
    return (
      <PanelFrame data-testid="diff-panel">
        <TextureDiffView
          diff={diff}
          view={view}
          baseLabel={baseLabel}
          compareLabel={compareLabel}
          toolbar={(controls) => <Toolbar target={target} diff={diff}>{controls}</Toolbar>}
        />
      </PanelFrame>
    );
  }

  const shown = state.selection === ASSET_ITEM ? assetGroups(diff)
    : view.kind === "scene" ? sceneGroups(diff, view, state.selection)
      : view.kind === "graph" ? graphGroups(diff, view, state.selection)
        : assetGroups(diff);
  return (
    <PanelFrame data-testid="diff-panel">
      <div className="flex h-full min-h-0 flex-col">
        <Toolbar target={target} diff={diff}>
          <LayoutControls layout={layout} onLayout={setLayout} changedOnly={changedOnly} onChangedOnly={setChangedOnly} />
        </Toolbar>
        <div className="flex shrink-0 items-center gap-2 px-2 py-1.5 text-sm">
          <span className="truncate font-medium" data-testid="diff-item-name">{shown.title}</span>
          <StatusBadge status={shown.status} />
          <span className="flex-1" />
          <SelectableText className="truncate text-xs text-muted-foreground">{target.path}</SelectableText>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {shown.groups ? (
            <PropertyDiffTable groups={shown.groups} layout={layout} changedOnly={changedOnly} baseLabel={baseLabel} compareLabel={compareLabel} />
          ) : (
            <p className="p-2 text-sm text-muted-foreground" data-testid="diff-no-rows">No Changes To {shown.title}.</p>
          )}
        </ScrollArea>
      </div>
    </PanelFrame>
  );
}

export function DiffPanel(_props: IDockviewPanelProps) {
  void _props;
  return <DiffContents />;
}
