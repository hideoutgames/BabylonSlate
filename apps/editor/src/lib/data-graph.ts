import { buildDataTreeIndex, isDataTreeAsset, normalizeDataTreeAsset, type SerializedGraph } from "@babylonslate/core";

type DataGraphMetadata = {
  title: string; operation: string; required: boolean; schema?: false;
  assetPin?: "tree"; assetType?: "DataTree";
  pathPins?: readonly { pinId: string; root: boolean }[];
  definitionPath?: string;
};

/** Metadata shared by graph hydration, validation and both default editors. */
export const DATA_GRAPH_NODES = {
  "data.readEntry": { title: "Read Data Entry", operation: "Read", required: true, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }], definitionPath: "entryPath" },
  "data.getChildren": { title: "Get Data Children", operation: "Get", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: true }] },
  "data.getDescendants": { title: "Get Data Descendants", operation: "Get", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: true }] },
  "data.getParent": { title: "Get Data Parent", operation: "Get", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }] },
  "editorData.listTrees": { title: "List Data Trees", operation: "List", required: false },
  "editorData.readTree": { title: "Read Editable Data Tree", operation: "Read Editable", required: false, schema: false, assetPin: "tree", assetType: "DataTree" },
  "editorData.readEntry": { title: "Read Editable Data Entry", operation: "Read Editable", required: true, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }], definitionPath: "entryPath" },
  "editorData.getChildren": { title: "Get Editable Data Children", operation: "Get", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: true }] },
  "editorData.getDescendants": { title: "Get Editable Data Descendants", operation: "Get", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: true }] },
  "editorData.getParent": { title: "Get Editable Data Parent", operation: "Get", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }] },
  "editorData.createTree": { title: "Create Data Tree", operation: "Create", required: false },
  "editorData.addEntry": { title: "Add Data Entry", operation: "Add", required: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "parentPath", root: true }] },
  "editorData.updateEntry": { title: "Update Data Entry", operation: "Update", required: true, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }], definitionPath: "entryPath" },
  "editorData.removeEntry": { title: "Remove Data Entry", operation: "Remove", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }] },
  "editorData.moveEntry": { title: "Move Data Entry", operation: "Move", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "entryPath", root: false }, { pinId: "newParentPath", root: true }] },
  "editorData.reorderChildren": { title: "Reorder Data Children", operation: "Reorder", required: false, schema: false, assetPin: "tree", assetType: "DataTree", pathPins: [{ pinId: "parentPath", root: true }] },
} as const satisfies Record<string, DataGraphMetadata>;
export type DataGraphNodeType = keyof typeof DATA_GRAPH_NODES;
export function isDataGraphNode(typeId: string): typeId is DataGraphNodeType {
  return Object.prototype.hasOwnProperty.call(DATA_GRAPH_NODES, typeId);
}
export function dataGraphMetadata(typeId: string): DataGraphMetadata | undefined {
  return isDataGraphNode(typeId) ? DATA_GRAPH_NODES[typeId] : undefined;
}
export function dataGraphNodeTitle(typeId: DataGraphNodeType, definitionName?: string): string {
  const node = dataGraphMetadata(typeId)!;
  if (!definitionName || node.schema === false) return node.title;
  return node.title.replace("Data Entry", `${definitionName} Data`).replace("Data Tree", `${definitionName} Data Tree`);
}
export type DataGraphTreeEntry = { id: string; path: string; parentPath: string; effectiveDefinitionGuid: string | null };
export type DataGraphAssetEntry = { guid: string; name: string; type: "DataTree"; defaultDefinitionGuid?: string | null; entries: readonly DataGraphTreeEntry[]; invalid?: boolean };

/** One shared hierarchy pass indexes live unsaved trees for graph consumers. */
export function collectDataGraphAssets(
  assets: readonly { path: string; header: { guid: string; name: string; type: string; payload?: unknown } }[],
  documents: readonly { ref: { path: string }; content?: unknown }[] = [],
): DataGraphAssetEntry[] {
  const open = new Map(documents.map((doc) => [doc.ref.path, doc.content]));
  return assets.flatMap((asset): DataGraphAssetEntry[] => {
    const { type, guid, name } = asset.header;
    if (type !== "DataTree") return [];
    try {
      const payload = open.get(asset.path) ?? asset.header.payload;
      const tree = isDataTreeAsset(payload) ? payload : normalizeDataTreeAsset(payload);
      const { index } = buildDataTreeIndex(tree);
      if (!index) return [{ guid, name, type, entries: [], invalid: true }];
      return [{ guid, name, type, defaultDefinitionGuid: tree.defaultDefinitionGuid, entries: index.orderedEntries.map((entry) => ({
        id: entry.id, path: index.pathById.get(entry.id)!,
        parentPath: entry.parentId ? index.pathById.get(entry.parentId)! : "",
        effectiveDefinitionGuid: index.effectiveDefinitionById.get(entry.id) ?? null,
      })) }];
    } catch {
      return [{ guid, name, type, entries: [], invalid: true }];
    }
  });
}

export function selectedDataGraphEntry(typeId: string, properties: Record<string, unknown>, assets: readonly DataGraphAssetEntry[]) {
  const metadata = dataGraphMetadata(typeId);
  if (!metadata?.definitionPath) return undefined;
  return assets.find((asset) => asset.guid === properties["default:tree"])?.entries
    .find((entry) => entry.path === properties[`default:${metadata.definitionPath}`]);
}

/** Creating a tree from a typed read seeds only its default Definition. */
export function dataGraphAssetCreateOptions(typeId: string, pinId: string, properties: Record<string, unknown>): { defaultDefinitionGuid: string } | undefined {
  const metadata = dataGraphMetadata(typeId);
  if (metadata?.assetPin !== pinId || metadata.schema === false || (typeId === "editorData.addEntry" && properties.definitionMode === "none")) return undefined;
  const guid = typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
  return guid ? { defaultDefinitionGuid: guid } : undefined;
}

/** Explicit tree or path selection may update the typed read's expected schema. */
export function dataGraphAssetPickPatch(typeId: string, pinId: string, value: string | null, assets: readonly DataGraphAssetEntry[], current: Record<string, unknown> = {}, wired: (pinId: string) => boolean = () => false): Record<string, unknown> {
  const patch: Record<string, unknown> = { [`default:${pinId}`]: value ?? "" };
  const metadata = dataGraphMetadata(typeId);
  if (!metadata?.definitionPath || (pinId !== metadata.assetPin && pinId !== metadata.definitionPath)) return patch;
  if (wired("tree") || wired(metadata.definitionPath)) return patch;
  const selected = selectedDataGraphEntry(typeId, { ...current, ...patch }, assets);
  if (selected) {
    patch.definitionGuid = selected.effectiveDefinitionGuid ?? "";
    if (current.definitionGuid !== patch.definitionGuid) {
      patch["default:values"] = undefined;
      patch.dataSchema = undefined;
    }
  }
  return patch;
}

/** Inline tree and path edits carry schema changes through the same undoable commit. */
export function applyDataGraphAssetPicks(previous: SerializedGraph, next: SerializedGraph, assets: readonly DataGraphAssetEntry[]): SerializedGraph {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  let changed = false;
  const nodes = next.nodes.map((node) => {
    const before = previousById.get(node.id);
    if (!before || before.data === node.data) return node;
    const typeId = typeof node.data.__nodeType === "string" ? node.data.__nodeType : node.type;
    const metadata = dataGraphMetadata(typeId);
    if (!metadata?.assetPin || !metadata.definitionPath) return node;
    if (next.edges.some((edge) => edge.target === node.id && [metadata.assetPin, metadata.definitionPath].includes(edge.targetHandle ?? ""))) return node;
    const pinId = [metadata.definitionPath, metadata.assetPin].find((pin) => before.data[`default:${pin}`] !== node.data[`default:${pin}`]);
    if (!pinId || typeof node.data[`default:${pinId}`] !== "string") return node;
    const patch = dataGraphAssetPickPatch(typeId, pinId, node.data[`default:${pinId}`] as string, assets, node.data);
    if (!Object.hasOwn(patch, "definitionGuid")) return node;
    changed = true;
    return { ...node, data: { ...node.data, ...patch } };
  });
  return changed ? { ...next, nodes } : next;
}

/** Persist hydrated schema metadata with authored defaults, including functions. */
export function patchDataGraphNode(
  graph: SerializedGraph,
  selected: SerializedGraph["nodes"][number],
  patch: Record<string, unknown>,
  functionId?: string | null,
): SerializedGraph {
  const nextPatch = { ...patch };
  const value = patch["default:values"];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const authored = selected.data["default:values"];
    nextPatch["default:values"] = {
      ...(authored && typeof authored === "object" && !Array.isArray(authored) ? authored : {}),
      ...value,
    };
  }
  const patchNodes = (nodes: SerializedGraph["nodes"]) => nodes.map((node) => node.id === selected.id ? {
    ...node,
    data: { ...node.data, definitionGuid: selected.data.definitionGuid, dataSchema: selected.data.dataSchema, ...nextPatch },
  } : node);
  const slice = functionId ? graph.functionGraphs?.[functionId] : undefined;
  if (slice && functionId) {
    return { ...graph, functionGraphs: { ...graph.functionGraphs, [functionId]: { ...slice, nodes: patchNodes(slice.nodes) } } };
  }
  return { ...graph, nodes: patchNodes(graph.nodes) };
}
