import { displayNodeTitle, humanizePropertyLabel, type GraphClassMember, type SerializedGraph } from "@haptic/core";
import {
  countStatus,
  documentGroups,
  emptyCounts,
  formatDiffValue,
  isPlainObject,
  sameValue,
  statusOf,
  valueRow,
  type DiffCounts,
  type DiffStatus,
  type PropertyDiffGroup,
  type PropertyDiffRow,
} from "./asset-diff-values";

type GraphNode = SerializedGraph["nodes"][number];
type GraphEdge = SerializedGraph["edges"][number];

/** The nodes and wires of one graph, as the canvas draws them. */
export interface GraphPart {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** An inline pin value that differs: the pin's name with both values. */
export interface PinValueChange {
  id: string;
  name: string;
  base: string | null;
  compare: string | null;
}

export interface GraphNodeDiff {
  id: string;
  status: Exclude<DiffStatus, "unchanged">;
  title: string;
  pins: PinValueChange[];
  /** Other stored fields that differ (a Print node's message, a disabled flag). */
  fields: PropertyDiffRow[];
  /** Only its position changed. */
  moved: boolean;
  /** Wires to or from it that were added or removed. */
  connections: number;
}

/** The Event Graph or one function's graph. */
export interface GraphDiffSection {
  /** `event`, or the function member's id. */
  id: string;
  title: string;
  status: DiffStatus;
  /** Nodes that are not unchanged, the compare version's order then removed ones. */
  nodes: GraphNodeDiff[];
  edgesAdded: string[];
  edgesRemoved: string[];
  /** Both versions for the canvas; only for a section that changed. */
  base: GraphPart | null;
  compare: GraphPart | null;
}

/** A variable, function, event, dispatcher or interface the Class declares. */
export interface GraphMemberDiff {
  id: string;
  name: string;
  kind: string;
  status: Exclude<DiffStatus, "unchanged">;
  /** `Float · 1.5`, `2 Nodes Changed`. */
  summary: string;
}

export interface GraphDiff {
  kind: "graph";
  /** Every graph either version has; unchanged ones carry no nodes. */
  sections: GraphDiffSection[];
  variables: GraphMemberDiff[];
  functions: GraphMemberDiff[];
  /** Events, dispatchers and interfaces. */
  others: GraphMemberDiff[];
  /** Nodes and members. */
  counts: DiffCounts;
  /** Other document fields: components, Actor Defaults. */
  groups: PropertyDiffGroup[];
}

const EVENT_GRAPH = "event";
const PIN_DEFAULT_PREFIX = "default:";
const GRAPH_SKIP = new Set(["nodes", "edges", "members", "functionGraphs"]);
/** Stored node fields shown as such; other `__` fields are the catalog's metadata. */
const SHOWN_META = new Map([["__disabled", "Disabled"]]);

type Pin = { id?: unknown; name?: unknown };

function pinsOf(node: GraphNode | undefined): Pin[] {
  const pins = node?.data.__pins;
  return Array.isArray(pins) ? (pins as Pin[]) : [];
}

/** A node's canvas title, as the graph editor draws it. */
export function graphNodeTitle(node: GraphNode): string {
  const data = node.data;
  const nodeType = typeof data.__nodeType === "string" ? data.__nodeType : node.type;
  return displayNodeTitle(nodeType, typeof data.title === "string" ? data.title : undefined, typeof data.eventQualifier === "string" ? data.eventQualifier : undefined);
}

function pinName(id: string, base: GraphNode | undefined, compare: GraphNode | undefined): string {
  const pin = [...pinsOf(compare), ...pinsOf(base)].find((entry) => entry.id === id);
  return typeof pin?.name === "string" && pin.name !== "" ? pin.name : humanizePropertyLabel(id);
}

function nodeDiff(base: GraphNode | undefined, compare: GraphNode | undefined, connections: number): GraphNodeDiff | null {
  const status = statusOf(base, compare);
  if (status === "unchanged" && connections === 0) return null;
  const shown = compare ?? base!;
  const pins: PinValueChange[] = [];
  const fields: PropertyDiffRow[] = [];
  const keys = new Set([...Object.keys(compare?.data ?? {}), ...Object.keys(base?.data ?? {})]);
  for (const key of keys) {
    const before = base?.data[key];
    const after = compare?.data[key];
    if (sameValue(before, after)) continue;
    if (key.startsWith(PIN_DEFAULT_PREFIX)) {
      const id = key.slice(PIN_DEFAULT_PREFIX.length);
      pins.push({ id, name: pinName(id, base, compare), base: before === undefined ? null : formatDiffValue(before, id), compare: after === undefined ? null : formatDiffValue(after, id) });
    } else if (key === "__pins") {
      const ids = (node: GraphNode | undefined) => pinsOf(node).map((pin) => String(pin.id));
      if (!sameValue(ids(base), ids(compare))) fields.push(valueRow("__pins", "Pins", base ? ids(base).length : undefined, compare ? ids(compare).length : undefined));
    } else if (!key.startsWith("__") || SHOWN_META.has(key)) {
      fields.push(valueRow(key, SHOWN_META.get(key) ?? humanizePropertyLabel(key), before, after));
    }
  }
  const moved = status === "changed" && pins.length === 0 && fields.length === 0 && base!.type === compare!.type && !sameValue(base!.position, compare!.position);
  if (status === "changed" && base!.type !== compare!.type) fields.unshift(valueRow("type", "Node", base!.type, compare!.type));
  return { id: shown.id, status: status === "unchanged" ? "changed" : status, title: graphNodeTitle(shown), pins, fields, moved, connections };
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}\u0000${edge.sourceHandle ?? ""}\u0000${edge.target}\u0000${edge.targetHandle ?? ""}`;
}

function diffSection(id: string, title: string, base: GraphPart | null, compare: GraphPart | null, counts: DiffCounts): GraphDiffSection {
  const before = new Map((base?.nodes ?? []).map((node) => [node.id, node]));
  const after = new Map((compare?.nodes ?? []).map((node) => [node.id, node]));
  // Wires by their ends: an id is regenerated when a wire is remade, which changes nothing.
  const baseEdges = new Map((base?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
  const compareEdges = new Map((compare?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
  const added = [...compareEdges].filter(([key]) => !baseEdges.has(key)).map(([, edge]) => edge);
  const removed = [...baseEdges].filter(([key]) => !compareEdges.has(key)).map(([, edge]) => edge);
  const edgesAdded = added.map((edge) => edge.id);
  const edgesRemoved = removed.map((edge) => edge.id);
  const touched = new Map<string, number>();
  for (const edge of [...added, ...removed]) {
    for (const end of [edge.source, edge.target]) touched.set(end, (touched.get(end) ?? 0) + 1);
  }
  const nodes: GraphNodeDiff[] = [];
  for (const nodeId of new Set([...after.keys(), ...before.keys()])) {
    const diff = nodeDiff(before.get(nodeId), after.get(nodeId), touched.get(nodeId) ?? 0);
    if (!diff) continue;
    nodes.push(diff);
    countStatus(counts, diff.status);
  }
  const presence = statusOf(base ?? undefined, compare ?? undefined);
  const status: DiffStatus = presence === "added" || presence === "removed" ? presence : nodes.length > 0 || edgesAdded.length > 0 || edgesRemoved.length > 0 ? "changed" : "unchanged";
  return {
    id,
    title,
    status,
    nodes,
    edgesAdded,
    edgesRemoved,
    base: status === "unchanged" ? null : base,
    compare: status === "unchanged" ? null : compare,
  };
}

function typeLabel(member: GraphClassMember): string {
  const type = member.typeId ? humanizePropertyLabel(member.typeId) : "";
  if (member.container === "array") return `${type} Array`;
  if (member.container === "map") return `${type} Map`;
  return type;
}

function memberSummary(member: GraphClassMember, section: GraphDiffSection | undefined): string {
  if (member.kind === "variable") {
    const type = typeLabel(member);
    return member.defaultValue === undefined ? type : `${type} · ${formatDiffValue(member.defaultValue, member.name)}`;
  }
  if (section && section.nodes.length > 0) return section.nodes.length === 1 ? "1 Node Changed" : `${section.nodes.length} Nodes Changed`;
  return humanizePropertyLabel(member.kind);
}

function graphOf(value: unknown): SerializedGraph | null {
  return isPlainObject(value) && Array.isArray(value.nodes) && Array.isArray(value.edges) ? (value as unknown as SerializedGraph) : null;
}

/** Whether a document is a node graph (Class, Material, Particle Graph…): it stores `nodes` and `edges`. */
export function isGraphDocument(value: unknown): boolean {
  return graphOf(value) !== null;
}

/**
 * Two versions of a graph document compared by node id: the Event Graph and
 * each function graph, with changed pin values and wires; the Class's
 * variables, functions and other members; other fields as property groups.
 */
export function diffGraphDocuments(baseValue: unknown, compareValue: unknown): GraphDiff {
  const base = graphOf(baseValue);
  const compare = graphOf(compareValue);
  const counts = emptyCounts();
  const baseMembers = new Map((base?.members ?? []).map((member) => [member.id, member]));
  const compareMembers = new Map((compare?.members ?? []).map((member) => [member.id, member]));
  const memberName = (id: string) => (compareMembers.get(id) ?? baseMembers.get(id))?.name ?? id;

  const sections: GraphDiffSection[] = [diffSection(EVENT_GRAPH, "Event Graph", base ? { nodes: base.nodes, edges: base.edges } : null, compare ? { nodes: compare.nodes, edges: compare.edges } : null, counts)];
  const functionIds = new Set([...Object.keys(compare?.functionGraphs ?? {}), ...Object.keys(base?.functionGraphs ?? {})]);
  for (const id of functionIds) {
    const before = base?.functionGraphs?.[id];
    const after = compare?.functionGraphs?.[id];
    sections.push(diffSection(id, memberName(id), before ? { nodes: before.nodes, edges: before.edges } : null, after ? { nodes: after.nodes, edges: after.edges } : null, counts));
  }
  const sectionById = new Map(sections.map((section) => [section.id, section]));

  const variables: GraphMemberDiff[] = [];
  const functions: GraphMemberDiff[] = [];
  const others: GraphMemberDiff[] = [];
  for (const id of new Set([...compareMembers.keys(), ...baseMembers.keys()])) {
    const before = baseMembers.get(id);
    const after = compareMembers.get(id);
    const section = sectionById.get(id);
    let status = statusOf(before, after);
    if (status === "unchanged" && section && section.status !== "unchanged") status = "changed";
    if (status === "unchanged") continue;
    const shown = after ?? before!;
    countStatus(counts, status);
    const entry: GraphMemberDiff = { id, name: shown.name, kind: shown.kind, status, summary: memberSummary(shown, section) };
    if (shown.kind === "variable") variables.push(entry);
    else if (shown.kind === "function") functions.push(entry);
    else others.push(entry);
  }
  const groups = documentGroups(base as unknown as Record<string, unknown> | undefined, compare as unknown as Record<string, unknown> | undefined, "Graph", GRAPH_SKIP);
  return { kind: "graph", sections, variables, functions, others, counts, groups };
}
