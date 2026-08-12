import type { SerializedGraph } from "@babylonslate/core";
import {
  fromSerializedGraph,
  validateGraphs,
  hasBlockingErrors,
  toSerializedGraph as logicToSerializedGraph,
  type Diagnostic,
  isLogicGraphPayload,
  type LogicGraph,
  type NodeRegistry,
  type GraphPin,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { warnDebugTierConsoleCommands } from "@babylonslate/debugger";

const registry = createDefaultNodeRegistry();

function hasNonEmptyPins(data: Record<string, unknown>): boolean {
  return Array.isArray(data.__pins) && data.__pins.length > 0;
}

function withVisualMeta(
  data: Record<string, unknown>,
  def: { category: string; pure?: boolean; latent?: boolean } | undefined,
  typeId: string,
): Record<string, unknown> {
  return {
    ...data,
    __nodeType:
      typeof data.__nodeType === "string" ? data.__nodeType : typeId,
    __category:
      typeof data.__category === "string" ? data.__category : def?.category,
    __pure: data.__pure ?? def?.pure ?? false,
    __latent: data.__latent ?? def?.latent ?? false,
  };
}

/**
 * Injects `data.__pins` from the node registry for canvas rendering.
 * Compile/validate already materialize pins separately; this keeps the UI in sync.
 */
export function hydrateSerializedGraphForEditor(
  graph: SerializedGraph,
  nodeRegistry: NodeRegistry = registry,
): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const rawData = { ...(node.data as Record<string, unknown>) };
      const typeIdHint =
        typeof rawData.__nodeType === "string" ? rawData.__nodeType : node.type;
      if (hasNonEmptyPins(rawData)) {
        return {
          ...node,
          data: withVisualMeta(
            rawData,
            nodeRegistry.get(typeIdHint),
            typeIdHint,
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

      const def = nodeRegistry.get(typeId);
      const pins: GraphPin[] = def ? def.pins(properties) : [];
      const authoredTitle =
        typeof rawData.title === "string" && rawData.title.trim()
          ? rawData.title
          : undefined;

      return {
        ...node,
        type: typeId,
        data: withVisualMeta(
          {
            ...properties,
            ...(def
              ? { title: authoredTitle ?? def.title }
              : authoredTitle
                ? { title: authoredTitle }
                : {}),
            __pins: pins,
          },
          def,
          typeId,
        ),
      };
    }),
  };
}

/** New graphs seed Event Begin Play + Event Tick with registry pins. */
export function createDefaultLogicGraphSerialized(
  nodeRegistry: NodeRegistry = registry,
): SerializedGraph {
  const beginDef = nodeRegistry.get("flow.event.beginPlay");
  const tickDef = nodeRegistry.get("flow.event.tick");
  if (!beginDef || !tickDef) {
    throw new Error("Default event nodes missing from node registry");
  }

  const logic: LogicGraph = {
    id: "main",
    kind: "event",
    nodes: [
      {
        id: "event-begin-play",
        typeId: beginDef.id,
        position: { x: 80, y: 80 },
        pins: beginDef.pins({}),
        properties: {},
      },
      {
        id: "event-tick",
        typeId: tickDef.id,
        position: { x: 80, y: 220 },
        pins: tickDef.pins({}),
        properties: {},
      },
    ],
    edges: [],
  };

  return logicToSerializedGraph(logic);
}

export function materializeLogicGraph(
  content: SerializedGraph | LogicGraph,
  graphId: string,
): LogicGraph {
  if (isLogicGraphPayload(content)) return content;
  const logic = fromSerializedGraph(content, graphId);
  // Overlay __pins when present.
  for (let i = 0; i < logic.nodes.length; i++) {
    const data = content.nodes[i]?.data as
      | { __pins?: LogicGraph["nodes"][0]["pins"]; __nodeType?: string }
      | undefined;
    if (data?.__pins) {
      logic.nodes[i] = {
        ...logic.nodes[i]!,
        pins: data.__pins,
        typeId: data.__nodeType ?? logic.nodes[i]!.typeId,
      };
    } else {
      const def = registry.get(logic.nodes[i]!.typeId);
      if (def) {
        logic.nodes[i] = {
          ...logic.nodes[i]!,
          pins: def.pins(logic.nodes[i]!.properties),
        };
      }
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
  logic.edges = rawEdges.map((e, i) => ({
    id: e.id || `e${i}`,
    sourceNodeId: e.source,
    sourcePinId: e.sourceHandle ?? logic.edges[i]?.sourcePinId ?? "execOut",
    targetNodeId: e.target,
    targetPinId: e.targetHandle ?? logic.edges[i]?.targetPinId ?? "execIn",
  }));
  return logic;
}

export function validateSerializedGraph(
  content: SerializedGraph | LogicGraph,
  options: { assetGuid: string; graphId: string },
): Diagnostic[] {
  const graph = materializeLogicGraph(content, options.graphId);
  return [
    ...validateGraphs([graph], { assetGuid: options.assetGuid }),
    ...warnDebugTierConsoleCommands([graph], { assetGuid: options.assetGuid }),
  ];
}

export function projectHasBlockingErrors(
  diagnostics: readonly Diagnostic[],
): boolean {
  return hasBlockingErrors(diagnostics);
}

export { registry as defaultNodeRegistry };
