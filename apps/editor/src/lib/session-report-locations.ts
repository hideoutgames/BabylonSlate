import {
  parseBehaviourTreeDocument,
  titleForBtClassId,
} from "@babylonslate/behaviour-tree";
import type { SerializedGraph } from "@babylonslate/core";
import { displayNodeTitle } from "@babylonslate/graph-ui";
import type { SessionReportEntry } from "@babylonslate/runtime";
import { hydrateSerializedGraphForEditor } from "../services/graph-validation";

/**
 * The asset a session-report entry names. Runtime Class scripts report the
 * asset path in `assetGuid`; behaviour trees and physics report the guid.
 */
export interface SessionReportAsset {
  guid: string;
  path: string;
  name: string;
  type: string;
}

export interface SessionReportLocationSources {
  /** Resolve an entry's `assetGuid` (guid or path) to an indexed asset. */
  findAsset(ref: string): SessionReportAsset | undefined;
  /** Working content of the asset's open document, when it is open. */
  openContent(asset: SessionReportAsset): unknown;
  /** Saved document payload of an asset that is not open. */
  readContent(asset: SessionReportAsset): Promise<unknown>;
}

/** Display names resolved for one report; missing keys fall back to raw ids. */
export interface SessionReportLabels {
  assets: ReadonlyMap<string, string>;
  /** Keyed by {@link sessionReportNodeKey}. */
  nodes: ReadonlyMap<string, string>;
}

/** Per-report cache of asset lookups and document reads, keyed by asset ref. */
export type SessionReportLocationCache = Map<
  string,
  Promise<{ asset: SessionReportAsset; content: unknown } | null>
>;

export const EMPTY_SESSION_REPORT_LABELS: SessionReportLabels = {
  assets: new Map(),
  nodes: new Map(),
};

export const UNKNOWN_ASSET_LABEL = "Unknown Asset";
/** The location of an entry that has no asset to open. */
export const NO_SOURCE_LABEL = "No Source";

export function sessionReportNodeId(
  entry: Pick<SessionReportEntry, "btNodeId" | "nodeId">,
): string | undefined {
  return entry.btNodeId ?? entry.nodeId;
}

export function sessionReportNodeKey(assetRef: string, nodeId: string): string {
  return `${assetRef}\u0000${nodeId}`;
}

export function sessionReportAssetLabel(
  labels: SessionReportLabels,
  assetRef: string | undefined,
): string {
  if (!assetRef) return UNKNOWN_ASSET_LABEL;
  return labels.assets.get(assetRef) ?? assetRef;
}

/** `Enemy AI › Move To Target`, or the raw ids where a name is unknown. */
export function sessionReportLocationLabel(
  labels: SessionReportLabels,
  entry: Pick<SessionReportEntry, "assetGuid" | "btNodeId" | "nodeId">,
): string {
  const asset = sessionReportAssetLabel(labels, entry.assetGuid);
  const nodeId = sessionReportNodeId(entry);
  if (!nodeId) return asset;
  const node =
    labels.nodes.get(sessionReportNodeKey(entry.assetGuid ?? "", nodeId)) ??
    nodeId;
  return `${asset} › ${node}`;
}

export interface SessionReportGroup {
  /** The entries' shared `assetGuid`; empty when the runtime named no asset. */
  assetRef: string;
  entries: SessionReportEntry[];
  errors: number;
  warnings: number;
}

/** Group entries by owning asset, in first-reported order. */
export function groupSessionReportEntries(
  entries: readonly SessionReportEntry[],
): SessionReportGroup[] {
  const groups = new Map<string, SessionReportGroup>();
  for (const entry of entries) {
    const assetRef = entry.assetGuid ?? "";
    let group = groups.get(assetRef);
    if (!group) {
      group = { assetRef, entries: [], errors: 0, warnings: 0 };
      groups.set(assetRef, group);
    }
    group.entries.push(entry);
    if (entry.severity === "error") group.errors += 1;
    else group.warnings += 1;
  }
  return [...groups.values()];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type GraphSlice = Pick<SerializedGraph, "nodes" | "edges">;

function graphSlice(value: unknown): GraphSlice | null {
  const row = record(value);
  if (!row || !Array.isArray(row.nodes)) return null;
  return {
    nodes: row.nodes as SerializedGraph["nodes"],
    edges: Array.isArray(row.edges) ? (row.edges as SerializedGraph["edges"]) : [],
  };
}

/** Event graph, function graphs, and Animation Graph object / rule graphs. */
function graphSlices(content: Record<string, unknown>): GraphSlice[] {
  const slices: GraphSlice[] = [];
  const push = (value: unknown) => {
    const slice = graphSlice(value);
    if (slice) slices.push(slice);
  };
  push(content);
  for (const fn of Object.values(record(content.functionGraphs) ?? {})) push(fn);
  push(content.animationObject);
  if (Array.isArray(content.transitions)) {
    for (const transition of content.transitions) push(record(transition)?.ruleGraph);
  }
  return slices;
}

type GraphNode = SerializedGraph["nodes"][number];

/** Hydrated nodes per authored node list, so a report hydrates each graph once. */
const hydratedSlices = new WeakMap<object, ReadonlyMap<string, GraphNode> | null>();

function hydratedNodes(
  content: Record<string, unknown>,
  slice: GraphSlice,
): ReadonlyMap<string, GraphNode> | null {
  if (hydratedSlices.has(slice.nodes)) return hydratedSlices.get(slice.nodes)!;
  let nodes: ReadonlyMap<string, GraphNode> | null = null;
  try {
    // Hydration supplies catalog titles (Call / Cast / input events) the canvas shows.
    const graph = hydrateSerializedGraphForEditor({
      nodes: slice.nodes,
      edges: slice.edges,
      members: Array.isArray(content.members)
        ? (content.members as SerializedGraph["members"])
        : undefined,
    });
    nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  } catch {
    // Keep the authored data; a stale document still has its node types.
  }
  hydratedSlices.set(slice.nodes, nodes);
  return nodes;
}

function graphNodeTitle(
  content: Record<string, unknown>,
  nodeId: string,
): string | null {
  for (const slice of graphSlices(content)) {
    const node = slice.nodes.find((candidate) => candidate?.id === nodeId);
    if (!node) continue;
    let data = record(node.data) ?? {};
    let type = typeof node.type === "string" ? node.type : "";
    const hydrated = hydratedNodes(content, slice)?.get(nodeId);
    if (hydrated) {
      data = hydrated.data;
      type = hydrated.type;
    }
    const nodeType = typeof data.__nodeType === "string" ? data.__nodeType : type;
    if (!nodeType) return null;
    return displayNodeTitle(
      nodeType,
      typeof data.title === "string" ? data.title : undefined,
      typeof data.eventQualifier === "string" ? data.eventQualifier : undefined,
    );
  }
  return null;
}

function behaviourTreeNodeTitle(content: unknown, nodeId: string): string | null {
  const tree = parseBehaviourTreeDocument(content);
  if (!tree) return null;
  for (const node of tree.nodes) {
    if (node.id === nodeId) return titleForBtClassId(node.classId);
    const row =
      node.decorators.find((entry) => entry.id === nodeId) ??
      node.services.find((entry) => entry.id === nodeId);
    if (row) return titleForBtClassId(row.classId);
  }
  return null;
}

/** The title the asset's editor shows for a graph node or behaviour-tree node. */
export function sessionReportNodeTitle(
  assetType: string,
  content: unknown,
  nodeId: string,
): string | null {
  if (assetType === "BehaviourTree") return behaviourTreeNodeTitle(content, nodeId);
  const row = record(content);
  return row ? graphNodeTitle(row, nodeId) : null;
}

function loadReportAsset(
  ref: string,
  sources: SessionReportLocationSources,
  cache: SessionReportLocationCache,
) {
  const cached = cache.get(ref);
  if (cached) return cached;
  const load = (async () => {
    let asset: SessionReportAsset | undefined;
    try {
      asset = sources.findAsset(ref);
    } catch {
      return null;
    }
    if (!asset) return null;
    try {
      const open = sources.openContent(asset);
      return { asset, content: open ?? (await sources.readContent(asset)) };
    } catch {
      // A missing or corrupt document still has its indexed name.
      return { asset, content: null };
    }
  })();
  cache.set(ref, load);
  return load;
}

/**
 * Resolve asset display names and node titles for a report. Open documents
 * supply their working content; others are read once per report through
 * `cache`. Anything unresolved is left out so callers show the raw id.
 */
export async function resolveSessionReportLabels(
  entries: readonly SessionReportEntry[],
  sources: SessionReportLocationSources,
  cache: SessionReportLocationCache,
): Promise<SessionReportLabels> {
  const assets = new Map<string, string>();
  const nodes = new Map<string, string>();
  const refs = [...new Set(entries.flatMap((entry) => (entry.assetGuid ? [entry.assetGuid] : [])))];
  const loaded = new Map(
    await Promise.all(
      refs.map(async (ref) => [ref, await loadReportAsset(ref, sources, cache)] as const),
    ),
  );
  for (const entry of entries) {
    const ref = entry.assetGuid;
    const found = ref ? loaded.get(ref) : null;
    if (!ref || !found) continue;
    assets.set(ref, found.asset.name);
    const nodeId = sessionReportNodeId(entry);
    if (!nodeId || found.content == null) continue;
    const key = sessionReportNodeKey(ref, nodeId);
    if (nodes.has(key)) continue;
    const title = sessionReportNodeTitle(found.asset.type, found.content, nodeId);
    if (title) nodes.set(key, title);
  }
  return { assets, nodes };
}
