/**
 * Per-node property and pin-input derivation shared by editor hydration and
 * materialization. `graph-validation.ts` re-exports the public types.
 */
import {
  normalizeDataTreeEntry,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@haptic/core";
import {
  snapshotDataFields,
  reconcileDataEntry,
  type NodeRegistry,
  type PinType,
  type TypeSchemas,
  isDevelopmentOnlyByDefaultTypeId,
} from "@haptic/scripting";
import { ENGINE_CLASS_SCRIPT_APIS } from "@haptic/object-model";
import {
  ASSET_REGISTRY_BY_CLASS_NODE_ID,
  castDefaultClassId,
  callInterfaceTitle,
  isCallInterfaceMethodPin,
  SUBSYSTEM_GET_NODE_ID,
  subsystemGetClassId,
  subsystemGetTitle,
} from "@haptic/scripting-nodes";
import {
  dataGraphMetadata,
  selectedDataGraphEntry,
  dataGraphNodeTitle,
  isDataGraphNode,
  type DataGraphAssetEntry,
} from "../lib/data-graph";

export function catalogTypeId(node: {
  type: string;
  data: Record<string, unknown>;
}): string {
  const hinted = node.data.__nodeType;
  return typeof hinted === "string" ? hinted : node.type;
}

export function isInputEvent(typeId: string): boolean {
  return typeId === "input.actionEvent" || typeId === "input.axisEvent";
}

/** Nodes whose Actor input reads Self while unwired: saved pins from before it was labelled "(Self)" are replaced. */
const SELF_ACTOR_NODE_IDS: ReadonlySet<string> = new Set([
  "actor.destroy",
  "actor.attachToBone",
  "component.get",
  "component.has",
  "component.add",
  "particles.play",
  "particles.stop",
]);

export function shouldRegeneratePins(typeId: string): boolean {
  if (isDataGraphNode(typeId)) return true;
  if (typeId.startsWith("tween.")) return true;
  if (typeId === "debug.executeJavaScript") return true;
  if (isInputEvent(typeId)) return true;
  if (SELF_ACTOR_NODE_IDS.has(typeId)) return true;
  return (
    typeId === "flow.event.call" ||
    typeId === "flow.event.callParent" ||
    typeId === "functions.call" ||
    typeId === "interface.call" ||
    typeId === "flow.function.input" ||
    typeId === "flow.function.output" ||
    typeId === "variables.get" ||
    typeId === "variables.set" ||
    typeId === "variables.getValidated" ||
    typeId === "component.getNamed" ||
    typeId === "casting.cast" ||
    typeId === ASSET_REGISTRY_BY_CLASS_NODE_ID ||
    typeId === SUBSYSTEM_GET_NODE_ID ||
    typeId === "struct.make" ||
    typeId === "struct.break" ||
    typeId === "enum.make" ||
    typeId === "enum.equals" ||
    typeId === "enum.notEquals" ||
    typeId === "enum.toString" ||
    typeId === "enum.switch" ||
    typeId === "enum.select" ||
    typeId === "string.format" ||
    typeId === "flow.switchInt" ||
    typeId === "flow.switchString" ||
    typeId === "array.make" ||
    typeId === "map.make" ||
    typeId === "scene.change" ||
    isDevelopmentOnlyByDefaultTypeId(typeId)
  );
}

export function refreshVariableReferenceAccess(typeId: string, properties: Record<string, unknown>): void {
  if (typeId !== "variables.get") return;
  const api = ENGINE_CLASS_SCRIPT_APIS.find((entry) => entry.classId === properties.classId);
  const variable = api?.variables?.find((entry) =>
    entry.propertyKey === properties.propertyKey || entry.name === properties.variableName);
  if (variable?.getOnly) properties.getOnly = true;
  else if (variable) delete properties.getOnly;
}

function pinGuid(type: unknown, kind: "structRef" | "enumRef"): string | undefined {
  if (!type || typeof type !== "object") return undefined;
  const record = type as { kind?: unknown; guid?: unknown };
  if (record.kind !== kind) return undefined;
  return typeof record.guid === "string" && record.guid.trim()
    ? record.guid.trim()
    : undefined;
}

function connectedDataPinType(
  graph: SerializedGraph,
  nodeId: string,
  targetHandle: string,
  nodeRegistry: NodeRegistry,
): PinType | undefined {
  const edge = graph.edges.find(
    (entry) => entry.target === nodeId && entry.targetHandle === targetHandle,
  );
  if (!edge) return undefined;
  const source = graph.nodes.find((node) => node.id === edge.source);
  if (!source) return undefined;
  const rawData = { ...(source.data as Record<string, unknown>) };
  const typeId = catalogTypeId({ type: source.type, data: rawData });
  const def = nodeRegistry.get(typeId);
  const properties = { ...rawData };
  delete properties.__pins;
  delete properties.__nodeType;
  delete properties.title;
  const pins = def ? def.pins(properties) : [];
  const sourcePin = pins.find(
    (pin) => pin.id === edge.sourceHandle || pin.name === edge.sourceHandle,
  );
  return sourcePin?.type;
}

function connectedEnumGuid(
  graph: SerializedGraph,
  nodeId: string,
  nodeRegistry: NodeRegistry,
): string | undefined {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) return undefined;
  const rawData = { ...(node.data as Record<string, unknown>) };
  const typeId = catalogTypeId({ type: node.type, data: rawData });
  const def = nodeRegistry.get(typeId);
  const properties = { ...rawData };
  delete properties.__pins;
  delete properties.__nodeType;
  delete properties.title;
  const pins = def ? def.pins(properties) : [];
  for (const pin of pins) {
    if (pin.kind !== "data" || pin.direction !== "in") continue;
    const type = connectedDataPinType(graph, nodeId, pin.id, nodeRegistry);
    const guid = pinGuid(type, "enumRef");
    if (guid) return guid;
  }
  return undefined;
}

function pinClassId(type: unknown): string | undefined {
  if (!type || typeof type !== "object") return undefined;
  const classId = (type as { classId?: unknown }).classId;
  return typeof classId === "string" && classId.trim() ? classId.trim() : undefined;
}

function connectedCastClassId(
  graph: SerializedGraph,
  nodeId: string,
  nodeRegistry: NodeRegistry,
): string | undefined {
  const edge = graph.edges.find(
    (entry) => entry.target === nodeId && entry.targetHandle === "class",
  );
  if (!edge) return undefined;
  const source = graph.nodes.find((node) => node.id === edge.source);
  if (!source) return "Object";
  const rawData = { ...(source.data as Record<string, unknown>) };
  const typeId = catalogTypeId({ type: source.type, data: rawData });
  const def = nodeRegistry.get(typeId);
  const properties = { ...rawData };
  delete properties.__pins;
  delete properties.__nodeType;
  delete properties.title;
  const pins = def ? def.pins(properties) : [];
  const sourcePin = pins.find(
    (pin) => pin.id === edge.sourceHandle || pin.name === edge.sourceHandle,
  );
  return pinClassId(sourcePin?.type) ?? "Object";
}

/**
 * Cast types its Result from the Class wired into it, else from the Class
 * picked on the node (`default:class`). Returns the pin inputs, for the
 * editor and validation alike.
 */
export function castPinProperties(
  properties: Record<string, unknown>,
  graph: SerializedGraph,
  nodeId: string,
  nodeRegistry: NodeRegistry,
): {
  pinProperties: Record<string, unknown>;
  defaultClassId: string;
  wiredClassId: string | undefined;
} {
  const defaultClassId = castDefaultClassId(properties);
  const wiredClassId = connectedCastClassId(graph, nodeId, nodeRegistry);
  const resultClassId = wiredClassId ?? defaultClassId;
  return {
    pinProperties: { ...properties, "default:class": resultClassId },
    defaultClassId,
    wiredClassId,
  };
}

/**
 * Get Assets By Class types Classes the way Cast types its result: from the
 * Class wired into it, else from the Class picked on the node.
 */
export function assetsByClassPinProperties(
  typeId: string,
  properties: Record<string, unknown>,
  graph: SerializedGraph,
  nodeId: string,
  nodeRegistry: NodeRegistry,
): Record<string, unknown> {
  if (typeId !== ASSET_REGISTRY_BY_CLASS_NODE_ID) return properties;
  const wiredClassId = connectedCastClassId(graph, nodeId, nodeRegistry);
  return wiredClassId ? { ...properties, "default:class": wiredClassId } : properties;
}

function isEnumCatalogType(typeId: string): boolean {
  return (
    typeId === "enum.make" ||
    typeId === "enum.equals" ||
    typeId === "enum.notEquals" ||
    typeId === "enum.toString" ||
    typeId === "enum.switch" ||
    typeId === "enum.select"
  );
}

function enumNodeTitle(typeId: string, enumName: string): string {
  switch (typeId) {
    case "enum.make":
      return `Make ${enumName}`;
    case "enum.equals":
      return `Equal ${enumName}`;
    case "enum.notEquals":
      return `Not Equal ${enumName}`;
    case "enum.toString":
      return `${enumName} to String`;
    case "enum.switch":
      return `Switch on ${enumName}`;
    case "enum.select":
      return `Select ${enumName}`;
    default:
      return enumName;
  }
}

export function dataLiteralEntry(nodeId: string, properties: Record<string, unknown>) {
  try {
    return normalizeDataTreeEntry({ id: nodeId, parentId: null, name: "Values", values: properties["default:values"], schema: properties.dataSchema });
  } catch {
    return null;
  }
}

export function applyStructEnumSchema(
  typeId: string,
  properties: Record<string, unknown>,
  graph: SerializedGraph,
  nodeId: string,
  nodeRegistry: NodeRegistry,
  options?: HydrateGraphOptions,
): void {
  if (isDataGraphNode(typeId)) {
    const node = dataGraphMetadata(typeId)!;
    if (node.schema === false) return;
    if (typeId === "editorData.addEntry" && properties.definitionMode === "none") return;
    let guid = typeof properties.definitionGuid === "string" ? properties.definitionGuid.trim() : "";
    if (!guid && node.definitionPath && !graph.edges.some((edge) => edge.target === nodeId && ["tree", node.definitionPath].includes(edge.targetHandle ?? ""))) {
      guid = selectedDataGraphEntry(typeId, properties, options?.dataAssets ?? [])?.effectiveDefinitionGuid ?? "";
      if (guid) properties.definitionGuid = guid;
    }
    const schema = options?.dataDefinitions?.[guid];
    properties.title = dataGraphNodeTitle(typeId, schema?.name);
    if (schema && !Array.isArray(properties.dataSchema)) {
      const literal = properties["default:values"];
      const values = literal && typeof literal === "object" && !Array.isArray(literal) ? literal as Record<string, unknown> : {};
      properties.dataSchema = snapshotDataFields(schema.fields, values, {
        structs: options?.structs ?? {}, enums: options?.enums ?? {}, dataDefinitions: options?.dataDefinitions,
      }, new Set([guid]));
    }
    if (schema && (typeId === "editorData.addEntry" || typeId === "editorData.updateEntry") &&
      properties["default:values"] !== undefined && !graph.edges.some((edge) => edge.target === nodeId && edge.targetHandle === "values")) {
      const schemas = { structs: options?.structs ?? {}, enums: options?.enums ?? {}, dataDefinitions: options?.dataDefinitions };
      const authored = dataLiteralEntry(nodeId, properties);
      // Safe renames must remain editable while unrelated values need repair.
      // Missing fields stay missing and incompatible values retain their old
      // type snapshots; structural conflicts return the original entry atomically.
      if (authored) {
        const projected = reconcileDataEntry(authored, guid, schema.fields, schemas, { initializeMissingFields: false });
        if (projected.entry !== authored) {
          properties["default:values"] = projected.entry.values;
          properties.dataSchema = projected.entry.schema;
        }
      }
    }
  }
  if (typeId === "struct.make" || typeId === "struct.break") {
    const guid =
      typeof properties.structGuid === "string"
        ? properties.structGuid.trim()
        : "";
    const schema = guid ? options?.structs?.[guid] : undefined;
    if (schema) {
      properties.fields = schema.fields;
      properties.title = `${typeId === "struct.make" ? "Make" : "Break"} ${schema.name}${options?.dataDefinitions?.[guid] ? " Data" : ""}`;
    }
  }
  if (isEnumCatalogType(typeId)) {
    const wiredGuid = connectedEnumGuid(graph, nodeId, nodeRegistry);
    if (wiredGuid) properties.enumGuid = wiredGuid;
    const guid =
      typeof properties.enumGuid === "string"
        ? properties.enumGuid.trim()
        : "";
    const schema = guid ? options?.enums?.[guid] : undefined;
    if (schema) {
      properties.members = schema.members;
      properties.title = enumNodeTitle(typeId, schema.name);
      if (typeId === "enum.make") {
        const current =
          typeof properties.value === "string" ? properties.value : "";
        if (!schema.members.some((member) => member.name === current)) {
          properties.value = schema.members[0]?.name ?? "";
        }
      }
      if (typeId === "enum.select") {
        const current =
          typeof properties["default:index"] === "string"
            ? properties["default:index"]
            : "";
        if (!schema.members.some((member) => member.name === current)) {
          properties["default:index"] = schema.members[0]?.name ?? "";
        }
      }
    }
  }
  if (typeId === "string.format") {
    const wired = graph.edges.some(
      (edge) => edge.target === nodeId && edge.targetHandle === "format",
    );
    properties.formatWired = wired;
    if (typeof properties["default:format"] !== "string") {
      properties["default:format"] = "{input}";
    }
  }
}

export function applyInterfaceCallPins(
  properties: Record<string, unknown>,
  options?: HydrateGraphOptions,
): void {
  const guid =
    typeof properties.interfaceGuid === "string"
      ? properties.interfaceGuid.trim()
      : "";
  const method =
    typeof properties.method === "string" ? properties.method.trim() : "";
  const iface = options?.scriptInterfaces?.find((entry) => entry.guid === guid);
  const methodDef = iface?.methods.find((entry) => entry.name === method);
  const live = methodDef?.pins;
  const snapshot = Array.isArray(properties.pins)
    ? (properties.pins as GraphClassMemberPin[])
    : [];
  properties.pins = (live ?? snapshot).filter(isCallInterfaceMethodPin);
}

export function hydratedNodeTitle(
  typeId: string,
  properties: Record<string, unknown>,
  authoredTitle: string | undefined,
  defTitle: string,
): string {
  if (typeId === "interface.call") {
    return callInterfaceTitle(
      typeof properties.method === "string" ? properties.method : "",
    );
  }
  if (typeId === SUBSYSTEM_GET_NODE_ID) {
    return subsystemGetTitle(subsystemGetClassId(properties));
  }
  if (
    typeof properties.title === "string" &&
    (typeId === "flow.event.call" ||
      typeId === "flow.event.callParent" ||
      isInputEvent(typeId) ||
      typeId === "struct.make" ||
      typeId === "struct.break" ||
      isDataGraphNode(typeId) ||
      isEnumCatalogType(typeId))
  ) {
    return properties.title;
  }
  return authoredTitle ?? defTitle;
}

export function refreshInputEvent(
  typeId: string,
  data: Record<string, unknown>,
  options: HydrateGraphOptions | undefined,
  graph: SerializedGraph,
  nodeId: string,
) {
  if (!isInputEvent(typeId)) return;
  const action = typeId === "input.actionEvent";
  const wired = graph.edges.some((edge) => edge.target === nodeId && edge.targetHandle === "binding");
  data.title = action ? "Event Input Action" : "Event Input Axis";
  if (action) data.valueType = "button";
  if (wired) return;
  const binding = data["default:binding"] as { Input?: { Asset?: string } } | undefined;
  const asset = options?.inputAssets?.find((entry) => entry.guid === binding?.Input?.Asset && entry.type === (action ? "InputAction" : "InputAxis"));
  if (asset) {
    data.valueType = asset.valueType;
    data["default:binding"] = { ...binding, Input: { Name: asset.name, Asset: asset.guid } };
    data.title = `Event ${asset.name}`;
  }
}

export type InputPaletteAsset = { guid: string; name: string; type: string; valueType: string };

export type HydrateGraphOptions = {
  dataAssets?: readonly DataGraphAssetEntry[];
  /** Active function slice, for Script Interface endpoint chrome. */
  functionId?: string;
  inputAssets?: readonly InputPaletteAsset[];
  parentOf?: (id: string) => string | null | undefined;
  structs?: TypeSchemas["structs"];
  dataDefinitions?: TypeSchemas["dataDefinitions"];
  enums?: TypeSchemas["enums"];
  classId?: string;
  otherClassGraphs?: Record<string, SerializedGraph>;
  functionGraphs?: SerializedGraph["functionGraphs"];
  scriptInterfaces?: Array<{
    guid: string;
    name: string;
    methods: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
  }>;
};
