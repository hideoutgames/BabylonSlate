import type { GraphCanvasKind, GraphDiff, GraphDiffSection, GraphNodeDiff } from "@haptic/assets/asset-diff";
import type { GraphDocument, GraphEditorProps } from "@haptic/graph-ui";

// The Diff window's graph canvas, for every graph family: which versions it
// draws and how their nodes are marked. A family supplies only how its editor
// draws a stored version (`DiffCanvasFamily`); this module and
// `diff-graph-canvas.tsx` do the rest.

/** What the canvas shows: both versions overlaid, or one of them. */
export type DiffMode = "overlay" | "base" | "compare";
export type DiffNodeStatus = GraphNodeDiff["status"];

/** One changed value under a node: a pin's or a stored field's, old beside new. */
export interface DiffValueChange {
  id: string;
  name: string;
  base: string | null;
  compare: string | null;
}

/** Node data the diff adds for its frame; the graph editor ignores `__` fields it does not know. */
export const DIFF_STATUS = "__diffStatus";
export const DIFF_CHANGES = "__diffChanges";

/**
 * The canvases the Diff window draws, each loaded with its family's editor
 * code. A graph whose kind has none lists its nodes' changes as properties.
 */
export const DIFF_CANVAS_KINDS = ["script", "material", "particle", "behaviour-tree", "state-machine"] as const satisfies readonly GraphCanvasKind[];
export type DiffCanvasKind = (typeof DIFF_CANVAS_KINDS)[number];

const CANVAS_KINDS: ReadonlySet<string> = new Set(DIFF_CANVAS_KINDS);

export function hasDiffCanvas(kind: GraphCanvasKind): kind is DiffCanvasKind {
  return CANVAS_KINDS.has(kind);
}

/**
 * The changed graph an Actors selection shows: a graph (`event`, `state:<id>`),
 * a node in one (`<graph>/<node>`, which the canvas frames) or a function
 * member (`member:<id>`, whose graph has its id); else the first changed graph.
 */
export function graphDiffSection(graph: GraphDiff, selection: string | null): { section: GraphDiffSection | undefined; nodeId: string | undefined } {
  const chosen = selection?.startsWith("member:") ? selection.slice("member:".length) : selection;
  const slash = chosen ? chosen.indexOf("/") : -1;
  const sectionId = chosen && slash >= 0 ? chosen.slice(0, slash) : chosen;
  const changed = graph.sections.filter((section) => section.status !== "unchanged");
  const section = changed.find((entry) => entry.id === sectionId) ?? changed[0];
  const nodeId = chosen && slash >= 0 && section?.id === sectionId ? chosen.slice(slash + 1) : undefined;
  return { section, nodeId };
}

type NodeTypes = NonNullable<GraphEditorProps["nodeTypes"]>;

/**
 * What a graph family supplies to draw its graphs' diffs with its own
 * editor's node components; the shared canvas does the rest (versions,
 * overlay, frames and tags, changed values, one read-only editor).
 */
export interface DiffCanvasFamily {
  /** A stored version (`GraphDiffSection.base` / `compare`) as the family's editor draws it: pins and titles hydrated, laid out. */
  toGraph(stored: unknown): GraphDocument;
  /** Its node components by node type, beside the graph editor's pin nodes. */
  nodeTypes?: NodeTypes;
  /** Its own node body (a Material's Custom GLSL code), drawn above the changed values. */
  renderNodeBody?: GraphEditorProps["renderNodeBody"];
  /** Its own wires, how they attach, and its nodes' descriptions. */
  editorProps?: Pick<GraphEditorProps, "edgeTypes" | "defaultEdgeOptions" | "connectionMode" | "describeNode">;
  /** The class its editor's canvas carries, which its wire styles key on. */
  className?: string;
}

/** What a family's canvas is given. */
export interface DiffCanvasProps {
  section: GraphDiffSection;
  mode: DiffMode;
  /** The asset's type, which tells a family's variants apart (a Material Function, a 2D Animation Graph). */
  assetType: string;
  /** The node chosen in Actors, framed. */
  focusedNodeId?: string;
}

type GraphNode = GraphDocument["nodes"][number];
type GraphEdge = GraphDocument["edges"][number];

function changesOf(node: GraphNodeDiff): DiffValueChange[] {
  return [...node.pins, ...node.fields.map((field) => ({ id: `field:${field.id}`, name: field.label, base: field.base, compare: field.compare }))];
}

/** A node with its tag, and for a changed node its changed values; an added or removed node draws its values as they are. */
function tagged(node: GraphNode, diff: GraphNodeDiff | undefined, shown: (status: DiffNodeStatus) => boolean): GraphNode {
  if (!diff || !shown(diff.status)) return node;
  const changes = diff.status === "changed" ? changesOf(diff) : [];
  return { ...node, data: { ...node.data, [DIFF_STATUS]: diff.status, ...(changes.length > 0 ? { [DIFF_CHANGES]: changes } : {}) } };
}

/** A wire by its ends, as the diff compares wires: a remade wire is the same wire. */
function wireKey(edge: GraphEdge): string {
  return `${edge.source}\u0000${edge.sourceHandle ?? ""}\u0000${edge.target}\u0000${edge.targetHandle ?? ""}`;
}

const EMPTY: GraphDocument = { nodes: [], edges: [] };

/**
 * The graph the canvas draws, from both versions as the family's editor
 * draws them: the base or the compare version with their changed nodes
 * tagged, or both overlaid (the base's removed nodes, and its wires the
 * compare version lacks, added to the compare version's).
 */
export function diffCanvasDocument(section: GraphDiffSection, mode: DiffMode, base: GraphDocument | null, compare: GraphDocument | null): GraphDocument {
  const byId = new Map(section.nodes.map((node) => [node.id, node]));
  if (mode === "base") {
    const shown = base ?? EMPTY;
    return { ...shown, nodes: shown.nodes.map((node) => tagged(node, byId.get(node.id), (status) => status !== "added")) };
  }
  const shown = compare ?? EMPTY;
  const nodes = shown.nodes.map((node) => tagged(node, byId.get(node.id), (status) => status !== "removed"));
  if (mode === "compare") return { ...shown, nodes };
  const present = new Set(shown.nodes.map((node) => node.id));
  const removedNodes = (base?.nodes ?? []).filter((node) => !present.has(node.id)).map((node) => tagged(node, byId.get(node.id), () => true));
  const wires = new Set(shown.edges.map(wireKey));
  const ids = new Set(shown.edges.map((edge) => edge.id));
  const removedEdges = (base?.edges ?? []).filter((edge) => !wires.has(wireKey(edge))).map((edge) => (ids.has(edge.id) ? { ...edge, id: `base:${edge.id}` } : edge));
  return { ...shown, nodes: [...nodes, ...removedNodes], edges: [...shown.edges, ...removedEdges] };
}
