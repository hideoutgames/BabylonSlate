import {
  isEditorGraphHost,
  isFunctionLibraryClass,
  type GraphClassMember,
  type GraphClassMemberKind,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  engineParentOf,
  formatEventMemberName,
  formatEventTitle,
  walkAncestry,
} from "@babylonslate/editor-kit";

export type { GraphClassMember, GraphClassMemberKind, GraphClassMemberPin };

export const DEFAULT_FUNCTION_PINS: GraphClassMemberPin[] = [
  { name: "exec", typeId: "exec", direction: "in" },
  { name: "then", typeId: "exec", direction: "out" },
];

export const NATIVE_CLASS_EVENT_TYPES = [
  "flow.event.beginPlay",
  "flow.event.tick",
] as const;

const NATIVE_EVENT_TITLES: Record<string, string> = {
  "flow.event.beginPlay": "Event Begin Play",
  "flow.event.tick": "Event Tick",
  "flow.event.commandRun": "Event On Command Run",
  "flow.event.editorStartup": "Event On Editor Startup",
  "flow.event.sceneOpen": "Event On Scene Open",
  "flow.event.sceneSaved": "Event On Scene Saved",
  "flow.event.editorShutdown": "Event On Editor Shutdown",
  "bt.event.activate": "On Activate",
  "bt.event.tick": "On Tick",
  "bt.event.abort": "On Abort",
  "bt.event.evaluate": "On Evaluate",
};

const EDITOR_UTILITY_EVENT_TYPES = [
  "flow.event.editorStartup",
  "flow.event.sceneOpen",
  "flow.event.sceneSaved",
  "flow.event.editorShutdown",
] as const;

const ACTOR_EVENT_TYPE_IDS = [
  "flow.event.beginPlay",
  "flow.event.tick",
  "flow.event.commandRun",
] as const;

const BT_LEAF_EVENT_TYPE_IDS = [
  "bt.event.activate",
  "bt.event.tick",
  "bt.event.abort",
  "bt.event.evaluate",
] as const;

const BT_TASK_EVENT_TYPE_IDS = [
  "bt.event.activate",
  "bt.event.tick",
  "bt.event.abort",
] as const;

const BT_DECORATOR_EVENT_TYPE_IDS = ["bt.event.evaluate"] as const;
const BT_SERVICE_EVENT_TYPE_IDS = ["bt.event.tick"] as const;

const BT_TASK_ONLY_NODE_IDS = ["bt.finish"] as const;
const BT_DECORATOR_ONLY_NODE_IDS = ["bt.returnCondition"] as const;
const BT_BLACKBOARD_NODE_IDS = ["bt.blackboard.get", "bt.blackboard.set"] as const;

export type ClassEventOptions = {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  assetType?: string | null;
  editorGraph?: boolean;
};

export type BlueprintSection = {
  id: string;
  label: string;
  kind: GraphClassMemberKind;
  local?: boolean;
};

const CLASS_BLUEPRINT_SECTIONS: BlueprintSection[] = [
  { id: "functions", label: "Functions", kind: "function" },
  { id: "variables", label: "Variables", kind: "variable" },
  { id: "events", label: "Events", kind: "event" },
  { id: "interfaces", label: "Interfaces", kind: "interface" },
];

const FUNCTION_LIBRARY_SECTIONS: BlueprintSection[] = [
  { id: "functions", label: "Functions", kind: "function" },
];

const LOCAL_VARIABLES_SECTION: BlueprintSection = {
  id: "local-variables",
  label: "Local Variables",
  kind: "variable",
  local: true,
};

function parentLookup(
  options?: ClassEventOptions,
): (id: string) => string | null | undefined {
  return options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
}

function isFunctionLibraryHost(options?: ClassEventOptions): boolean {
  return isFunctionLibraryClass(options?.parentClass, parentLookup(options));
}

/** Function libraries have no Event Graph; show Empty until a function is selected. */
export function functionLibraryShowsEventGraphEmpty(
  options?: ClassEventOptions & { activeFunctionId?: string | null },
): boolean {
  if (options?.activeFunctionId) return false;
  return isFunctionLibraryHost(options);
}

export function blueprintSectionsForClass(
  options?: ClassEventOptions & { activeFunctionId?: string | null },
): BlueprintSection[] {
  const sections = isFunctionLibraryHost(options)
    ? [...FUNCTION_LIBRARY_SECTIONS]
    : [...CLASS_BLUEPRINT_SECTIONS];
  if (!options?.activeFunctionId) return sections;
  if (isFunctionLibraryHost(options)) {
    return [...sections, LOCAL_VARIABLES_SECTION];
  }
  const variableIndex = sections.findIndex((section) => section.id === "variables");
  sections.splice(variableIndex + 1, 0, LOCAL_VARIABLES_SECTION);
  return sections;
}

export function classAllowsMemberKind(
  kind: GraphClassMemberKind,
  options?: ClassEventOptions & { local?: boolean },
): boolean {
  if (!isFunctionLibraryHost(options)) return true;
  if (kind === "function") return true;
  if (kind === "variable" && options?.local) return true;
  return false;
}

function ancestryChain(options?: ClassEventOptions): string[] {
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return walkAncestry(options?.parentClass ?? "Actor", parentOf);
}

function eventStubsForTypes(types: readonly string[]): Array<{
  eventType: string;
  name: string;
}> {
  return types.map((eventType) => ({
    eventType,
    name: NATIVE_EVENT_TITLES[eventType] ?? formatEventTitle(eventType),
  }));
}

export function nativeEventStubs(
  options?: ClassEventOptions,
): Array<{ eventType: string; name: string }> {
  const chain = ancestryChain(options);
  if (chain.includes("EditorUtilityObject")) {
    return eventStubsForTypes(EDITOR_UTILITY_EVENT_TYPES);
  }
  if (chain.includes("BTTask")) return eventStubsForTypes(BT_TASK_EVENT_TYPE_IDS);
  if (chain.includes("BTDecorator")) {
    return eventStubsForTypes(BT_DECORATOR_EVENT_TYPE_IDS);
  }
  if (chain.includes("BTService")) {
    return eventStubsForTypes(BT_SERVICE_EVENT_TYPE_IDS);
  }
  if (chain.includes("BTComposite")) return [];
  if (
    chain.includes("FunctionLibrary") ||
    chain.includes("EditorFunctionLibrary")
  ) {
    return [];
  }
  const types: string[] = [...NATIVE_CLASS_EVENT_TYPES];
  if (chain.includes("BDebugCommand")) {
    types.push("flow.event.commandRun");
  }
  return eventStubsForTypes(types);
}

/** Whether a script catalog node is legal on a Class graph for this parent. */
export function isScriptCatalogNodeAllowed(
  nodeId: string,
  options?: ClassEventOptions,
): boolean {
  if (nodeId === "flow.function.input" || nodeId === "flow.function.output") {
    return false;
  }
  if (nodeId === "flow.event.call" || nodeId === "functions.call") {
    return false;
  }
  if (nodeId === "variables.get" || nodeId === "variables.set") {
    return false;
  }
  const isEditorEvent = (EDITOR_UTILITY_EVENT_TYPES as readonly string[]).includes(
    nodeId,
  );
  if (
    isEditorEvent &&
    !isEditorGraphHost({
      parentClass: options?.parentClass,
      parentOf: options?.parentOf,
      assetType: options?.assetType,
      editorGraph: options?.editorGraph,
    })
  ) {
    return false;
  }
  const chain = ancestryChain(options);
  const isActorEvent = (ACTOR_EVENT_TYPE_IDS as readonly string[]).includes(nodeId);
  const isBtLeafEvent = (BT_LEAF_EVENT_TYPE_IDS as readonly string[]).includes(
    nodeId,
  );
  const isFinish = (BT_TASK_ONLY_NODE_IDS as readonly string[]).includes(nodeId);
  const isReturn = (BT_DECORATOR_ONLY_NODE_IDS as readonly string[]).includes(
    nodeId,
  );
  const isBlackboard = (BT_BLACKBOARD_NODE_IDS as readonly string[]).includes(
    nodeId,
  );
  if (
    chain.includes("FunctionLibrary") ||
    chain.includes("EditorFunctionLibrary")
  ) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isBtLeafEvent &&
      !isFinish &&
      !isReturn &&
      !isBlackboard
    );
  }
  if (chain.includes("EditorUtilityObject")) {
    return !isActorEvent && !isBtLeafEvent && !isFinish && !isReturn && !isBlackboard;
  }
  if (chain.includes("BTTask")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      nodeId !== "bt.event.evaluate" &&
      !isReturn
    );
  }
  if (chain.includes("BTDecorator")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isFinish &&
      nodeId !== "bt.event.activate" &&
      nodeId !== "bt.event.tick" &&
      nodeId !== "bt.event.abort"
    );
  }
  if (chain.includes("BTService")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isFinish &&
      !isReturn &&
      nodeId !== "bt.event.activate" &&
      nodeId !== "bt.event.abort" &&
      nodeId !== "bt.event.evaluate"
    );
  }
  if (chain.includes("BTComposite")) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isBtLeafEvent &&
      !isFinish &&
      !isReturn &&
      !isBlackboard
    );
  }
  return !isBtLeafEvent && !isFinish && !isReturn && !isBlackboard;
}

export function nativeStubId(eventType: string): string {
  return `native:${eventType}`;
}

export function memberNamePromptCopy(
  kind: GraphClassMemberKind,
  options?: { local?: boolean },
): {
  title: string;
  label: string;
} {
  switch (kind) {
    case "function":
      return { title: "Add Function", label: "Function Name" };
    case "variable":
      return options?.local
        ? { title: "Add Local Variable", label: "Variable Name" }
        : { title: "Add Variable", label: "Variable Name" };
    case "event":
      return { title: "Add Event", label: "Event Name" };
    default:
      return { title: "Add Interface", label: "Interface Name" };
  }
}

function nextId(factory?: () => string): string {
  return factory?.() ?? crypto.randomUUID();
}

function memberDefaults(
  kind: GraphClassMemberKind,
  extras?: Partial<GraphClassMember>,
): Partial<GraphClassMember> {
  if (kind === "variable") {
    return {
      typeId: extras?.typeId ?? "float",
      ...(extras?.defaultValue !== undefined
        ? { defaultValue: extras.defaultValue }
        : {}),
      ...(extras?.functionId ? { functionId: extras.functionId } : {}),
    };
  }
  if (kind === "function") {
    return { pins: extras?.pins ?? DEFAULT_FUNCTION_PINS };
  }
  if (kind === "interface") {
    return { assetGuid: extras?.assetGuid ?? "" };
  }
  if (kind === "event") {
    return { pins: extras?.pins ?? [] };
  }
  return {};
}

function seedFunctionGraph(
  member: GraphClassMember,
): NonNullable<SerializedGraph["functionGraphs"]>[string] {
  const pins = member.pins ?? DEFAULT_FUNCTION_PINS;
  return {
    nodes: [
      {
        id: `${member.id}-input`,
        type: "flow.function.input",
        position: { x: 80, y: 120 },
        data: {
          title: "Input",
          __protected: true,
          __nodeType: "flow.function.input",
          pins,
        },
      },
      {
        id: `${member.id}-output`,
        type: "flow.function.output",
        position: { x: 420, y: 120 },
        data: {
          title: "Output",
          __protected: true,
          __nodeType: "flow.function.output",
          pins,
        },
      },
    ],
    edges: [],
  };
}

export function ensureEventNodeOnGraph(
  graph: SerializedGraph,
  eventType: string,
  extras?: { name?: string; title?: string; idFactory?: () => string },
): SerializedGraph {
  const existing = graph.nodes.find((node) => {
    if (node.type !== eventType) return false;
    if (eventType !== "flow.event.custom") return true;
    const named = node.data.name;
    return extras?.name ? named === extras.name : true;
  });
  if (existing) return graph;
  const id = nextId(extras?.idFactory);
  const title =
    extras?.title ??
    NATIVE_EVENT_TITLES[eventType] ??
    formatEventTitle(extras?.name ?? eventType);
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id,
        type: eventType,
        position: {
          x: 80,
          y: 80 + graph.nodes.length * 80,
        },
        data: {
          title,
          ...(extras?.name ? { name: extras.name } : {}),
          __nodeType: eventType,
        },
      },
    ],
  };
}

function syncEventPins(
  graph: SerializedGraph,
  member: GraphClassMember,
  pins: GraphClassMemberPin[],
): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const isEvent =
        node.type === "flow.event.custom" &&
        (node.id === member.id || node.data.name === member.name);
      const isCall =
        node.type === "flow.event.call" && node.data.name === member.name;
      if (!isEvent && !isCall) return node;
      const nextData: Record<string, unknown> = { ...node.data, pins };
      delete nextData.__pins;
      return { ...node, data: nextData };
    }),
  };
}

function syncFunctionGraphPins(
  graph: SerializedGraph,
  memberId: string,
  pins: GraphClassMemberPin[],
): SerializedGraph {
  const slice = graph.functionGraphs?.[memberId];
  const member = (graph.members ?? []).find((entry) => entry.id === memberId);
  const withCalls: SerializedGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (
        node.type !== "functions.call" ||
        node.data.functionName !== member?.name
      ) {
        return node;
      }
      const nextData: Record<string, unknown> = { ...node.data, pins };
      delete nextData.__pins;
      return { ...node, data: nextData };
    }),
  };
  if (!slice) return withCalls;
  return {
    ...withCalls,
    functionGraphs: {
      ...withCalls.functionGraphs,
      [memberId]: {
        ...slice,
        nodes: slice.nodes.map((node) => {
          if (
            node.type !== "flow.function.input" &&
            node.type !== "flow.function.output"
          ) {
            return node;
          }
          const nextData: Record<string, unknown> = { ...node.data, pins };
          delete nextData.__pins;
          return {
            ...node,
            data: nextData,
          };
        }),
      },
    },
  };
}

function isVariableAccessNode(
  node: SerializedGraph["nodes"][number],
  member: GraphClassMember,
  previous?: GraphClassMember,
): boolean {
  if (node.type !== "variables.get" && node.type !== "variables.set") {
    return false;
  }
  const variableId = node.data.variableId;
  if (typeof variableId === "string" && variableId) {
    return variableId === member.id;
  }
  const variableName = node.data.variableName;
  return (
    variableName === member.name ||
    (typeof previous?.name === "string" && variableName === previous.name)
  );
}

function patchVariableAccessNode(
  node: SerializedGraph["nodes"][number],
  member: GraphClassMember,
): SerializedGraph["nodes"][number] {
  const access = node.type === "variables.set" ? "Set" : "Get";
  const nextData: Record<string, unknown> = {
    ...node.data,
    variableId: member.id,
    variableName: member.name,
    typeId: member.typeId ?? node.data.typeId ?? "float",
    title: `${access} ${member.name}`,
    scope: member.functionId ? "local" : (node.data.scope ?? "member"),
  };
  if (member.functionId) nextData.functionId = member.functionId;
  delete nextData.__pins;
  return { ...node, data: nextData };
}

function mapGraphNodes(
  graph: SerializedGraph,
  mapNode: (
    node: SerializedGraph["nodes"][number],
  ) => SerializedGraph["nodes"][number],
): SerializedGraph {
  const functionGraphs = graph.functionGraphs
    ? Object.fromEntries(
        Object.entries(graph.functionGraphs).map(([id, slice]) => [
          id,
          { ...slice, nodes: slice.nodes.map(mapNode) },
        ]),
      )
    : graph.functionGraphs;
  return {
    ...graph,
    nodes: graph.nodes.map(mapNode),
    ...(functionGraphs ? { functionGraphs } : {}),
  };
}

function syncVariableAccessNodes(
  graph: SerializedGraph,
  member: GraphClassMember,
  previous?: GraphClassMember,
): SerializedGraph {
  return mapGraphNodes(graph, (node) =>
    isVariableAccessNode(node, member, previous)
      ? patchVariableAccessNode(node, member)
      : node,
  );
}

/** Spawn a bound Get/Set node onto the event graph or a function slice. */
export function addVariableAccessNode(
  graph: SerializedGraph,
  member: GraphClassMember,
  access: "get" | "set",
  options?: {
    functionId?: string | null;
    classId?: string;
    idFactory?: () => string;
  },
): SerializedGraph {
  const type = access === "set" ? "variables.set" : "variables.get";
  const title = `${access === "set" ? "Set" : "Get"} ${member.name}`;
  const data: Record<string, unknown> = {
    title,
    variableName: member.name,
    variableId: member.id,
    typeId: member.typeId ?? "float",
    scope: member.functionId ? "local" : "member",
    implicitSelf: true,
    __nodeType: type,
  };
  if (options?.classId) data.classId = options.classId;
  if (member.functionId) data.functionId = member.functionId;
  const node = {
    id: nextId(options?.idFactory),
    type,
    position: { x: 80, y: 80 },
    data,
  };
  const sliceId = options?.functionId;
  if (sliceId) {
    const slice = graph.functionGraphs?.[sliceId];
    if (!slice) return graph;
    return {
      ...graph,
      functionGraphs: {
        ...graph.functionGraphs,
        [sliceId]: {
          ...slice,
          nodes: [
            ...slice.nodes,
            {
              ...node,
              position: { x: 80, y: 80 + slice.nodes.length * 80 },
            },
          ],
        },
      },
    };
  }
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      { ...node, position: { x: 80, y: 80 + graph.nodes.length * 80 } },
    ],
  };
}

/** Append a named class member. Events insert a custom event node; functions seed a graph. */
export function addClassMember(
  graph: SerializedGraph,
  kind: GraphClassMemberKind,
  name: string,
  idFactory?: () => string,
  extras?: Partial<GraphClassMember>,
): SerializedGraph {
  const trimmed = name.trim();
  if (!trimmed) return graph;
  const displayName =
    kind === "event" ? formatEventMemberName(trimmed) : trimmed;
  if (!displayName) return graph;
  const member: GraphClassMember = {
    id: nextId(idFactory),
    kind,
    name: displayName,
    ...memberDefaults(kind, extras),
  };
  const members = [...(graph.members ?? []), member];
  if (kind === "event") {
    return {
      ...graph,
      members,
      nodes: [
        ...graph.nodes,
        {
          id: member.id,
          type: "flow.event.custom",
          position: {
            x: 80,
            y: 80 + graph.nodes.length * 80,
          },
          data: {
            title: formatEventTitle(trimmed),
            name: displayName,
            pins: member.pins ?? [],
            __nodeType: "flow.event.custom",
          },
        },
      ],
    };
  }
  if (kind === "function") {
    return {
      ...graph,
      members,
      functionGraphs: {
        ...graph.functionGraphs,
        [member.id]: seedFunctionGraph(member),
      },
    };
  }
  return { ...graph, members };
}

export function patchClassMember(
  graph: SerializedGraph,
  memberId: string,
  patch: Partial<GraphClassMember>,
): SerializedGraph {
  const previous = (graph.members ?? []).find((member) => member.id === memberId);
  const members = (graph.members ?? []).map((member) =>
    member.id === memberId ? { ...member, ...patch } : member,
  );
  const next = { ...graph, members };
  const declared = next.members?.find((member) => member.id === memberId);
  if (declared?.kind === "variable") {
    return syncVariableAccessNodes(next, declared, previous);
  }
  if (!patch.pins) return next;
  if (declared?.kind === "event") {
    return syncEventPins(next, declared, patch.pins);
  }
  return syncFunctionGraphPins(next, memberId, patch.pins);
}

export function removeClassMember(
  graph: SerializedGraph,
  memberId: string,
): SerializedGraph {
  const declared = (graph.members ?? []).find((member) => member.id === memberId);
  const members = (graph.members ?? []).filter((member) => {
    if (member.id === memberId) return false;
    if (declared?.kind === "function" && member.functionId === memberId) {
      return false;
    }
    return true;
  });
  if (declared?.kind === "function") {
    const functionGraphs = { ...graph.functionGraphs };
    delete functionGraphs[memberId];
    return { ...graph, members, functionGraphs };
  }
  if (declared?.kind === "event") {
    const dropIds = new Set(
      graph.nodes
        .filter((node) => {
          if (node.type === "flow.event.call") return false;
          if (!node.type.startsWith("flow.event.")) return false;
          const named = node.data.name;
          return named === declared.name || node.id === memberId;
        })
        .map((node) => node.id),
    );
    return {
      ...graph,
      members,
      nodes: graph.nodes.filter((node) => !dropIds.has(node.id)),
      edges: graph.edges.filter(
        (edge) => !dropIds.has(edge.source) && !dropIds.has(edge.target),
      ),
    };
  }
  if (declared) {
    return { ...graph, members };
  }
  const node = graph.nodes.find((entry) => entry.id === memberId);
  if (!node) return graph;
  return {
    ...graph,
    nodes: graph.nodes.filter((entry) => entry.id !== memberId),
    edges: graph.edges.filter(
      (edge) => edge.source !== memberId && edge.target !== memberId,
    ),
  };
}
