import { humanizePropertyLabel } from "@haptic/core";
import {
  countStatus,
  documentGroups,
  emptyCounts,
  formatDiffValue,
  groupStatus,
  isPlainObject,
  propertyRows,
  sameValue,
  statusOf,
  valueRow,
  type DiffCounts,
  type DiffStatus,
  type PropertyDiffGroup,
  type PropertyDiffRow,
} from "./asset-diff-values";

/**
 * The canvas that draws a graph: the script graph editor's (Classes, Scene
 * Scripts, an Animation Graph's state, rule and Animation Object graphs), or
 * a family's own (Material and Material Function, Particle Graph, Behaviour
 * Tree, Animation Graph State Machine), whose node components and editor
 * hydration load with that family's code.
 */
export type GraphCanvasKind = "script" | "material" | "particle" | "behaviour-tree" | "state-machine";

/** A node as the diff compares it, read from its family's stored form. */
export interface ComparedNode {
  id: string;
  type: string;
  /** Where the document stores it; absent where the editor's layout places it (a Behaviour Tree never arranged). */
  position?: { x: number; y: number };
  /** Its stored fields: pin values as `default:<pin>`; `__` fields are editor metadata and not compared, but `__disabled`. */
  data: Record<string, unknown>;
  /** As the family's editor titles it. */
  title: string;
  /** Pin names by id where the stored node carries no `__pins` (the family's catalog names them). */
  pinNames?: ReadonlyMap<string, string>;
}

/** A wire as the diff compares it: by its ends, so a remade wire is no change. */
export interface ComparedWire {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

/** One graph of a document, as its family reads it. */
export interface GraphSourceSection {
  /** Unique in the document: `event`, a function's id, `state:<id>`. */
  id: string;
  title: string;
  canvas: GraphCanvasKind;
  nodes: ComparedNode[];
  edges: ComparedWire[];
  /** The graph as the document stores it, which its canvas draws through the family's own editor path. */
  stored: unknown;
}

export type GraphMemberGroupId = "variables" | "functions" | "others" | "parameters" | "inputs" | "outputs";

/** A variable, function, event, parameter or function pin the document declares. */
export interface GraphSourceMember {
  id: string;
  name: string;
  group: GraphMemberGroupId;
  kind: string;
  /** What is compared. */
  value: unknown;
  /** `Float · 1.5`; absent to describe it by its graph's changes (`2 Nodes Changed`), else its kind. */
  summary?: string;
}

/** Settings of one item the graphs do not draw (an Animation Graph transition's Blend and Priority). */
export interface GraphSourceItem {
  id: string;
  title: string;
  value: Record<string, unknown>;
}

/** What a family reads from one version of its document. */
export interface GraphSource {
  sections: GraphSourceSection[];
  members: GraphSourceMember[];
  /** Items listed as property groups only when they changed. */
  items: GraphSourceItem[];
  /** The document's other fields, as property groups. */
  fields: Record<string, unknown>;
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
  /** Other stored fields that differ (a Print node's message, a disabled flag, a task's settings). */
  fields: PropertyDiffRow[];
  /** Only its position changed. */
  moved: boolean;
  /** Wires to or from it that were added or removed. */
  connections: number;
}

/** One graph: the Event Graph, a function's, a Material's, a state's. */
export interface GraphDiffSection {
  id: string;
  title: string;
  canvas: GraphCanvasKind;
  status: DiffStatus;
  /** Nodes that are not unchanged, the compare version's order then removed ones. */
  nodes: GraphNodeDiff[];
  edgesAdded: string[];
  edgesRemoved: string[];
  /** Both versions as stored, for the canvas; only for a section that changed. */
  base: unknown;
  compare: unknown;
}

export interface GraphMemberDiff {
  id: string;
  name: string;
  kind: string;
  status: Exclude<DiffStatus, "unchanged">;
  /** `Float · 1.5`, `2 Nodes Changed`. */
  summary: string;
}

/** Members under one heading of the Actors window: Variables, Functions, Parameters… */
export interface GraphMemberGroup {
  id: GraphMemberGroupId;
  title: string;
  members: GraphMemberDiff[];
}

export interface GraphDiff {
  kind: "graph";
  /** Every graph either version has; unchanged ones carry no nodes. */
  sections: GraphDiffSection[];
  /** Groups with a changed member, in a fixed order. */
  memberGroups: GraphMemberGroup[];
  /** Nodes and members. */
  counts: DiffCounts;
  /** Changed items, then the document's other fields. */
  groups: PropertyDiffGroup[];
}

const MEMBER_GROUPS: ReadonlyArray<readonly [GraphMemberGroupId, string]> = [
  ["variables", "Variables"],
  ["parameters", "Parameters"],
  ["inputs", "Inputs"],
  ["outputs", "Outputs"],
  ["functions", "Functions"],
  ["others", "Events And Dispatchers"],
];

const PIN_DEFAULT_PREFIX = "default:";
/** Stored node fields shown as such; other `__` fields are the catalog's metadata. */
const SHOWN_META = new Map([["__disabled", "Disabled"]]);

type Pin = { id?: unknown; name?: unknown };

function pinsOf(node: ComparedNode | undefined): Pin[] {
  const pins = node?.data.__pins;
  return Array.isArray(pins) ? (pins as Pin[]) : [];
}

function pinName(id: string, base: ComparedNode | undefined, compare: ComparedNode | undefined): string {
  const named = compare?.pinNames?.get(id) ?? base?.pinNames?.get(id);
  if (named) return named;
  const pin = [...pinsOf(compare), ...pinsOf(base)].find((entry) => entry.id === id);
  return typeof pin?.name === "string" && pin.name !== "" ? pin.name : humanizePropertyLabel(id);
}

/** A stored field as rows: an object (a task's settings) by its own keys, anything else as one row. */
function fieldRows(key: string, before: unknown, after: unknown): PropertyDiffRow[] {
  if ((isPlainObject(before) || before === undefined) && (isPlainObject(after) || after === undefined)) {
    return propertyRows(before as Record<string, unknown> | undefined, after as Record<string, unknown> | undefined, `${key}.`).filter((row) => row.changed);
  }
  return [valueRow(key, SHOWN_META.get(key) ?? humanizePropertyLabel(key), before, after)];
}

function nodeDiff(base: ComparedNode | undefined, compare: ComparedNode | undefined, connections: number): GraphNodeDiff | null {
  const shown = compare ?? base!;
  const sameNode = base !== undefined && compare !== undefined;
  const status: DiffStatus = !sameNode ? (base ? "removed" : "added")
    : base.type === compare.type && sameValue(base.position, compare.position) && sameValue(base.data, compare.data) ? "unchanged" : "changed";
  if (status === "unchanged" && connections === 0) return null;
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
      const ids = (node: ComparedNode | undefined) => pinsOf(node).map((pin) => String(pin.id));
      if (!sameValue(ids(base), ids(compare))) fields.push(valueRow("__pins", "Pins", base ? ids(base).length : undefined, compare ? ids(compare).length : undefined));
    } else if (!key.startsWith("__") || SHOWN_META.has(key)) {
      fields.push(...fieldRows(key, before, after));
    }
  }
  const moved = sameNode && status === "changed" && pins.length === 0 && fields.length === 0 && base.type === compare.type && !sameValue(base.position, compare.position);
  if (sameNode && base.type !== compare.type) fields.unshift(valueRow("type", "Node", base.type, compare.type));
  return { id: shown.id, status: status === "unchanged" ? "changed" : status, title: shown.title, pins, fields, moved, connections };
}

function wireKey(edge: ComparedWire): string {
  return `${edge.source}\u0000${edge.sourceHandle ?? ""}\u0000${edge.target}\u0000${edge.targetHandle ?? ""}`;
}

function diffSection(base: GraphSourceSection | undefined, compare: GraphSourceSection | undefined, counts: DiffCounts): GraphDiffSection {
  const shown = compare ?? base!;
  const before = new Map((base?.nodes ?? []).map((node) => [node.id, node]));
  const after = new Map((compare?.nodes ?? []).map((node) => [node.id, node]));
  // Wires by their ends: an id is regenerated when a wire is remade, which changes nothing.
  const baseWires = new Map((base?.edges ?? []).map((edge) => [wireKey(edge), edge]));
  const compareWires = new Map((compare?.edges ?? []).map((edge) => [wireKey(edge), edge]));
  const added = [...compareWires].filter(([key]) => !baseWires.has(key)).map(([, edge]) => edge);
  const removed = [...baseWires].filter(([key]) => !compareWires.has(key)).map(([, edge]) => edge);
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
  const status: DiffStatus = !base ? "added" : !compare ? "removed" : nodes.length > 0 || added.length > 0 || removed.length > 0 ? "changed" : "unchanged";
  return {
    id: shown.id,
    title: shown.title,
    canvas: shown.canvas,
    status,
    nodes,
    edgesAdded: added.map((edge) => edge.id),
    edgesRemoved: removed.map((edge) => edge.id),
    base: status === "unchanged" ? null : base?.stored ?? null,
    compare: status === "unchanged" ? null : compare?.stored ?? null,
  };
}

/** By id: the compare version's order, then what only the base has. */
function pair<T extends { id: string }>(base: readonly T[], compare: readonly T[]): Array<[T | undefined, T | undefined]> {
  const before = new Map(base.map((entry) => [entry.id, entry]));
  const after = new Map(compare.map((entry) => [entry.id, entry]));
  return [...new Set([...after.keys(), ...before.keys()])].map((id) => [before.get(id), after.get(id)]);
}

function nodeCountSummary(section: GraphDiffSection): string {
  return section.nodes.length === 1 ? "1 Node Changed" : `${section.nodes.length} Nodes Changed`;
}

/**
 * Two versions of a graph document, as its family read them: each graph by
 * node id with changed pin values and wires, the members it declares, the
 * items it lists when they changed and its other fields as property groups.
 */
export function diffGraphSources(base: GraphSource | null, compare: GraphSource | null): GraphDiff {
  const counts = emptyCounts();
  const sections = pair(base?.sections ?? [], compare?.sections ?? []).map(([before, after]) => diffSection(before, after, counts));
  const sectionById = new Map(sections.map((section) => [section.id, section]));

  const grouped = new Map<GraphMemberGroupId, GraphMemberDiff[]>();
  for (const [before, after] of pair(base?.members ?? [], compare?.members ?? [])) {
    const shown = (after ?? before)!;
    const section = sectionById.get(shown.id);
    let status = statusOf(before?.value, after?.value);
    if (status === "unchanged" && section && section.status !== "unchanged") status = "changed";
    if (status === "unchanged") continue;
    countStatus(counts, status);
    const summary = shown.summary ?? (section && section.nodes.length > 0 ? nodeCountSummary(section) : humanizePropertyLabel(shown.kind));
    const list = grouped.get(shown.group) ?? [];
    list.push({ id: shown.id, name: shown.name, kind: shown.kind, status, summary });
    grouped.set(shown.group, list);
  }
  const memberGroups = MEMBER_GROUPS.filter(([id]) => grouped.has(id)).map(([id, title]) => ({ id, title, members: grouped.get(id)! }));

  const items: PropertyDiffGroup[] = [];
  for (const [before, after] of pair(base?.items ?? [], compare?.items ?? [])) {
    const rows = propertyRows(before?.value, after?.value, "");
    const status = groupStatus(rows, statusOf(before?.value, after?.value));
    if (status !== "unchanged") items.push({ id: (after ?? before)!.id, title: (after ?? before)!.title, status, rows });
  }
  const groups = [...items, ...documentGroups(base?.fields, compare?.fields, "Graph")];
  return { kind: "graph", sections, memberGroups, counts, groups };
}
