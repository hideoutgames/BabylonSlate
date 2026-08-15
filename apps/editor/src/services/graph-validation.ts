import type { GraphClassMemberPin, SerializedGraph } from "@babylonslate/core";
import { engineParentOf, walkAncestry } from "@babylonslate/editor-kit";
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
import type { PaletteNode } from "@babylonslate/graph-ui";
import {
  isScriptCatalogNodeAllowed,
  nativeEventStubs,
  type ClassEventOptions,
} from "../lib/class-members";

const registry = createDefaultNodeRegistry();

function hasNonEmptyPins(data: Record<string, unknown>): boolean {
  return Array.isArray(data.__pins) && data.__pins.length > 0;
}

function catalogTypeId(node: {
  type: string;
  data: Record<string, unknown>;
}): string {
  const hinted = node.data.__nodeType;
  return typeof hinted === "string" ? hinted : node.type;
}

function shouldRegeneratePins(typeId: string): boolean {
  return typeId === "flow.event.call" || typeId === "functions.call";
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
      const typeIdHint = catalogTypeId({ type: node.type, data: rawData });
      if (hasNonEmptyPins(rawData) && !shouldRegeneratePins(typeIdHint)) {
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

/** New graphs seed native events for the class parent (Actor Begin Play + Tick by default). */
export function createDefaultLogicGraphSerialized(
  nodeRegistry: NodeRegistry = registry,
  options?: ClassEventOptions,
): SerializedGraph {
  const stubs = nativeEventStubs(options);
  const logic: LogicGraph = {
    id: "main",
    kind: "event",
    nodes: stubs.map((stub, index) => {
      const def = nodeRegistry.get(stub.eventType);
      if (!def) {
        throw new Error(`Default event node missing from node registry: ${stub.eventType}`);
      }
      return {
        id: defaultEventNodeId(stub.eventType),
        typeId: def.id,
        position: { x: 80, y: 80 + index * 140 },
        pins: def.pins({}),
        properties: {},
      };
    }),
    edges: [],
  };

  return logicToSerializedGraph(logic);
}

export type ScriptPaletteOptions = ClassEventOptions & {
  classId?: string;
  graph?: SerializedGraph;
  otherClassGraphs?: Record<string, SerializedGraph>;
};

type CustomEventRow = {
  name: string;
  pins: GraphClassMemberPin[];
};

function customEventRows(graph?: SerializedGraph): CustomEventRow[] {
  const byName = new Map<string, CustomEventRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "event" || !member.name) continue;
    byName.set(member.name, {
      name: member.name,
      pins: member.pins ?? [],
    });
  }
  for (const node of graph?.nodes ?? []) {
    if (node.type !== "flow.event.custom") continue;
    const name = typeof node.data.name === "string" ? node.data.name : "";
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

function callFunctionPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("functions.call");
  if (!def) return [];
  const localClassId = options?.classId ?? "BObject";
  const localFunctions = functionRows(options?.graph);
  const localNames = new Set(localFunctions.map((entry) => entry.name));
  const rows: Array<{
    classId: string;
    fn: FunctionRow;
    implicitSelf: boolean;
  }> = localFunctions.map((fn) => ({
    classId: localClassId,
    fn,
    implicitSelf: true,
  }));
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    const implicitSelf = callImplicitSelf(classId, options);
    for (const fn of functionRows(graph)) {
      if (implicitSelf && localNames.has(fn.name)) continue;
      rows.push({ classId, fn, implicitSelf });
    }
  }
  return rows.map(({ classId, fn, implicitSelf }) => {
    const defaultData: Record<string, unknown> = {
      functionName: fn.name,
      classId,
      implicitSelf,
      pins: fn.pins,
    };
    return {
      id: `functions.call:${classId}:${fn.name}`,
      nodeType: "functions.call",
      title: `Call ${fn.name}`,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData,
    };
  });
}

/** Palette rows for Class graphs and UserInterface Logic (pins from the registry). */
export function scriptPaletteNodes(
  nodeRegistry: NodeRegistry = registry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const catalog = nodeRegistry
    .list()
    .filter((def) => isScriptCatalogNodeAllowed(def.id, options))
    .map((def) => {
    const defaultData: Record<string, unknown> = {};
    if (def.id === "debug.log") {
      defaultData.message = "";
      defaultData.severity = "log";
      defaultData.category = "Script";
    }
    if (def.id === "debug.print") {
      defaultData.developmentOnly = true;
    }
    return {
      id: def.id,
      title: def.title,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData:
        Object.keys(defaultData).length > 0 ? defaultData : undefined,
    };
  });
  return [
    ...catalog,
    ...callCustomEventPaletteNodes(nodeRegistry, options),
    ...callFunctionPaletteNodes(nodeRegistry, options),
  ];
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
): LogicGraph {
  if (isLogicGraphPayload(content)) return content;
  const logic = fromSerializedGraph(content, graphId, kind);
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
