import type { SerializedGraph } from "@babylonslate/core";

/** Metadata shared by graph hydration, validation and the node Inspector. */
export const DATA_GRAPH_NODES = {
  "data.readRow": { title: "Read Data Row", operation: "Read", required: true, assetPin: "sheet", assetType: "DataSheet", row: true },
  "data.getSheetRows": { title: "Get Data Sheet Rows", operation: "Get", required: false, assetPin: "sheet", assetType: "DataSheet" },
  "editorData.listSheets": { title: "List Data Sheets", operation: "List", required: false },
  "editorData.readSheet": { title: "Read Editable Data Sheet", operation: "Read Editable", required: false, assetPin: "sheet", assetType: "DataSheet" },
  "editorData.readRow": { title: "Read Editable Data Row", operation: "Read Editable", required: true, assetPin: "sheet", assetType: "DataSheet", row: true },
  "editorData.createSheet": { title: "Create Data Sheet", operation: "Create", required: true },
  "editorData.addRow": { title: "Add Data Row", operation: "Add", required: true, assetPin: "sheet", assetType: "DataSheet" },
  "editorData.updateRow": { title: "Update Data Row", operation: "Update", required: true, assetPin: "sheet", assetType: "DataSheet", row: true },
  "editorData.removeRow": { title: "Remove Data Row", operation: "Remove", required: true, assetPin: "sheet", assetType: "DataSheet", row: true },
  "editorData.reorderRows": { title: "Reorder Data Rows", operation: "Reorder", required: true, assetPin: "sheet", assetType: "DataSheet" },
} as const;

export type DataGraphNodeType = keyof typeof DATA_GRAPH_NODES;

export function isDataGraphNode(typeId: string): typeId is DataGraphNodeType {
  return Object.prototype.hasOwnProperty.call(DATA_GRAPH_NODES, typeId);
}

export function dataGraphNodeTitle(typeId: DataGraphNodeType, definitionName?: string): string {
  const node = DATA_GRAPH_NODES[typeId];
  if (!definitionName) return node.title;
  const collection = typeId.endsWith("Sheets") ? " Sheets"
    : typeId.endsWith("Sheet") ? " Sheet"
      : typeId.endsWith("Rows") ? " Rows" : "";
  return `${node.operation} ${definitionName} Data${collection}`;
}

export type DataGraphAssetEntry = {
  guid: string;
  name: string;
  type: "DataSheet";
  definitionGuid: string;
  rows?: readonly { id: string; name: string }[];
};

/** Unsaved sheet definitions and row labels win over header metadata. */
export function collectDataGraphAssets(
  assets: readonly { path: string; header: { guid: string; name: string; type: string; payload?: unknown } }[],
  documents: readonly { ref: { path: string }; content?: unknown }[] = [],
): DataGraphAssetEntry[] {
  const open = new Map(documents.map((doc) => [doc.ref.path, doc.content]));
  return assets.flatMap((asset) => {
    const { type, guid, name } = asset.header;
    if (type !== "DataSheet") return [];
    const payload = open.get(asset.path) ?? asset.header.payload;
    const definitionGuid = payload && typeof payload === "object" &&
      "definitionGuid" in payload && typeof payload.definitionGuid === "string"
      ? payload.definitionGuid.trim() : "";
    const rows = payload && typeof payload === "object" && "rows" in payload && Array.isArray(payload.rows)
      ? payload.rows.flatMap((row) => row && typeof row === "object" && typeof row.id === "string" && typeof row.name === "string"
        ? [{ id: row.id, name: row.name }] : []) : [];
    return [{ guid, name, type, definitionGuid, rows }];
  });
}

/** Only a node's primary sheet reference inherits its Data Definition when created. */
export function dataGraphAssetCreateOptions(
  typeId: string,
  pinId: string,
  properties: Record<string, unknown>,
): { definitionGuid: string } | undefined {
  if (!isDataGraphNode(typeId)) return undefined;
  const node = DATA_GRAPH_NODES[typeId];
  if (!("assetPin" in node) || node.assetPin !== pinId) return undefined;
  const definitionGuid = typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
  return definitionGuid ? { definitionGuid } : undefined;
}

/** A picker choice is an explicit request to read that sheet's Data Definition. */
export function dataGraphAssetPickPatch(
  typeId: string,
  pinId: string,
  guid: string | null,
  assets: readonly DataGraphAssetEntry[],
  current: Record<string, unknown> = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = { [`default:${pinId}`]: guid ?? "" };
  if (!isDataGraphNode(typeId)) return patch;
  const node = DATA_GRAPH_NODES[typeId];
  if (!("assetPin" in node) || node.assetPin !== pinId) return patch;
  const asset = assets.find((entry) => entry.guid === guid && entry.type === node.assetType);
  if (asset?.definitionGuid) {
    patch.definitionGuid = asset.definitionGuid;
    if (current.definitionGuid !== asset.definitionGuid) {
      patch["default:values"] = undefined;
      patch.dataSchema = undefined;
    }
  }
  return patch;
}

/** Inline graph pickers edit one literal; carry its schema through the same commit. */
export function applyDataGraphAssetPicks(
  previous: SerializedGraph,
  next: SerializedGraph,
  assets: readonly DataGraphAssetEntry[],
): SerializedGraph {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  let changed = false;
  const nodes = next.nodes.map((node) => {
    const before = previousById.get(node.id);
    if (!before || before.data === node.data) return node;
    const typeId = typeof node.data.__nodeType === "string" ? node.data.__nodeType : node.type;
    if (!isDataGraphNode(typeId)) return node;
    const metadata = DATA_GRAPH_NODES[typeId];
    if (!("assetPin" in metadata)) return node;
    const key = `default:${metadata.assetPin}`;
    const value = node.data[key];
    if (before.data[key] === value || typeof value !== "string" ||
      next.edges.some((edge) => edge.target === node.id && edge.targetHandle === metadata.assetPin)) return node;
    const patch = dataGraphAssetPickPatch(typeId, metadata.assetPin, value, assets, node.data);
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
