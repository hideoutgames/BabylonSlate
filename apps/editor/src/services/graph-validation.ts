import {
  isEditorFunctionLibraryClass,
  isEditorGraphClass,
  isEditorGraphHost,
  isFunctionLibraryClass,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@babylonslate/core";
import { engineParentOf, formatEventMemberName, walkAncestry } from "@babylonslate/editor-kit";
import {
  fromSerializedGraph,
  validateGraphs,
  hasBlockingErrors,
  toSerializedGraph as logicToSerializedGraph,
  isAssignable,
  type ClassHierarchy,
  type ClassMemberSymbol,
  type Diagnostic,
  isLogicGraphPayload,
  type LogicGraph,
  type NodeRegistry,
  type GraphPin,
  type PinType,
} from "@babylonslate/scripting";
import {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_BT_BUILTIN_CLASSES,
  ENGINE_COMPONENT_CLASS_IDS,
} from "@babylonslate/object-model";
import { createDefaultNodeRegistry, castDefaultClassId } from "@babylonslate/scripting-nodes";
import { warnDebugTierConsoleCommands } from "@babylonslate/debugger";
import type { PaletteNode, PinCompatibilityRule } from "@babylonslate/graph-ui";
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
  return (
    typeId === "flow.event.call" ||
    typeId === "functions.call" ||
    typeId === "flow.function.input" ||
    typeId === "flow.function.output" ||
    typeId === "variables.get" ||
    typeId === "variables.set" ||
    typeId === "casting.cast"
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
  return walkAncestry(classId, parentOf).includes("Actor")
    ? "actorRef"
    : "objectRef";
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

export type HydrateGraphOptions = {
  parentOf?: (id: string) => string | null | undefined;
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
          ),
        };
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
                  title:
                    typeId === "flow.event.call" &&
                    typeof properties.title === "string"
                      ? properties.title
                      : (authoredTitle ?? def.title),
                }
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

function withVisualMeta(
  data: Record<string, unknown>,
  def:
    | { category: string; pure?: boolean; latent?: boolean; editorOnly?: boolean }
    | undefined,
  typeId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...data,
    __nodeType:
      typeof data.__nodeType === "string" ? data.__nodeType : typeId,
    __category:
      typeof data.__category === "string" ? data.__category : def?.category,
    __pure: data.__pure ?? def?.pure ?? false,
    __latent: data.__latent ?? def?.latent ?? false,
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
  activeFunctionId?: string | null;
  functionLibraries?: Array<{
    classId: string;
    parentClass?: string | null;
    functions: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
  }>;
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
      latent: def.latent,
      defaultData,
    };
  });
}

type VariableRow = {
  id: string;
  name: string;
  typeId: string;
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
  for (const { classId, variable, implicitSelf } of rows) {
    for (const [access, def] of [
      ["get", getDef],
      ["set", setDef],
    ] as const) {
      const defaultData: Record<string, unknown> = {
        variableName: variable.name,
        variableId: variable.id,
        typeId: variable.typeId,
        classId,
        implicitSelf,
        scope: variable.scope,
        title: `${access === "get" ? "Get" : "Set"} ${variable.name}`,
      };
      if (variable.functionId) defaultData.functionId = variable.functionId;
      injected.push({
        id: `variables.${access}:${classId}:${variable.name}`,
        nodeType: `variables.${access}`,
        title: `${access === "get" ? "Get" : "Set"} ${variable.name}`,
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

/** Palette rows for Class graphs and UserInterface Logic (pins from the registry). */
export function scriptPaletteNodes(
  nodeRegistry: NodeRegistry = registry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const catalog = nodeRegistry
    .list()
    .filter((def) => {
      if (
        def.editorOnly &&
        !isEditorGraphHost(options ?? {})
      ) {
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
    if (def.id === "debug.print") {
      defaultData.developmentOnly = true;
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
  return [
    ...catalog,
    ...callCustomEventPaletteNodes(nodeRegistry, options),
    ...callFunctionPaletteNodes(nodeRegistry, options),
    ...variableAccessPaletteNodes(nodeRegistry, options),
    ...castPaletteNodes(nodeRegistry, options),
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
};

export function validateSerializedGraph(
  content: SerializedGraph | LogicGraph,
  options: ValidateSerializedGraphOptions,
): Diagnostic[] {
  const graph = materializeLogicGraph(content, options.graphId);
  return [
    ...validateGraphs([graph], {
      assetGuid: options.assetGuid,
      hierarchy: options.hierarchy,
      classId: options.classId,
      activeFunctionId: options.activeFunctionId,
      members: options.members,
      knownClassIds: options.knownClassIds,
    }),
    ...warnDebugTierConsoleCommands([graph], { assetGuid: options.assetGuid }),
  ];
}

export function projectHasBlockingErrors(
  diagnostics: readonly Diagnostic[],
): boolean {
  return hasBlockingErrors(diagnostics);
}

export { registry as defaultNodeRegistry };
