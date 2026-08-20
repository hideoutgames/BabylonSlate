import {
  isEditorFunctionLibraryClass,
  isEditorGraphClass,
  isEditorGraphHost,
  isFunctionLibraryClass,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@babylonslate/core";
import { engineParentOf, formatEventMemberName, formatEventTitle, walkAncestry } from "@babylonslate/editor-kit";
import {
  fromSerializedGraph,
  validateGraphs,
  hasBlockingErrors,
  toSerializedGraph as logicToSerializedGraph,
  isAssignable,
  isActorClassId,
  isLogicGraphPayload,
  knownGuidsFromSchemas,
  type ClassHierarchy,
  type ClassMemberSymbol,
  type Diagnostic,
  type InterfaceMethodContext,
  type ParentFunctionSignature,
  type LogicGraph,
  type NodeRegistry,
  type GraphPin,
  type PinType,
  type TypeSchemas,
  isDevelopmentOnlyByDefaultTypeId,
  normalizeIntSwitchCases,
  normalizeStringSwitchCases,
  collectLatentFunctions,
  isLatentFunctionKey,
  latentSourcesFromSerializedGraph,
} from "@babylonslate/scripting";
import {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_BT_BUILTIN_CLASSES,
  ENGINE_COMPONENT_CLASS_IDS,
  ENGINE_WIDGET_CLASS_IDS,
} from "@babylonslate/object-model";
import {
  boundGetWidgetEntries,
  createDefaultNodeRegistry,
  castDefaultClassId,
  callInterfaceTitle,
  uiGetWidgetNodeId,
  type BoundWidgetRef,
} from "@babylonslate/scripting-nodes";
import {
  warnDebugTierConsoleCommands,
  warnReservedConsoleCommandNames,
} from "@babylonslate/debugger";
import type { PaletteNode, PinCompatibilityRule } from "@babylonslate/graph-ui";
import {
  ensureCallParentForEvent,
  inheritedCustomEventSeeds,
  isObjectInstanceVariableType,
  isScriptCatalogNodeAllowed,
  nativeEventStubs,
  NATIVE_CLASS_EVENT_TYPES,
  SEEDED_NATIVE_EVENT_TYPES,
  COLLISION_EVENT_TYPE_IDS,
  type ClassEventOptions,
} from "../lib/class-members";
import type {
  GraphEnumEntry,
  GraphStructureEntry,
} from "../lib/logic-graph-document";

const registry = createDefaultNodeRegistry();

function hasNonEmptyPins(data: Record<string, unknown>): boolean {
  return Array.isArray(data.__pins) && data.__pins.length > 0;
}

function pinIdsFromNodeData(data: Record<string, unknown>): Set<string> | undefined {
  const pins = data.__pins;
  if (!Array.isArray(pins)) return undefined;
  return new Set(
    pins.flatMap((pin) => {
      if (!pin || typeof pin !== "object") return [];
      const id = (pin as { id?: unknown }).id;
      return typeof id === "string" && id ? [id] : [];
    }),
  );
}

function pruneEdgesToMissingPins(
  edges: SerializedGraph["edges"],
  nodes: SerializedGraph["nodes"],
): SerializedGraph["edges"] {
  const pinsByNode = new Map(
    nodes.map((node) => [node.id, pinIdsFromNodeData(node.data)] as const),
  );
  return edges.filter((edge) => {
    const sourcePins = pinsByNode.get(edge.source);
    const targetPins = pinsByNode.get(edge.target);
    if (
      sourcePins &&
      edge.sourceHandle &&
      !sourcePins.has(edge.sourceHandle)
    ) {
      return false;
    }
    if (
      targetPins &&
      edge.targetHandle &&
      !targetPins.has(edge.targetHandle)
    ) {
      return false;
    }
    return true;
  });
}

function pinTypeFromHydratedPins(
  data: Record<string, unknown>,
  pinId: string | undefined,
): PinType | undefined {
  if (!pinId) return undefined;
  const pins = data.__pins;
  if (!Array.isArray(pins)) return undefined;
  const pin = pins.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as { id?: unknown }).id === pinId;
  }) as GraphPin | undefined;
  return pin?.type;
}

function isVariableAccessTypeId(typeId: string): boolean {
  return (
    typeId === "variables.get" ||
    typeId === "variables.set" ||
    typeId === "variables.getValidated"
  );
}

function pruneIncompatibleEdges(
  edges: SerializedGraph["edges"],
  nodes: SerializedGraph["nodes"],
): SerializedGraph["edges"] {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  return edges.filter((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return false;
    const sourceTypeId = catalogTypeId(source);
    const targetTypeId = catalogTypeId(target);
    if (
      !isVariableAccessTypeId(sourceTypeId) &&
      !isVariableAccessTypeId(targetTypeId)
    ) {
      return true;
    }
    const fromType = pinTypeFromHydratedPins(source.data, edge.sourceHandle);
    const toType = pinTypeFromHydratedPins(target.data, edge.targetHandle);
    if (!fromType || !toType) return true;
    return isAssignable(fromType, toType);
  });
}

function catalogTypeId(node: {
  type: string;
  data: Record<string, unknown>;
}): string {
  const hinted = node.data.__nodeType;
  return typeof hinted === "string" ? hinted : node.type;
}

function shouldRegeneratePins(typeId: string): boolean {
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
    typeId === uiGetWidgetNodeId ||
    isDevelopmentOnlyByDefaultTypeId(typeId)
  );
}

function parentLookup(
  parentOf?: (id: string) => string | null | undefined,
): (id: string) => string | null | undefined {
  return (id) => parentOf?.(id) ?? engineParentOf(id);
}

function resultKindForClass(
  classId: string,
  parentOf: (id: string) => string | null | undefined,
): "actorRef" | "objectRef" {
  return isActorClassId(classId, {
    isSubclassOf(childClassId, parentClassId) {
      if (childClassId === parentClassId) return true;
      return walkAncestry(childClassId, parentOf).includes(parentClassId);
    },
  })
    ? "actorRef"
    : "objectRef";
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
  if (!source) return "BObject";
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
  return pinClassId(sourcePin?.type) ?? "BObject";
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

function applyStructEnumSchema(
  typeId: string,
  properties: Record<string, unknown>,
  graph: SerializedGraph,
  nodeId: string,
  nodeRegistry: NodeRegistry,
  options?: HydrateGraphOptions,
): void {
  if (typeId === "struct.make" || typeId === "struct.break") {
    const guid =
      typeof properties.structGuid === "string"
        ? properties.structGuid.trim()
        : "";
    const schema = guid ? options?.structs?.[guid] : undefined;
    if (schema) {
      properties.fields = schema.fields;
      properties.title = `${typeId === "struct.make" ? "Make" : "Break"} ${schema.name}`;
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

function hydratedNodeTitle(
  typeId: string,
  properties: Record<string, unknown>,
  authoredTitle: string | undefined,
  defTitle: string,
): string {
  if (
    typeof properties.title === "string" &&
    (typeId === "flow.event.call" ||
      typeId === "flow.event.callParent" ||
      typeId === "struct.make" ||
      typeId === "struct.break" ||
      isEnumCatalogType(typeId))
  ) {
    return properties.title;
  }
  return authoredTitle ?? defTitle;
}

export type HydrateGraphOptions = {
  parentOf?: (id: string) => string | null | undefined;
  structs?: TypeSchemas["structs"];
  enums?: TypeSchemas["enums"];
  classId?: string;
  otherClassGraphs?: Record<string, SerializedGraph>;
  functionGraphs?: SerializedGraph["functionGraphs"];
};

/**
 * Injects `data.__pins` from the node registry for canvas rendering.
 * Compile/validate already materialize pins separately; this keeps the UI in sync.
 */
export function hydrateSerializedGraphForEditor(
  graph: SerializedGraph,
  nodeRegistry: NodeRegistry = registry,
  options?: HydrateGraphOptions,
): SerializedGraph {
  const parentOf = parentLookup(options?.parentOf);
  const latentFunctions = editorLatentFunctions(nodeRegistry, {
    classId: options?.classId,
    graph: {
      members: graph.members,
      functionGraphs: options?.functionGraphs ?? graph.functionGraphs,
    },
    otherClassGraphs: options?.otherClassGraphs,
    parentOf,
  });
  const callIsLatent = (data: Record<string, unknown>, typeId: string) => {
    if (typeId !== "functions.call") return false;
    const classId =
      typeof data.classId === "string" && data.classId.trim()
        ? data.classId.trim()
        : (options?.classId ?? "BObject");
    const functionName =
      typeof data.functionName === "string" ? data.functionName : "fn";
    return isLatentFunctionKey(classId, functionName, latentFunctions, parentOf);
  };
  const nodes = graph.nodes.map((node) => {
      const rawData = { ...(node.data as Record<string, unknown>) };
      const typeIdHint = catalogTypeId({ type: node.type, data: rawData });
      if (hasNonEmptyPins(rawData) && !shouldRegeneratePins(typeIdHint)) {
        return {
          ...node,
          data: withVisualMeta(
            rawData,
            nodeRegistry.get(typeIdHint),
            typeIdHint,
            callIsLatent(rawData, typeIdHint),
          ),
        };
      }

      let typeId =
        typeof rawData.__nodeType === "string"
          ? rawData.__nodeType
          : node.type;
      const properties = { ...rawData };
      delete properties.__pins;
      delete properties.__nodeType;
      delete properties.title;

      if (typeId === "logMessage") {
        typeId = "debug.log";
        if (properties.message === undefined) {
          properties.message = "";
        }
        if (properties.severity === undefined) {
          properties.severity = "log";
        }
        if (properties.category === undefined) {
          properties.category = "Script";
        }
      }

      const authoredTitle =
        typeof rawData.title === "string" && rawData.title.trim()
          ? rawData.title
          : undefined;

      if (typeId === "casting.cast") {
        const defaultClassId = castDefaultClassId(properties);
        properties.defaultClassId = defaultClassId;
        const wiredClassId = connectedCastClassId(graph, node.id, nodeRegistry);
        const resultClassId = wiredClassId ?? defaultClassId;
        properties.resultKind = resultKindForClass(resultClassId, parentOf);
        const pinProperties = {
          ...properties,
          defaultClassId: resultClassId,
        };
        const def = nodeRegistry.get(typeId);
        const pins: GraphPin[] = def ? def.pins(pinProperties) : [];
        return {
          ...node,
          type: typeId,
          data: withVisualMeta(
            {
              ...properties,
              title: wiredClassId ? "Cast to Class" : `Cast to ${defaultClassId}`,
              __pins: pins,
            },
            def,
            typeId,
            callIsLatent(properties, typeId),
          ),
        };
      }

      applyStructEnumSchema(typeId, properties, graph, node.id, nodeRegistry, options);

      if (typeId === "flow.event.call") {
        const rawName =
          typeof properties.name === "string" ? properties.name : "";
        const bodyName = formatEventMemberName(rawName);
        if (bodyName) {
          properties.name = bodyName;
          properties.title = `Call ${bodyName}`;
        }
      }

      if (typeId === "flow.event.callParent") {
        const eventType =
          typeof properties.eventType === "string" ? properties.eventType : "";
        const rawName =
          typeof properties.eventName === "string"
            ? properties.eventName
            : typeof properties.name === "string"
              ? properties.name
              : "";
        const bodyName = formatEventMemberName(rawName);
        if (bodyName) {
          properties.eventName = bodyName;
          properties.name = bodyName;
        }
        const label =
          eventType && eventType !== "flow.event.custom"
            ? formatEventMemberName(
                eventType.startsWith("flow.event.")
                  ? eventType.slice("flow.event.".length)
                  : eventType,
              )
            : bodyName || "Event";
        properties.title = `Call ${label} Parent`;
      }

      if (typeId === "flow.switchInt") {
        properties.cases = normalizeIntSwitchCases(properties.cases).cases;
      }
      if (typeId === "flow.switchString") {
        properties.cases = normalizeStringSwitchCases(properties.cases).cases;
      }

      const def = nodeRegistry.get(typeId);
      const pins: GraphPin[] = def ? def.pins(properties) : [];

      return {
        ...node,
        type: typeId,
        data: withVisualMeta(
          {
            ...properties,
            ...(def
              ? {
                  title: hydratedNodeTitle(
                    typeId,
                    properties,
                    authoredTitle,
                    def.title,
                  ),
                }
              : authoredTitle
                ? { title: authoredTitle }
                : {}),
            __pins: pins,
          },
          def,
          typeId,
          callIsLatent(properties, typeId),
        ),
      };
    });
  return {
    ...graph,
    nodes,
    edges: pruneIncompatibleEdges(
      pruneEdgesToMissingPins(graph.edges, nodes),
      nodes,
    ),
  };
}

function editorLatentFunctions(
  nodeRegistry: NodeRegistry,
  options?: {
    classId?: string;
    graph?: Pick<SerializedGraph, "members" | "functionGraphs">;
    otherClassGraphs?: Record<string, SerializedGraph>;
    parentOf?: (id: string) => string | null | undefined;
  },
): Set<string> {
  const sources = [
    ...latentSourcesFromSerializedGraph(
      options?.classId ?? "BObject",
      options?.graph ?? {},
    ),
    ...Object.entries(options?.otherClassGraphs ?? {}).flatMap(
      ([classId, graph]) => latentSourcesFromSerializedGraph(classId, graph),
    ),
  ];
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return collectLatentFunctions(sources, nodeRegistry, parentOf);
}

function withVisualMeta(
  data: Record<string, unknown>,
  def:
    | { category: string; pure?: boolean; latent?: boolean; editorOnly?: boolean }
    | undefined,
  typeId: string,
  callLatent = false,
): Record<string, unknown> {
  const latent =
    def?.latent === true || (typeId === "functions.call" && callLatent);
  const next: Record<string, unknown> = {
    ...data,
    __nodeType:
      typeof data.__nodeType === "string" ? data.__nodeType : typeId,
    __category:
      typeof data.__category === "string" ? data.__category : def?.category,
    __pure: data.__pure ?? def?.pure ?? false,
    __latent:
      typeId === "functions.call"
        ? latent
        : (data.__latent ?? def?.latent ?? false),
  };
  if (def?.editorOnly === true) {
    next.__editorOnly = true;
  }
  return next;
}

const DEFAULT_EVENT_NODE_IDS: Record<string, string> = {
  "flow.event.beginPlay": "event-begin-play",
  "flow.event.tick": "event-tick",
};

function defaultEventNodeId(eventType: string): string {
  return (
    DEFAULT_EVENT_NODE_IDS[eventType] ??
    `event-${eventType.replace(/\./g, "-")}`
  );
}

function pinTypeIdFromPinType(type: PinType | undefined): string {
  if (!type || typeof type !== "object" || !("kind" in type)) return "float";
  const kind = String((type as { kind: string }).kind);
  if (kind === "objectRef" || kind === "actorRef") return "object";
  if (kind === "classRef") return "class";
  if (kind === "assetRef") return "asset";
  return kind || "float";
}

/** New graphs seed native (+ inherited custom) events wired to Call Parent. */
export function createDefaultLogicGraphSerialized(
  nodeRegistry: NodeRegistry = registry,
  options?: ClassEventOptions,
): SerializedGraph {
  const seedNatives = new Set<string>(SEEDED_NATIVE_EVENT_TYPES);
  const skipSeedNatives = new Set<string>([
    ...NATIVE_CLASS_EVENT_TYPES,
    ...COLLISION_EVENT_TYPE_IDS,
  ]);
  const stubs = nativeEventStubs(options).filter((stub) => {
    if (!skipSeedNatives.has(stub.eventType)) return true;
    return seedNatives.has(stub.eventType);
  });
  const parentClassId = options?.parentClass?.trim() || null;
  const logic: LogicGraph = {
    id: "main",
    kind: "event",
    nodes: [],
    edges: [],
  };
  let graph = logicToSerializedGraph(logic);

  stubs.forEach((stub, index) => {
    const def = nodeRegistry.get(stub.eventType);
    if (!def) {
      throw new Error(
        `Default event node missing from node registry: ${stub.eventType}`,
      );
    }
    const eventId = defaultEventNodeId(stub.eventType);
    const catalogPins = def.pins({});
    const dataPins: GraphClassMemberPin[] = catalogPins
      .filter((pin) => pin.kind !== "exec" && pin.direction === "out")
      .map((pin) => ({
        name: pin.name,
        typeId: pinTypeIdFromPinType(pin.type),
        direction: "out" as const,
      }));
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: eventId,
          type: stub.eventType,
          position: { x: 80, y: 80 + index * 160 },
          data: {
            title: stub.name,
            ...(dataPins.length > 0 ? { pins: dataPins } : {}),
            __nodeType: stub.eventType,
          },
        },
      ],
    };
    if (parentClassId) {
      graph = ensureCallParentForEvent(graph, {
        eventNodeId: eventId,
        eventType: stub.eventType,
        parentClassId,
        pins: dataPins,
      });
    }
  });

  const inherited = inheritedCustomEventSeeds(options);
  inherited.forEach((event, index) => {
    const eventId = `event-custom-${event.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`;
    if (graph.nodes.some((node) => node.id === eventId)) return;
    const y = 80 + (stubs.length + index) * 160;
    graph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: eventId,
          type: "flow.event.custom",
          position: { x: 80, y },
          data: {
            title: formatEventTitle(event.name),
            name: event.name,
            pins: event.pins,
            __nodeType: "flow.event.custom",
          },
        },
      ],
      members: [
        ...(graph.members ?? []),
        {
          id: eventId,
          kind: "event",
          name: event.name,
          pins: event.pins,
        },
      ],
    };
    if (parentClassId) {
      graph = ensureCallParentForEvent(graph, {
        eventNodeId: eventId,
        eventType: "flow.event.custom",
        eventName: event.name,
        parentClassId,
        pins: event.pins,
      });
    }
  });

  return hydrateSerializedGraphForEditor(graph, nodeRegistry, {
    parentOf: options?.parentOf,
  });
}

export type ScriptPaletteOptions = ClassEventOptions & {
  classId?: string;
  graph?: SerializedGraph;
  widgets?: readonly BoundWidgetRef[];
  otherClassGraphs?: Record<string, SerializedGraph>;
  activeFunctionId?: string | null;
  functionLibraries?: Array<{
    classId: string;
    parentClass?: string | null;
    functions: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
  }>;
  scriptInterfaces?: Array<{
    guid: string;
    name: string;
    methods: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
  }>;
  structures?: readonly GraphStructureEntry[];
  enums?: readonly GraphEnumEntry[];
};

function otherClassAllowedOnHost(
  classId: string,
  options?: ScriptPaletteOptions,
): boolean {
  if (isEditorGraphHost(options ?? {})) return true;
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return !isEditorGraphClass(classId, parentOf);
}

type CustomEventRow = {
  name: string;
  pins: GraphClassMemberPin[];
};

function customEventRows(graph?: SerializedGraph): CustomEventRow[] {
  const byName = new Map<string, CustomEventRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "event" || !member.name) continue;
    const name = formatEventMemberName(member.name);
    if (!name) continue;
    byName.set(name, {
      name,
      pins: member.pins ?? [],
    });
  }
  for (const node of graph?.nodes ?? []) {
    if (node.type !== "flow.event.custom") continue;
    const raw =
      typeof node.data.name === "string"
        ? node.data.name
        : typeof node.data.title === "string"
          ? node.data.title
          : "";
    const name = formatEventMemberName(raw);
    if (!name || byName.has(name)) continue;
    const pins = Array.isArray(node.data.pins)
      ? (node.data.pins as GraphClassMemberPin[])
      : [];
    byName.set(name, { name, pins });
  }
  return [...byName.values()];
}

function callImplicitSelf(
  eventClassId: string,
  options?: ScriptPaletteOptions,
): boolean {
  const localId = options?.classId;
  if (!localId) return false;
  if (localId === eventClassId) return true;
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return walkAncestry(localId, parentOf).includes(eventClassId);
}

function callCustomEventPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("flow.event.call");
  if (!def) return [];
  const localClassId = options?.classId ?? "BObject";
  const localEvents = customEventRows(options?.graph);
  const localNames = new Set(localEvents.map((event) => event.name));
  const rows: Array<{
    classId: string;
    event: CustomEventRow;
    implicitSelf: boolean;
  }> = localEvents.map((event) => ({
    classId: localClassId,
    event,
    implicitSelf: true,
  }));
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    const implicitSelf = callImplicitSelf(classId, options);
    for (const event of customEventRows(graph)) {
      if (implicitSelf && localNames.has(event.name)) continue;
      rows.push({ classId, event, implicitSelf });
    }
  }
  return rows.map(({ classId, event, implicitSelf }) => {
    const defaultData: Record<string, unknown> = {
      name: event.name,
      classId,
      implicitSelf,
      pins: event.pins,
    };
    return {
      id: `flow.event.call:${classId}:${event.name}`,
      nodeType: "flow.event.call",
      title: `Call ${event.name}`,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData,
    };
  });
}

type FunctionRow = {
  name: string;
  pins: GraphClassMemberPin[];
};

function functionRows(graph?: SerializedGraph): FunctionRow[] {
  const byName = new Map<string, FunctionRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "function" || !member.name) continue;
    byName.set(member.name, {
      name: member.name,
      pins: member.pins ?? [],
    });
  }
  return [...byName.values()];
}

function paletteParentOf(
  options?: ScriptPaletteOptions,
): (id: string) => string | null | undefined {
  return options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
}

function isPaletteLibraryClass(
  classId: string,
  options?: ScriptPaletteOptions,
): boolean {
  const parentOf = paletteParentOf(options);
  if (isFunctionLibraryClass(classId, parentOf)) return true;
  if (
    classId === options?.classId &&
    isFunctionLibraryClass(options.parentClass, parentOf)
  ) {
    return true;
  }
  return (options?.functionLibraries ?? []).some((lib) => lib.classId === classId);
}

function skipEditorOnlyLibrary(
  classId: string,
  parentClass: string | null | undefined,
  options?: ScriptPaletteOptions,
): boolean {
  if (isEditorGraphHost(options ?? {})) return false;
  const parentOf = paletteParentOf(options);
  return (
    isEditorFunctionLibraryClass(classId, parentOf) ||
    isEditorFunctionLibraryClass(parentClass, parentOf)
  );
}

function callFunctionPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("functions.call");
  if (!def) return [];
  const localClassId = options?.classId ?? "BObject";
  const parentOf = paletteParentOf(options);
  const latentFunctions = editorLatentFunctions(nodeRegistry, {
    classId: localClassId,
    graph: options?.graph,
    otherClassGraphs: options?.otherClassGraphs,
    parentOf,
  });
  const localFunctions = functionRows(options?.graph);
  const localNames = new Set(localFunctions.map((entry) => entry.name));
  const rows: Array<{
    classId: string;
    fn: FunctionRow;
    implicitSelf: boolean;
    staticCall: boolean;
  }> = [];
  const seen = new Set<string>();
  const pushRow = (
    classId: string,
    fn: FunctionRow,
    implicitSelf: boolean,
    staticCall: boolean,
  ) => {
    const key = `${classId}:${fn.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ classId, fn, implicitSelf, staticCall });
  };
  const localIsLibrary = isPaletteLibraryClass(localClassId, options);
  if (!skipEditorOnlyLibrary(localClassId, options?.parentClass, options)) {
    for (const fn of localFunctions) {
      pushRow(localClassId, fn, true, localIsLibrary);
    }
  }
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    if (skipEditorOnlyLibrary(classId, undefined, options)) continue;
    const library = isPaletteLibraryClass(classId, options);
    const implicitSelf = library || callImplicitSelf(classId, options);
    for (const fn of functionRows(graph)) {
      if (implicitSelf && !library && localNames.has(fn.name)) continue;
      pushRow(classId, fn, implicitSelf, library);
    }
  }
  for (const library of options?.functionLibraries ?? []) {
    if (skipEditorOnlyLibrary(library.classId, library.parentClass, options)) {
      continue;
    }
    if (
      !isPaletteLibraryClass(library.classId, options) &&
      !otherClassAllowedOnHost(library.classId, options)
    ) {
      continue;
    }
    for (const fn of library.functions) {
      pushRow(
        library.classId,
        { name: fn.name, pins: fn.pins ?? [] },
        true,
        true,
      );
    }
  }
  return rows.map(({ classId, fn, implicitSelf, staticCall }) => {
    const defaultData: Record<string, unknown> = {
      functionName: fn.name,
      classId,
      implicitSelf,
      pins: fn.pins,
    };
    if (staticCall) defaultData.static = true;
    return {
      id: `functions.call:${classId}:${fn.name}`,
      nodeType: "functions.call",
      title: `Call ${fn.name}`,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent:
        def.latent === true ||
        isLatentFunctionKey(classId, fn.name, latentFunctions, parentOf),
      defaultData,
    };
  });
}

function callInterfacePaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("interface.call");
  if (!def) return [];
  const rows: PaletteNode[] = [];
  const seen = new Set<string>();
  for (const iface of options?.scriptInterfaces ?? []) {
    for (const method of iface.methods) {
      if (!method.name) continue;
      const key = `${iface.guid}:${method.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pins = method.pins ?? [];
      const defaultData: Record<string, unknown> = {
        interfaceGuid: iface.guid,
        method: method.name,
        implicitSelf: true,
        pins,
        title: callInterfaceTitle(method.name),
      };
      rows.push({
        id: `interface.call:${iface.guid}:${method.name}`,
        nodeType: "interface.call",
        title: callInterfaceTitle(method.name),
        category: def.category,
        pins: def.pins(defaultData),
        pure: def.pure,
        latent: def.latent,
        defaultData,
      });
    }
  }
  return rows;
}

type VariableRow = {
  id: string;
  name: string;
  typeId: string;
  typeClassId?: string;
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  scope: "member" | "local";
  functionId?: string;
};

function classVariableRows(graph?: SerializedGraph): VariableRow[] {
  const byName = new Map<string, VariableRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "variable" || !member.name || member.functionId) {
      continue;
    }
    byName.set(member.name, {
      id: member.id,
      name: member.name,
      typeId: member.typeId ?? "float",
      ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
      ...(member.container === "array" || member.container === "map"
        ? { container: member.container }
        : {}),
      ...(member.keyTypeId ? { keyTypeId: member.keyTypeId } : {}),
      ...(member.keyTypeClassId ? { keyTypeClassId: member.keyTypeClassId } : {}),
      scope: "member",
    });
  }
  return [...byName.values()];
}

function localVariableRows(
  graph: SerializedGraph | undefined,
  functionId: string | null | undefined,
): VariableRow[] {
  if (!functionId) return [];
  const byName = new Map<string, VariableRow>();
  for (const member of graph?.members ?? []) {
    if (
      member.kind !== "variable" ||
      !member.name ||
      member.functionId !== functionId
    ) {
      continue;
    }
    byName.set(member.name, {
      id: member.id,
      name: member.name,
      typeId: member.typeId ?? "float",
      ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
      ...(member.container === "array" || member.container === "map"
        ? { container: member.container }
        : {}),
      ...(member.keyTypeId ? { keyTypeId: member.keyTypeId } : {}),
      ...(member.keyTypeClassId ? { keyTypeClassId: member.keyTypeClassId } : {}),
      scope: "local",
      functionId,
    });
  }
  return [...byName.values()];
}

function variableAccessPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const getDef = nodeRegistry.get("variables.get");
  const setDef = nodeRegistry.get("variables.set");
  const validatedDef = nodeRegistry.get("variables.getValidated");
  if (!getDef || !setDef) return [];
  const localClassId = options?.classId ?? "BObject";
  const classVars = classVariableRows(options?.graph);
  const classNames = new Set(classVars.map((entry) => entry.name));
  const rows: Array<{
    classId: string;
    variable: VariableRow;
    implicitSelf: boolean;
  }> = classVars.map((variable) => ({
    classId: localClassId,
    variable,
    implicitSelf: true,
  }));
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    const implicitSelf = callImplicitSelf(classId, options);
    for (const variable of classVariableRows(graph)) {
      if (implicitSelf && classNames.has(variable.name)) continue;
      rows.push({ classId, variable, implicitSelf });
    }
  }
  for (const variable of localVariableRows(
    options?.graph,
    options?.activeFunctionId,
  )) {
    rows.push({
      classId: localClassId,
      variable,
      implicitSelf: true,
    });
  }
  const injected: PaletteNode[] = [];
  const accessKinds: Array<["get" | "set" | "validatedGet", typeof getDef]> =
    options?.animationGraphHost === "rule"
      ? [["get", getDef]]
      : [
          ["get", getDef],
          ["set", setDef],
        ];
  for (const { classId, variable, implicitSelf } of rows) {
    const kinds = [...accessKinds];
    if (
      validatedDef &&
      options?.animationGraphHost !== "rule" &&
      isObjectInstanceVariableType(variable.typeId, variable.container)
    ) {
      kinds.push(["validatedGet", validatedDef]);
    }
    for (const [access, def] of kinds) {
      const title =
        access === "set"
          ? `Set ${variable.name}`
          : access === "validatedGet"
            ? `Validated Get ${variable.name}`
            : `Get ${variable.name}`;
      const nodeType =
        access === "set"
          ? "variables.set"
          : access === "validatedGet"
            ? "variables.getValidated"
            : "variables.get";
      const defaultData: Record<string, unknown> = {
        variableName: variable.name,
        variableId: variable.id,
        typeId: variable.typeId,
        classId,
        implicitSelf,
        scope: variable.scope,
        title,
      };
      if (variable.functionId) defaultData.functionId = variable.functionId;
      if (variable.typeClassId) defaultData.typeClassId = variable.typeClassId;
      if (variable.container === "array" || variable.container === "map") {
        defaultData.container = variable.container;
      }
      if (variable.container === "map") {
        defaultData.keyTypeId = variable.keyTypeId ?? "string";
        if (variable.keyTypeClassId) {
          defaultData.keyTypeClassId = variable.keyTypeClassId;
        }
      }
      injected.push({
        id: `${nodeType}:${classId}:${variable.name}`,
        nodeType,
        title,
        category: def.category,
        pins: def.pins(defaultData),
        pure: def.pure,
        latent: def.latent,
        defaultData,
      });
    }
  }
  return injected;
}

function castPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("casting.cast");
  if (!def) return [];
  const parentOf = parentLookup(options?.parentOf);
  const classIds = [
    ...knownClassIdSet(
      parentOf,
      [
        options?.classId,
        ...Object.keys(options?.otherClassGraphs ?? {}),
      ].filter((id): id is string => Boolean(id)),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return classIds.map((classId) => {
    const resultKind = resultKindForClass(classId, parentOf);
    const defaultData: Record<string, unknown> = {
      defaultClassId: classId,
      "default:class": classId,
      resultKind,
    };
    return {
      id: `casting.cast:${classId}`,
      nodeType: "casting.cast",
      title: `Cast to ${classId}`,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData,
    };
  });
}

function structPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const makeDef = nodeRegistry.get("struct.make");
  const breakDef = nodeRegistry.get("struct.break");
  if (!makeDef || !breakDef) return [];
  const rows: PaletteNode[] = [];
  for (const structure of options?.structures ?? []) {
    const defaultData: Record<string, unknown> = {
      structGuid: structure.guid,
      fields: structure.fields,
    };
    rows.push({
      id: `struct.make:${structure.guid}`,
      nodeType: "struct.make",
      title: `Make ${structure.name}`,
      category: makeDef.category,
      pins: makeDef.pins(defaultData),
      pure: makeDef.pure,
      latent: makeDef.latent,
      defaultData: { ...defaultData, title: `Make ${structure.name}` },
    });
    rows.push({
      id: `struct.break:${structure.guid}`,
      nodeType: "struct.break",
      title: `Break ${structure.name}`,
      category: breakDef.category,
      pins: breakDef.pins(defaultData),
      pure: breakDef.pure,
      latent: breakDef.latent,
      defaultData: { ...defaultData, title: `Break ${structure.name}` },
    });
  }
  return rows;
}

function enumPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const makeDef = nodeRegistry.get("enum.make");
  const equalDef = nodeRegistry.get("enum.equals");
  const notEqualDef = nodeRegistry.get("enum.notEquals");
  const toStringDef = nodeRegistry.get("enum.toString");
  const switchDef = nodeRegistry.get("enum.switch");
  const selectDef = nodeRegistry.get("enum.select");
  if (
    !makeDef ||
    !equalDef ||
    !notEqualDef ||
    !toStringDef ||
    !switchDef ||
    !selectDef
  ) {
    return [];
  }
  const rows: PaletteNode[] = [];
  for (const entry of options?.enums ?? []) {
    const defaultData: Record<string, unknown> = {
      enumGuid: entry.guid,
      members: entry.members,
      value: entry.members[0]?.name ?? "",
    };
    rows.push({
      id: `enum.make:${entry.guid}`,
      nodeType: "enum.make",
      title: `Make ${entry.name}`,
      category: makeDef.category,
      pins: makeDef.pins(defaultData),
      pure: makeDef.pure,
      latent: makeDef.latent,
      defaultData: { ...defaultData, title: `Make ${entry.name}` },
    });
    rows.push({
      id: `enum.equals:${entry.guid}`,
      nodeType: "enum.equals",
      title: `Equal ${entry.name}`,
      category: equalDef.category,
      pins: equalDef.pins(defaultData),
      pure: equalDef.pure,
      latent: equalDef.latent,
      defaultData: { ...defaultData, title: `Equal ${entry.name}` },
    });
    rows.push({
      id: `enum.notEquals:${entry.guid}`,
      nodeType: "enum.notEquals",
      title: `Not Equal ${entry.name}`,
      category: notEqualDef.category,
      pins: notEqualDef.pins(defaultData),
      pure: notEqualDef.pure,
      latent: notEqualDef.latent,
      defaultData: { ...defaultData, title: `Not Equal ${entry.name}` },
    });
    rows.push({
      id: `enum.toString:${entry.guid}`,
      nodeType: "enum.toString",
      title: `${entry.name} to String`,
      category: toStringDef.category,
      pins: toStringDef.pins(defaultData),
      pure: toStringDef.pure,
      latent: toStringDef.latent,
      defaultData: { ...defaultData, title: `${entry.name} to String` },
    });
    rows.push({
      id: `enum.switch:${entry.guid}`,
      nodeType: "enum.switch",
      title: `Switch on ${entry.name}`,
      category: switchDef.category,
      pins: switchDef.pins(defaultData),
      pure: switchDef.pure,
      latent: switchDef.latent,
      defaultData: { ...defaultData, title: `Switch on ${entry.name}` },
    });
    const selectData: Record<string, unknown> = {
      enumGuid: entry.guid,
      members: entry.members,
      "default:index": entry.members[0]?.name ?? "",
    };
    rows.push({
      id: `enum.select:${entry.guid}`,
      nodeType: "enum.select",
      title: `Select ${entry.name}`,
      category: selectDef.category,
      pins: selectDef.pins(selectData),
      pure: selectDef.pure,
      latent: selectDef.latent,
      defaultData: { ...selectData, title: `Select ${entry.name}` },
    });
  }
  return rows;
}

export type ScriptPaletteBuildOptions = {
  /** Default true. False returns host-legal catalog rows only (no injectors). */
  injectors?: boolean;
  cache?: ScriptPaletteCache;
};

/** Session-lifetime injector cache keyed by class-set / FL / member identity. */
export class ScriptPaletteCache {
  injectors = 0;
  private key: string | null = null;
  private rows: PaletteNode[] | null = null;

  getOrBuild(key: string, build: () => PaletteNode[]): PaletteNode[] {
    if (this.key === key && this.rows) return this.rows;
    this.injectors += 1;
    this.rows = build();
    this.key = key;
    return this.rows;
  }

  clear(): void {
    this.key = null;
    this.rows = null;
    this.injectors = 0;
  }
}

function graphPaletteMemberFingerprint(graph?: SerializedGraph): unknown {
  return {
    members: graph?.members ?? [],
    events: customEventRows(graph),
    functions: functionRows(graph),
    functionGraphs: Object.fromEntries(
      Object.entries(graph?.functionGraphs ?? {}).map(([id, slice]) => [
        id,
        slice.nodes.map((node) => ({
          type:
            typeof node.data.__nodeType === "string"
              ? node.data.__nodeType
              : node.type,
          async: node.data.async === true,
          functionName: node.data.functionName,
          classId: node.data.classId,
        })),
      ]),
    ),
  };
}

/** Identity for Cast/FL/Get Widget injectors — not graph pin or position data. */
export function scriptPaletteInjectorKey(
  options?: ScriptPaletteOptions,
): string {
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const seed = [
    options?.classId,
    typeof options?.parentClass === "string" ? options.parentClass : null,
    ...Object.keys(options?.otherClassGraphs ?? {}),
    ...(options?.functionLibraries ?? []).map((lib) => lib.classId),
  ].filter((id): id is string => Boolean(id));
  const classIds = [...knownClassIdSet(parentOf, seed)].sort((a, b) =>
    a.localeCompare(b),
  );
  const other = Object.entries(options?.otherClassGraphs ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, graph]) => [id, graphPaletteMemberFingerprint(graph)]);
  return JSON.stringify({
    parentClass: options?.parentClass ?? null,
    classId: options?.classId ?? null,
    assetType: options?.assetType ?? null,
    animationGraphHost: options?.animationGraphHost ?? null,
    activeFunctionId: options?.activeFunctionId ?? null,
    classes: classIds.map((id) => [id, parentOf(id) ?? null]),
    graph: graphPaletteMemberFingerprint(options?.graph),
    other,
    functionLibraries: options?.functionLibraries ?? [],
    widgets: options?.widgets ?? [],
    scriptInterfaces: options?.scriptInterfaces ?? [],
    structures: options?.structures ?? [],
    enums: options?.enums ?? [],
  });
}

function scriptPaletteCatalogNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  return nodeRegistry
    .list()
    .filter((def) => {
      if (def.editorOnly && !isEditorGraphHost(options ?? {})) {
        return false;
      }
      if (options?.animationGraphHost === "rule" && def.pure !== true) {
        return false;
      }
      return isScriptCatalogNodeAllowed(def.id, options);
    })
    .map((def) => {
      const defaultData: Record<string, unknown> = {};
      if (def.id === "debug.log") {
        defaultData.message = "";
        defaultData.severity = "log";
        defaultData.category = "Script";
      }
      if (def.developmentOnlyByDefault) {
        defaultData.developmentOnly = true;
      }
      if (def.id === "string.format") {
        defaultData["default:format"] = "{input}";
      }
      if (
        def.id === "audio.play" ||
        def.id === "audio.setChannelVolume" ||
        def.id === "audio.setGlobalVolume"
      ) {
        defaultData["default:volume"] = 1;
      }
      if (def.id === "input.setInputMode") {
        defaultData.mode = "All";
      }
      const pins = def.pins(defaultData);
      if (def.editorOnly) defaultData.__editorOnly = true;
      return {
        id: def.id,
        title: def.title,
        category: def.category,
        pins,
        pure: def.pure,
        latent: def.latent,
        editorOnly: def.editorOnly,
        defaultData:
          Object.keys(defaultData).length > 0 ? defaultData : undefined,
      };
    });
}

function scriptPaletteInjectorNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  if (options?.animationGraphHost === "rule") {
    return variableAccessPaletteNodes(nodeRegistry, options);
  }
  return [
    ...callCustomEventPaletteNodes(nodeRegistry, options),
    ...callFunctionPaletteNodes(nodeRegistry, options),
    ...callInterfacePaletteNodes(nodeRegistry, options),
    ...variableAccessPaletteNodes(nodeRegistry, options),
    ...castPaletteNodes(nodeRegistry, options),
    ...structPaletteNodes(nodeRegistry, options),
    ...enumPaletteNodes(nodeRegistry, options),
    ...getWidgetPaletteNodes(nodeRegistry, options),
  ];
}

/** Palette rows for Class graphs and UserInterface Logic (pins from the registry). */
export function scriptPaletteNodes(
  nodeRegistry: NodeRegistry = registry,
  options?: ScriptPaletteOptions,
  build: ScriptPaletteBuildOptions = {},
): PaletteNode[] {
  if (build.injectors === false) {
    return scriptPaletteCatalogNodes(nodeRegistry, options);
  }
  const assemble = () => [
    ...scriptPaletteCatalogNodes(nodeRegistry, options),
    ...scriptPaletteInjectorNodes(nodeRegistry, options),
  ];
  if (build.cache) {
    return build.cache.getOrBuild(scriptPaletteInjectorKey(options), assemble);
  }
  return assemble();
}

function getWidgetPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get(uiGetWidgetNodeId);
  if (!def || !options?.widgets?.length) return [];
  return boundGetWidgetEntries(options.widgets).map((entry) => ({
    id: entry.id,
    nodeType: entry.nodeType,
    title: entry.title,
    category: def.category,
    pins: def.pins(entry.defaultData),
    pure: def.pure,
    latent: def.latent,
    defaultData: entry.defaultData,
  }));
}

export function hydrateClassDocumentPayload(
  payload: Record<string, unknown> | SerializedGraph,
): SerializedGraph {
  if (Array.isArray(payload.nodes) && Array.isArray(payload.edges)) {
    return payload as unknown as SerializedGraph;
  }
  return createDefaultLogicGraphSerialized();
}

export function materializeLogicGraph(
  content: SerializedGraph | LogicGraph,
  graphId: string,
  kind: LogicGraph["kind"] = "event",
  options?: HydrateGraphOptions,
): LogicGraph {
  if (isLogicGraphPayload(content)) return content;
  const logic = fromSerializedGraph(content, graphId, kind);
  for (let i = 0; i < logic.nodes.length; i++) {
    const data = content.nodes[i]?.data as
      | { __pins?: LogicGraph["nodes"][0]["pins"]; __nodeType?: string }
      | undefined;
    const typeId = data?.__nodeType ?? logic.nodes[i]!.typeId;
    const properties = { ...logic.nodes[i]!.properties };
    applyStructEnumSchema(
      typeId,
      properties,
      content,
      logic.nodes[i]!.id,
      registry,
      options,
    );
    if (typeId === "flow.switchInt") {
      properties.cases = normalizeIntSwitchCases(properties.cases).cases;
    }
    if (typeId === "flow.switchString") {
      properties.cases = normalizeStringSwitchCases(properties.cases).cases;
    }
    const regenerate = shouldRegeneratePins(typeId);
    const def = registry.get(typeId);
    if (data?.__pins && !regenerate) {
      logic.nodes[i] = {
        ...logic.nodes[i]!,
        pins: data.__pins,
        typeId,
        properties,
      };
    } else if (def) {
      logic.nodes[i] = {
        ...logic.nodes[i]!,
        typeId,
        properties,
        pins: def.pins(properties),
      };
    } else if (data?.__pins) {
      logic.nodes[i] = {
        ...logic.nodes[i]!,
        pins: data.__pins,
        typeId,
        properties,
      };
    }
  }
  // Rebuild edges from handles when present on SerializedGraph.
  const rawEdges = content.edges as Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
  logic.edges = rawEdges
    .map((e, i) => ({
      id: e.id || `e${i}`,
      sourceNodeId: e.source,
      sourcePinId: e.sourceHandle ?? logic.edges[i]?.sourcePinId ?? "execOut",
      targetNodeId: e.target,
      targetPinId: e.targetHandle ?? logic.edges[i]?.targetPinId ?? "execIn",
    }))
    .filter((edge) => {
      const source = logic.nodes.find((node) => node.id === edge.sourceNodeId);
      const target = logic.nodes.find((node) => node.id === edge.targetNodeId);
      if (source && !source.pins.some((pin) => pin.id === edge.sourcePinId)) {
        return false;
      }
      if (target && !target.pins.some((pin) => pin.id === edge.targetPinId)) {
        return false;
      }
      return true;
    });
  return logic;
}

export function classHierarchyFromParentOf(
  parentOf: (id: string) => string | null | undefined,
): ClassHierarchy {
  return {
    isSubclassOf(childClassId, parentClassId) {
      if (childClassId === parentClassId) return true;
      return walkAncestry(childClassId, parentOf).includes(parentClassId);
    },
  };
}

export function classMemberSymbolsFromGraphs(
  graphs: Record<string, SerializedGraph>,
): ClassMemberSymbol[] {
  const symbols: ClassMemberSymbol[] = [];
  for (const [classId, graph] of Object.entries(graphs)) {
    for (const member of graph.members ?? []) {
      if (member.kind === "interface") continue;
      const name =
        member.kind === "event"
          ? formatEventMemberName(member.name)
          : member.name;
      if (!name) continue;
      const symbol: ClassMemberSymbol = {
        id: member.id,
        name,
        kind: member.kind,
        classId,
      };
      if (member.functionId) symbol.functionId = member.functionId;
      if (member.typeId) symbol.typeId = member.typeId;
      if (member.typeClassId) symbol.typeClassId = member.typeClassId;
      if (member.container === "array" || member.container === "map") {
        symbol.container = member.container;
      }
      if (member.keyTypeId) symbol.keyTypeId = member.keyTypeId;
      if (member.keyTypeClassId) symbol.keyTypeClassId = member.keyTypeClassId;
      if (member.kind === "function") {
        if (member.pins) symbol.pins = member.pins;
        if (member.implementsInterface) {
          symbol.implementsInterface = member.implementsInterface;
        }
        if (member.overrides) symbol.overrides = member.overrides;
      }
      symbols.push(symbol);
    }
  }
  return symbols;
}

export function knownClassIdSet(
  parentOf: (id: string) => string | null | undefined,
  classIds: readonly string[],
): Set<string> {
  const ids = new Set<string>([
    ...ENGINE_BASE_CLASS_IDS,
    ...ENGINE_COMPONENT_CLASS_IDS,
    ...ENGINE_WIDGET_CLASS_IDS,
    ...ENGINE_BT_BUILTIN_CLASSES.map((entry) => entry.id),
  ]);
  for (const id of classIds) {
    ids.add(id);
    for (const ancestor of walkAncestry(id, parentOf)) ids.add(ancestor);
  }
  return ids;
}

export function scriptPinCompatibility(
  hierarchy?: ClassHierarchy,
): PinCompatibilityRule {
  return (outgoing, incoming) =>
    isAssignable(outgoing.type as PinType, incoming.type as PinType, {
      hierarchy,
    });
}

export type ValidateSerializedGraphOptions = {
  assetGuid: string;
  graphId: string;
  hierarchy?: ClassHierarchy;
  classId?: string;
  activeFunctionId?: string | null;
  members?: readonly ClassMemberSymbol[];
  knownClassIds?: ReadonlySet<string>;
  implementedInterfaces?: readonly InterfaceMethodContext[];
  parentFunctionSignatures?: readonly ParentFunctionSignature[];
  knownGuids?: ReadonlySet<string>;
  enums?: TypeSchemas["enums"];
  structs?: TypeSchemas["structs"];
};

export function validateSerializedGraph(
  content: SerializedGraph | LogicGraph,
  options: ValidateSerializedGraphOptions,
): Diagnostic[] {
  const ctx = {
    assetGuid: options.assetGuid,
    hierarchy: options.hierarchy,
    classId: options.classId,
    activeFunctionId: options.activeFunctionId,
    members: options.members,
    knownClassIds: options.knownClassIds,
    implementedInterfaces: options.implementedInterfaces,
    parentFunctionSignatures: options.parentFunctionSignatures,
    knownGuids:
      options.knownGuids ??
      (options.enums || options.structs
        ? knownGuidsFromSchemas({
            enums: options.enums ?? {},
            structs: options.structs ?? {},
          })
        : undefined),
    enums: options.enums,
    structs: options.structs,
  };
  if (isLogicGraphPayload(content)) {
    return [
      ...validateGraphs([content], ctx, { registry }),
      ...warnDebugTierConsoleCommands([content], { assetGuid: options.assetGuid }),
      ...warnReservedConsoleCommandNames([content], { assetGuid: options.assetGuid }),
    ];
  }
  const typeOptions: HydrateGraphOptions = {
    enums: options.enums,
    structs: options.structs,
  };
  const eventGraph = materializeLogicGraph(
    content,
    options.graphId,
    "event",
    typeOptions,
  );
  const graphs = [eventGraph];
  for (const [memberId, slice] of Object.entries(content.functionGraphs ?? {})) {
    graphs.push(
      materializeLogicGraph(
        { nodes: slice.nodes, edges: slice.edges },
        memberId,
        "function",
        typeOptions,
      ),
    );
  }
  return [
    ...validateGraphs(graphs, ctx, { registry }),
    ...warnDebugTierConsoleCommands(graphs, { assetGuid: options.assetGuid }),
    ...warnReservedConsoleCommandNames(graphs, { assetGuid: options.assetGuid }),
  ];
}

export function projectHasBlockingErrors(
  diagnostics: readonly Diagnostic[],
): boolean {
  return hasBlockingErrors(diagnostics);
}

export { registry as defaultNodeRegistry };
