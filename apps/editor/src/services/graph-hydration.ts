/**
 * Graph-level passes over a serialized graph: editor hydration, component event
 * binding and materialization to a `LogicGraph`, plus the one default node
 * registry. `graph-validation.ts` re-exports the public names.
 */
import type { SerializedGraph } from "@haptic/core";
import { formatEventMemberName, formatEventTitle } from "@haptic/editor-kit";
import {
  fromSerializedGraph,
  isAssignable,
  isLogicGraphPayload,
  type ClassHierarchy,
  type LogicGraph,
  type NodeRegistry,
  type GraphPin,
  type PinType,
  normalizeIntSwitchCases,
  normalizeStringSwitchCases,
  isLatentFunctionKey,
} from "@haptic/scripting";
import { engineEventTypeClassIds } from "@haptic/object-model";
import { componentGraphMembersForClass } from "../lib/component-graph-members";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { isDataGraphNode } from "../lib/data-graph";
import {
  classHierarchyFromParentOf,
  editorLatentFunctions,
  parentLookup,
} from "./graph-class-symbols";
import {
  applyInterfaceCallPins,
  applyStructEnumSchema,
  assetsByClassPinProperties,
  castPinProperties,
  catalogTypeId,
  hydratedNodeTitle,
  refreshInputEvent,
  refreshVariableReferenceAccess,
  shouldRegeneratePins,
  type HydrateGraphOptions,
} from "./graph-node-refresh";

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
  hierarchy: ClassHierarchy,
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
      !isVariableAccessTypeId(targetTypeId) &&
      !isDataGraphNode(sourceTypeId) &&
      !isDataGraphNode(targetTypeId)
    ) {
      return true;
    }
    const fromType = pinTypeFromHydratedPins(source.data, edge.sourceHandle);
    const toType = pinTypeFromHydratedPins(target.data, edge.targetHandle);
    if (!fromType || !toType) return true;
    return isAssignable(fromType, toType, { hierarchy });
  });
}

export function bindUnboundComponentEvents(
  graph: SerializedGraph,
  options?: HydrateGraphOptions,
): SerializedGraph {
  const members = componentGraphMembersForClass({
    graph,
    classId: options?.classId,
    parentOf: options?.parentOf,
    parentGraphs: options?.otherClassGraphs,
  });
  const typeClassIds = engineEventTypeClassIds();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const data = { ...(node.data as Record<string, unknown>) };
      if (typeof data.componentId === "string" && data.componentId.trim()) {
        return node;
      }
      const typeId = catalogTypeId({ type: node.type, data });
      const classes = typeClassIds[typeId];
      if (!classes) return node;
      const matches = members.filter((member) =>
        classes.includes(member.typeClassId ?? ""),
      );
      if (matches.length !== 1) return node;
      const match = matches[0];
      if (!match) return node;
      const raw = typeId.startsWith("flow.event.")
        ? typeId.slice("flow.event.".length)
        : typeId;
      return {
        ...node,
        data: {
          ...data,
          componentId: match.componentId,
          eventQualifier: match.name,
          title: formatEventTitle(raw, match.name),
        },
      };
    }),
  };
}

/**
 * Injects `data.__pins` from the node registry for canvas rendering.
 * Compile/validate already materialize pins separately; this keeps the UI in sync.
 */
export function hydrateSerializedGraphForEditor(
  input: SerializedGraph,
  nodeRegistry: NodeRegistry = registry,
  options?: HydrateGraphOptions,
): SerializedGraph {
  const graph = bindUnboundComponentEvents(input, options);
  const functionMember = graph.members?.find(
    (member) => member.kind === "function" && member.id === options?.functionId,
  );
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
        : (options?.classId ?? "Object");
    const functionName =
      typeof data.functionName === "string" ? data.functionName : "fn";
    return isLatentFunctionKey(classId, functionName, latentFunctions, parentOf);
  };
  const nodes = graph.nodes.map((node) => {
      const rawData = { ...(node.data as Record<string, unknown>) };
      const typeIdHint = catalogTypeId({ type: node.type, data: rawData });
      if (typeIdHint === "flow.function.input" || typeIdHint === "flow.function.output") {
        rawData.__interface = Boolean(functionMember?.implementsInterface);
      }
      refreshInputEvent(typeIdHint, rawData, options, graph, node.id);
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

      const typeId =
        typeof rawData.__nodeType === "string"
          ? rawData.__nodeType
          : node.type;
      const properties = { ...rawData };
      delete properties.__pins;
      delete properties.__nodeType;
      delete properties.title;
      refreshInputEvent(typeId, properties, options, graph, node.id);
      refreshVariableReferenceAccess(typeId, properties);

      const authoredTitle =
        typeof rawData.title === "string" && rawData.title.trim()
          ? rawData.title
          : undefined;

      if (typeId === "casting.cast") {
        const { pinProperties, defaultClassId, wiredClassId } = castPinProperties(properties, graph, node.id, nodeRegistry);
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

      if (typeId === "interface.call") {
        applyInterfaceCallPins(properties, options);
      }

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
          typeof properties.eventName === "string" ? properties.eventName : "";
        const bodyName = formatEventMemberName(rawName);
        if (bodyName) properties.eventName = bodyName;
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
      const pins: GraphPin[] = def
        ? def.pins(assetsByClassPinProperties(typeId, properties, graph, node.id, nodeRegistry))
        : [];

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
      classHierarchyFromParentOf(parentOf),
    ),
  };
}

function withVisualMeta(
  data: Record<string, unknown>,
  def:
    | {
        category: string;
        pure?: boolean;
        latent?: boolean;
        editorOnly?: boolean;
        declaredPinOrder?: boolean;
      }
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
  if (def?.declaredPinOrder === true) {
    next.__declaredPinOrder = true;
  }
  return next;
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
    if (typeId === "interface.call") {
      applyInterfaceCallPins(properties, options);
    }
    if (typeId === "flow.switchInt") {
      properties.cases = normalizeIntSwitchCases(properties.cases).cases;
    }
    if (typeId === "flow.switchString") {
      properties.cases = normalizeStringSwitchCases(properties.cases).cases;
    }
    refreshInputEvent(typeId, properties, options, content, logic.nodes[i]!.id);
    refreshVariableReferenceAccess(typeId, properties);
    // Pins follow a wired Class here exactly as they do on the canvas.
    const pinProperties = typeId === "casting.cast"
      ? castPinProperties(properties, content, logic.nodes[i]!.id, registry).pinProperties
      : assetsByClassPinProperties(typeId, properties, content, logic.nodes[i]!.id, registry);
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
        pins: def.pins(pinProperties),
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
      sourcePinId: e.sourceHandle ?? "",
      targetNodeId: e.target,
      targetPinId: e.targetHandle ?? "",
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

export { registry as defaultNodeRegistry };
