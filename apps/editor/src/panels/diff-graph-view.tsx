import { memo, useMemo, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import type { GraphDiff, GraphDiffSection, PinValueChange } from "@haptic/assets/asset-diff";
import { GraphEditor, graphNodeTypes, type GraphDocument } from "@haptic/graph-ui";
import { Badge } from "@haptic/ui/components/badge";
import { Button } from "@haptic/ui/components/button";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import { STATUS_LABEL } from "./diff-status";

type Mode = "overlay" | "base" | "compare";
type NodeStatus = "added" | "removed" | "changed";
type GraphNode = GraphDocument["nodes"][number];

/** Node data the diff adds for its wrapper; the graph editor ignores `__` fields it does not know. */
const DIFF_STATUS = "__diffStatus";
const DIFF_PINS = "__diffPins";

const FRAME: Record<NodeStatus, string> = {
  added: "outline-(--success)",
  changed: "outline-(--warning)",
  removed: "outline-dashed outline-destructive opacity-70",
};
const TAG = { added: "success", changed: "warning", removed: "destructive" } as const;

/** A node component drawn as it is, outlined and tagged with what changed. */
function withDiffFrame<P extends { data: Record<string, unknown> }>(Inner: ComponentType<P>) {
  return memo(function DiffNode(props: P) {
    const status = props.data[DIFF_STATUS] as NodeStatus | undefined;
    return (
      <div className={cn("relative rounded-md", status && "outline-2 outline-offset-4", status && FRAME[status])} data-diff-status={status}>
        {status ? <Badge variant={TAG[status]} className="pointer-events-none absolute -top-7 right-0">{STATUS_LABEL[status]}</Badge> : null}
        <Inner {...props} />
      </div>
    );
  });
}

const DIFF_NODE_TYPES = {
  pinNode: withDiffFrame(graphNodeTypes.pinNode as ComponentType<ComponentProps<typeof graphNodeTypes.pinNode>>),
  variableGet: withDiffFrame(graphNodeTypes.variableGet as ComponentType<ComponentProps<typeof graphNodeTypes.variableGet>>),
};

/** Under a changed node's pins: each changed value, the old struck through beside the new. */
function renderPinChanges(_nodeId: string, data: Record<string, unknown>): ReactNode {
  const pins = data[DIFF_PINS] as PinValueChange[] | undefined;
  if (!pins || pins.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 border-t border-border px-3 py-1.5 text-xs" data-testid="diff-pin-changes">
      {pins.map((pin) => (
        <li key={pin.id} className="flex items-center gap-2">
          <span className="truncate text-muted-foreground">{pin.name}</span>
          {pin.base !== null ? <del className="text-destructive">{pin.base}</del> : null}
          {pin.compare !== null ? <span className="text-(--success)">{pin.compare}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function tagged(node: GraphNode, status: NodeStatus | undefined, pins: PinValueChange[] | undefined): GraphNode {
  if (!status) return node;
  return { ...node, data: { ...node.data, [DIFF_STATUS]: status, ...(pins?.length ? { [DIFF_PINS]: pins } : {}) } };
}

/**
 * The graph the canvas draws: the compare version, the base, or both
 * overlaid (removed nodes and wires from the base added to the compare's).
 */
function diffCanvasGraph(section: GraphDiffSection, mode: Mode): GraphDocument {
  const byId = new Map(section.nodes.map((node) => [node.id, node]));
  const mark = (node: GraphNode, keep: (status: NodeStatus) => boolean) => {
    const diff = byId.get(node.id);
    return tagged(node, diff && keep(diff.status) ? diff.status : undefined, diff?.pins);
  };
  const base = section.base ?? { nodes: [], edges: [] };
  const compare = section.compare ?? { nodes: [], edges: [] };
  if (mode === "base") return { nodes: base.nodes.map((node) => mark(node, (status) => status !== "added")), edges: base.edges };
  const nodes = compare.nodes.map((node) => mark(node, (status) => status !== "removed"));
  if (mode === "compare") return { nodes, edges: compare.edges };
  const present = new Set(compare.nodes.map((node) => node.id));
  const removedNodes = base.nodes.filter((node) => !present.has(node.id)).map((node) => mark(node, () => true));
  const ids = new Set(compare.edges.map((edge) => edge.id));
  const removed = new Set(section.edgesRemoved);
  const removedEdges = base.edges.filter((edge) => removed.has(edge.id)).map((edge) => (ids.has(edge.id) ? { ...edge, id: `base:${edge.id}` } : edge));
  return { nodes: [...nodes, ...removedNodes], edges: [...compare.edges, ...removedEdges] };
}

/**
 * A graph diff on the graph editor's own canvas, read-only: **Overlay**,
 * **Base** or the compare version; changed nodes outlined warning, added
 * success, removed destructive and dashed, each tagged.
 */
export default function GraphDiffView({ graph, selection, onSelect, baseLabel, compareLabel, toolbar }: {
  graph: GraphDiff;
  /** A graph (`event`, a function id) or a node in it (`<graph>/<node>`). */
  selection: string | null;
  onSelect: (id: string) => void;
  baseLabel: string;
  compareLabel: string;
  toolbar: (controls: ReactNode) => ReactNode;
}) {
  const [mode, setMode] = useState<Mode>("overlay");
  const changed = graph.sections.filter((section) => section.status !== "unchanged");
  const [sectionId, nodeId] = selection?.includes("/") ? selection.split("/", 2) as [string, string] : [selection, undefined];
  const section = changed.find((entry) => entry.id === sectionId) ?? changed[0];
  const document = useMemo(() => (section ? diffCanvasGraph(section, mode) : null), [mode, section]);
  const controls = (
    <ToggleGroup variant="outline" size="sm" spacing={0} aria-label="Show" value={[mode]} onValueChange={(value) => { if (value[0]) setMode(value[0] as Mode); }}>
      <ToggleGroupItem value="overlay" data-testid="diff-graph-overlay">Overlay</ToggleGroupItem>
      <ToggleGroupItem value="base" data-testid="diff-graph-base" title={baseLabel}>Base</ToggleGroupItem>
      <ToggleGroupItem value="compare" data-testid="diff-graph-compare">{compareLabel}</ToggleGroupItem>
    </ToggleGroup>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar(controls)}
      {changed.length > 1 ? (
        <div className="flex shrink-0 flex-wrap gap-1 px-1.5 pt-1.5" role="group" aria-label="Graphs">
          {changed.map((entry) => (
            <Button key={entry.id} variant={entry === section ? "secondary" : "ghost"} size="sm" aria-pressed={entry === section} onClick={() => onSelect(entry.id)} data-testid={`diff-graph-section-${entry.id}`}>
              {entry.title}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1" data-testid="diff-graph">
        {section && document ? (
          <GraphEditor
            key={`${section.id}:${mode}`}
            readOnly
            initialGraph={document}
            nodeTypes={DIFF_NODE_TYPES}
            renderNodeBody={renderPinChanges}
            {...(nodeId ? { focusedNodeId: nodeId } : {})}
          />
        ) : (
          <p className="p-2 text-sm text-muted-foreground">No Graph Changed.</p>
        )}
      </div>
    </div>
  );
}
