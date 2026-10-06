import type { SerializedGraph } from "@babylonslate/core";

/** Metadata shared by graph hydration, validation and the node Inspector. */
export const DATA_GRAPH_NODES = {
  "data.readObject": { title: "Read Data Object", operation: "Read", required: true, assetPin: "object", assetType: "DataObject" },
  "data.getSheetObjects": { title: "Get Data Sheet Objects", operation: "Get", required: false, assetPin: "sheet", assetType: "DataSheet" },
  "editorData.listObjects": { title: "List Data Objects", operation: "List", required: false },
  "editorData.listSheets": { title: "List Data Sheets", operation: "List", required: false },
  "editorData.readObject": { title: "Read Editable Data Object", operation: "Read Editable", required: true, assetPin: "object", assetType: "DataObject" },
  "editorData.readSheet": { title: "Read Editable Data Sheet", operation: "Read Editable", required: false, assetPin: "sheet", assetType: "DataSheet" },
  "editorData.createObject": { title: "Create Data Object", operation: "Create", required: true },
  "editorData.updateObject": { title: "Update Data Object", operation: "Update", required: true, assetPin: "object", assetType: "DataObject" },
  "editorData.createSheet": { title: "Create Data Sheet", operation: "Create", required: true },
  "editorData.setSheetObjects": { title: "Set Data Sheet Objects", operation: "Set", required: true, assetPin: "sheet", assetType: "DataSheet" },
} as const;

export type DataGraphNodeType = keyof typeof DATA_GRAPH_NODES;

export function isDataGraphNode(typeId: string): typeId is DataGraphNodeType {
  return Object.prototype.hasOwnProperty.call(DATA_GRAPH_NODES, typeId);
}

export function dataGraphNodeTitle(typeId: DataGraphNodeType, structureName?: string): string {
  const node = DATA_GRAPH_NODES[typeId];
  if (!structureName) return node.title;
  const collection = typeId.endsWith("Sheets") ? " Sheets"
    : typeId.endsWith("Sheet") ? " Sheet"
      : typeId.endsWith("Objects") ? " Objects" : "";
  return `${node.operation} ${structureName} Data${collection}`;
}

export type DataGraphAssetEntry = {
  guid: string;
  name: string;
  type: "DataObject" | "DataSheet";
  structureGuid: string;
};

/** Unsaved data schemas win over header metadata, as they do for Structures. */
export function collectDataGraphAssets(
  assets: readonly { path: string; header: { guid: string; name: string; type: string; payload?: unknown } }[],
  documents: readonly { ref: { path: string }; content?: unknown }[] = [],
): DataGraphAssetEntry[] {
  const open = new Map(documents.map((doc) => [doc.ref.path, doc.content]));
  return assets.flatMap((asset) => {
    const { type, guid, name } = asset.header;
    if (type !== "DataObject" && type !== "DataSheet") return [];
    const payload = open.get(asset.path) ?? asset.header.payload;
    const structureGuid = payload && typeof payload === "object" &&
      "structureGuid" in payload && typeof payload.structureGuid === "string"
      ? payload.structureGuid.trim() : "";
    return [{ guid, name, type, structureGuid }];
  });
}

/** Only a node's primary data reference inherits its Structure when created. */
export function dataGraphAssetCreateOptions(
  typeId: string,
  pinId: string,
  properties: Record<string, unknown>,
): { structureGuid: string } | undefined {
  if (!isDataGraphNode(typeId)) return undefined;
  const node = DATA_GRAPH_NODES[typeId];
  if (!("assetPin" in node) || node.assetPin !== pinId) return undefined;
  const structureGuid = typeof properties.structGuid === "string" ? properties.structGuid.trim() : "";
  return structureGuid ? { structureGuid } : undefined;
}

/** A picker choice is an explicit request to read that object's Structure. */
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
  if (asset?.structureGuid) {
    patch.structGuid = asset.structureGuid;
    if (current.structGuid !== asset.structureGuid) {
      patch["default:values"] = undefined;
      patch.dataSchema = undefined;
    }
  }
  return patch;
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
    data: { ...node.data, structGuid: selected.data.structGuid, dataSchema: selected.data.dataSchema, ...nextPatch },
  } : node);
  const slice = functionId ? graph.functionGraphs?.[functionId] : undefined;
  if (slice && functionId) {
    return { ...graph, functionGraphs: { ...graph.functionGraphs, [functionId]: { ...slice, nodes: patchNodes(slice.nodes) } } };
  }
  return { ...graph, nodes: patchNodes(graph.nodes) };
}
