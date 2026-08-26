import {
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
  "flow.event.destroyed",
] as const;

export const NATIVE_GAME_INSTANCE_EVENT_TYPES = [
  "flow.event.init",
  "flow.event.tick",
  "flow.event.end",
  "flow.event.firstSceneLoaded",
  "flow.event.sceneStartLoading",
  "flow.event.sceneFinishLoading",
  "flow.event.sceneExit",
] as const;

/** Default new graphs seed these Actor natives; Destroyed stays in Events +. */
export const SEEDED_NATIVE_EVENT_TYPES = [
  "flow.event.beginPlay",
  "flow.event.tick",
  "flow.event.init",
] as const;

export const COLLISION_EVENT_TYPE_IDS = [
  "flow.event.hit",
  "flow.event.beginOverlap",
  "flow.event.endOverlap",
] as const;

const NATIVE_EVENT_TITLES: Record<string, string> = {
  "flow.event.beginPlay": "Event Begin Play",
  "flow.event.tick": "Event Tick",
  "flow.event.destroyed": "Event On Actor Destroyed",
  "flow.event.init": "Event On Init",
  "flow.event.end": "Event On End",
  "flow.event.firstSceneLoaded": "Event On First Scene Loaded",
  "flow.event.sceneStartLoading": "Event On Scene Start Loading",
  "flow.event.sceneFinishLoading": "Event On Scene Finish Loading",
  "flow.event.sceneExit": "Event On Scene Exit",
  "flow.event.hit": "Event On Hit",
  "flow.event.beginOverlap": "Event On Begin Overlap",
  "flow.event.endOverlap": "Event On End Overlap",
  "flow.event.onMouseEnter": "Event On Mouse Enter",
  "flow.event.onMouseLeave": "Event On Mouse Leave",
  "flow.event.onClick": "Event On Click",
  "flow.event.onPressStart": "Event On Press Start",
  "flow.event.onPressEnd": "Event On Press End",
  "flow.event.textChanged": "Event On Text Changed",
  "flow.event.audioFinished": "Event On Audio Finished",
  "flow.event.commandRun": "Event On Command Run",
  "flow.event.editorBeginPlay": "Event Editor On Begin Play",
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

const EDITOR_BEGIN_PLAY_EVENT = "flow.event.editorBeginPlay";

export function nativeEventTitle(eventType: string): string {
  return NATIVE_EVENT_TITLES[eventType] ?? formatEventTitle(eventType);
}

export const OVERLAY_MOUSE_EVENT_TYPE_IDS = [
  "flow.event.onMouseEnter",
  "flow.event.onMouseLeave",
  "flow.event.onClick",
  "flow.event.onPressStart",
  "flow.event.onPressEnd",
] as const;

const ACTOR_EVENT_TYPE_IDS = [
  "flow.event.beginPlay",
  "flow.event.tick",
  "flow.event.destroyed",
  "flow.event.commandRun",
  "flow.event.hit",
  "flow.event.beginOverlap",
  "flow.event.endOverlap",
  "flow.event.textChanged",
  "flow.event.audioFinished",
  ...OVERLAY_MOUSE_EVENT_TYPE_IDS,
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
  /** Parent Class graphs keyed by class id (for inherited custom events). */
  parentGraphs?: Record<string, SerializedGraph>;
  assetType?: string | null;
  editorGraph?: boolean;
  /** Animation Object event graph vs nested transition-rule graph. */
  animationGraphHost?: "object" | "rule";
};

export type ClassBlueprintMemberKind = GraphClassMemberKind;

export type BlueprintSection = {
  id: string;
  label: string;
  kind: ClassBlueprintMemberKind;
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
  if (options?.activeFunctionId) {
    if (isFunctionLibraryHost(options)) {
      sections.push(LOCAL_VARIABLES_SECTION);
    } else {
      const variableIndex = sections.findIndex(
        (section) => section.id === "variables",
      );
      sections.splice(variableIndex + 1, 0, LOCAL_VARIABLES_SECTION);
    }
  }
  return sections;
}

export function classAllowsMemberKind(
  kind: ClassBlueprintMemberKind,
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
    return eventStubsForTypes([
      EDITOR_BEGIN_PLAY_EVENT,
      ...EDITOR_UTILITY_EVENT_TYPES,
    ]);
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
  const types: string[] = [];
  if (chain.includes("Actor")) {
    types.push(...NATIVE_CLASS_EVENT_TYPES);
  }
  if (chain.includes("GameInstance")) {
    types.push(...NATIVE_GAME_INSTANCE_EVENT_TYPES);
  }
  if (chain.includes("BDebugCommand")) {
    types.push("flow.event.commandRun");
  }
  return eventStubsForTypes(types);
}

/** Whether a script catalog node is legal on a Class graph for this parent. */
function isAnimCatalogNode(nodeId: string): boolean {
  return nodeId.startsWith("anim.");
}

function isAnimCatalogNodeAllowed(
  nodeId: string,
  host: ClassEventOptions["animationGraphHost"],
  options?: ClassEventOptions,
): boolean {
  if (host === "object") {
    return nodeId.startsWith("anim.event.");
  }
  if (host === "rule") {
    return nodeId.startsWith("anim.state.");
  }
  if (nodeId.startsWith("anim.actor.")) {
    return ancestryChain(options).includes("Actor");
  }
  return false;
}

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
  if (nodeId === "flow.event.callParent") {
    return false;
  }
  if (nodeId === "interface.call") {
    return false;
  }
  if (
    nodeId === "variables.get" ||
    nodeId === "variables.set" ||
    nodeId === "variables.getValidated"
  ) {
    return false;
  }
  if (nodeId === "component.getNamed") {
    return false;
  }
  if (nodeId === "casting.cast" || nodeId === "casting.castActor") {
    return false;
  }
  if (nodeId === "struct.make" || nodeId === "struct.break") {
    return false;
  }
  if (isAnimCatalogNode(nodeId)) {
    return isAnimCatalogNodeAllowed(
      nodeId,
      options?.animationGraphHost,
      options,
    );
  }
  const isEditorEvent = (EDITOR_UTILITY_EVENT_TYPES as readonly string[]).includes(
    nodeId,
  );
  const isEditorBeginPlay = nodeId === EDITOR_BEGIN_PLAY_EVENT;
  if (isEditorBeginPlay) {
    return ancestryChain(options).includes("EditorUtilityObject");
  }
  if (
    isEditorEvent &&
    !ancestryChain(options).includes("EditorUtilityObject")
  ) {
    return false;
  }
  const chain = ancestryChain(options);
  const isActorEvent = (ACTOR_EVENT_TYPE_IDS as readonly string[]).includes(nodeId);
  const isGiOnlyEvent = (
    NATIVE_GAME_INSTANCE_EVENT_TYPES as readonly string[]
  ).includes(nodeId) && nodeId !== "flow.event.tick";
  const isGiFunction =
    nodeId === "gameInstance.getSceneLoadingProgress" ||
    nodeId === "gameInstance.getSceneReference";
  if (isGiOnlyEvent || isGiFunction) {
    return chain.includes("GameInstance");
  }
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
  if (options?.animationGraphHost) {
    return (
      !isActorEvent &&
      !isEditorEvent &&
      !isBtLeafEvent &&
      !isFinish &&
      !isReturn &&
      !isBlackboard
    );
  }
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
  if ((COLLISION_EVENT_TYPE_IDS as readonly string[]).includes(nodeId)) {
    return chain.includes("Actor");
  }
  if ((OVERLAY_MOUSE_EVENT_TYPE_IDS as readonly string[]).includes(nodeId)) {
    return chain.includes("SceneLayerActor");
  }
  if (
    nodeId === "flow.event.beginPlay" ||
    nodeId === "flow.event.destroyed"
  ) {
    return chain.includes("Actor");
  }
  if (nodeId === "flow.event.tick") {
    return chain.includes("Actor") || chain.includes("GameInstance");
  }
  if (nodeId === "flow.event.commandRun") {
    return chain.includes("Actor") || chain.includes("BDebugCommand");
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
      ...(extras?.typeClassId ? { typeClassId: extras.typeClassId } : {}),
      ...(extras?.container === "array" || extras?.container === "map"
        ? { container: extras.container }
        : {}),
      ...(extras?.keyTypeId ? { keyTypeId: extras.keyTypeId } : {}),
      ...(extras?.keyTypeClassId ? { keyTypeClassId: extras.keyTypeClassId } : {}),
      ...(extras?.defaultValue !== undefined
        ? { defaultValue: extras.defaultValue }
        : {}),
      ...(extras?.functionId ? { functionId: extras.functionId } : {}),
    };
  }
  if (kind === "function") {
    const next: Partial<GraphClassMember> = {
      pins: extras?.pins ?? DEFAULT_FUNCTION_PINS,
    };
    if (extras?.overridable === true) next.overridable = true;
    if (extras?.implementsInterface) {
      next.implementsInterface = extras.implementsInterface;
    }
    if (extras?.overrides) next.overrides = extras.overrides;
    return next;
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
    edges: [
      {
        id: `e:${member.id}-input:exec:${member.id}-output:then`,
        source: `${member.id}-input`,
        target: `${member.id}-output`,
        sourceHandle: "exec",
        targetHandle: "then",
      },
    ],
  };
}

function nodeComponentId(
  node: SerializedGraph["nodes"][number],
): string {
  return typeof node.data.componentId === "string" ? node.data.componentId : "";
}

export function ensureEventNodeOnGraph(
  graph: SerializedGraph,
  eventType: string,
  extras?: {
    name?: string;
    title?: string;
    idFactory?: () => string;
    parentClassId?: string | null;
    pins?: GraphClassMemberPin[];
    componentId?: string;
    eventQualifier?: string;
  },
): SerializedGraph {
  const wantedComponentId = extras?.componentId ?? "";
  const existing = graph.nodes.find((node) => {
    if (node.type !== eventType) return false;
    if (nodeComponentId(node) !== wantedComponentId) return false;
    if (eventType !== "flow.event.custom") return true;
    const named = node.data.name;
    return extras?.name ? named === extras.name : true;
  });
  let next = graph;
  let eventId = existing?.id;
  if (!existing) {
    const id = nextId(extras?.idFactory);
    eventId = id;
    const title = formatEventTitle(
      extras?.title ??
        extras?.name ??
        NATIVE_EVENT_TITLES[eventType] ??
        eventType,
      extras?.eventQualifier,
    );
    const pins = extras?.pins;
    next = {
      ...next,
      nodes: [
        ...next.nodes,
        {
          id,
          type: eventType,
          position: {
            x: 80,
            y: 80 + next.nodes.length * 80,
          },
          data: {
            title,
            ...(extras?.name ? { name: extras.name } : {}),
            ...(pins ? { pins } : {}),
            ...(wantedComponentId ? { componentId: wantedComponentId } : {}),
            ...(extras?.eventQualifier
              ? { eventQualifier: extras.eventQualifier }
              : {}),
            __nodeType: eventType,
          },
        },
      ],
    };
  }
  const parentClassId = extras?.parentClassId?.trim();
  if (!eventId || !parentClassId) return next;
  return ensureCallParentForEvent(next, {
    eventNodeId: eventId,
    eventType,
    eventName: extras?.name,
    parentClassId,
    pins: extras?.pins ?? eventDataPinsFromNode(next, eventId),
    idFactory: extras?.idFactory,
  });
}

/** Data output pins stored on an event node (custom Outputs or catalog). */
export function eventDataPinsFromNode(
  graph: SerializedGraph,
  eventNodeId: string,
): GraphClassMemberPin[] {
  const node = graph.nodes.find((entry) => entry.id === eventNodeId);
  if (!node) return [];
  if (Array.isArray(node.data.pins)) {
    return (node.data.pins as GraphClassMemberPin[]).filter(
      (pin) => pin.direction !== "in" && pin.typeId !== "exec",
    );
  }
  return [];
}

export function callParentNodeId(
  eventType: string,
  eventName?: string,
): string {
  if (eventType === "flow.event.custom") {
    const slug = formatEventMemberName(eventName ?? "Custom")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `call-parent-custom-${slug || "event"}`;
  }
  return `call-parent-${eventType.replace(/\./g, "-")}`;
}

export function callParentDisplayTitle(
  eventType: string,
  eventName?: string,
): string {
  if (eventType === "flow.event.custom") {
    const body = formatEventMemberName(eventName ?? "Event");
    return `Call ${body || "Event"} Parent`;
  }
  const titled = NATIVE_EVENT_TITLES[eventType];
  const body = titled
    ? formatEventMemberName(titled)
    : formatEventMemberName(
        eventType.startsWith("flow.event.")
          ? eventType.slice("flow.event.".length)
          : eventType,
      );
  return `Call ${body || "Event"} Parent`;
}

/**
 * Insert Call Parent for an event if missing, and default-wire Event → Call Parent
 * when neither side already has conflicting exec/data edges for those pins.
 */
export function ensureCallParentForEvent(
  graph: SerializedGraph,
  options: {
    eventNodeId: string;
    eventType: string;
    eventName?: string;
    parentClassId: string;
    pins?: GraphClassMemberPin[];
    idFactory?: () => string;
  },
): SerializedGraph {
  const parentClassId = options.parentClassId.trim();
  if (!parentClassId) return graph;
  const eventNode = graph.nodes.find((node) => node.id === options.eventNodeId);
  if (!eventNode) return graph;

  const callId = callParentNodeId(options.eventType, options.eventName);
  const existingCall = graph.nodes.find(
    (node) =>
      node.id === callId ||
      (node.type === "flow.event.callParent" &&
        node.data.eventType === options.eventType &&
        (options.eventType !== "flow.event.custom" ||
          formatEventMemberName(String(node.data.eventName ?? "")) ===
            formatEventMemberName(options.eventName ?? ""))),
  );
  const pins = (options.pins ?? eventDataPinsFromNode(graph, options.eventNodeId)).filter(
    (pin) => pin.typeId !== "exec" && pin.direction !== "in",
  );
  let next = graph;
  if (!existingCall) {
    next = {
      ...next,
      nodes: [
        ...next.nodes,
        {
          id: callId,
          type: "flow.event.callParent",
          position: {
            x: eventNode.position.x + 280,
            y: eventNode.position.y,
          },
          data: {
            title: callParentDisplayTitle(options.eventType, options.eventName),
            eventType: options.eventType,
            eventName:
              options.eventType === "flow.event.custom"
                ? formatEventMemberName(options.eventName ?? "Event")
                : formatEventMemberName(
                    NATIVE_EVENT_TITLES[options.eventType] ?? options.eventType,
                  ),
            name:
              options.eventType === "flow.event.custom"
                ? formatEventMemberName(options.eventName ?? "Event")
                : undefined,
            parentClassId,
            pins,
            __nodeType: "flow.event.callParent",
          },
        },
      ],
    };
  }
  const callNodeId = existingCall?.id ?? callId;
  const edges = [...(next.edges ?? [])];
  const hasExecOut = edges.some(
    (edge) =>
      edge.source === options.eventNodeId &&
      (edge.sourceHandle === "execOut" || edge.sourceHandle === "then"),
  );
  const hasExecIn = edges.some(
    (edge) =>
      edge.target === callNodeId &&
      (edge.targetHandle === "execIn" || edge.targetHandle === "exec"),
  );
  if (!hasExecOut && !hasExecIn) {
    edges.push({
      id: `e:${options.eventNodeId}:execOut:${callNodeId}:execIn`,
      source: options.eventNodeId,
      target: callNodeId,
      sourceHandle: "execOut",
      targetHandle: "execIn",
    });
  }
  for (const pin of pins) {
    if (!pin.name) continue;
    const hasDataOut = edges.some(
      (edge) =>
        edge.source === options.eventNodeId && edge.sourceHandle === pin.name,
    );
    const hasDataIn = edges.some(
      (edge) => edge.target === callNodeId && edge.targetHandle === pin.name,
    );
    if (hasDataOut || hasDataIn) continue;
    edges.push({
      id: `e:${options.eventNodeId}:${pin.name}:${callNodeId}:${pin.name}`,
      source: options.eventNodeId,
      target: callNodeId,
      sourceHandle: pin.name,
      targetHandle: pin.name,
    });
  }
  return { ...next, edges };
}

/** Inherited custom events from parent graphs (ancestor-first). */
export function inheritedCustomEventSeeds(
  options?: ClassEventOptions,
): Array<{ name: string; pins: GraphClassMemberPin[] }> {
  if (!options?.parentGraphs) return [];
  const parentOf =
    options.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const chain: string[] = [];
  let current = options.parentClass ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf(current) ?? null;
  }
  const rows: Array<{ name: string; pins: GraphClassMemberPin[] }> = [];
  const seenNames = new Set<string>();
  for (const className of chain) {
    const parentGraph = options.parentGraphs[className];
    if (!parentGraph) continue;
    for (const member of parentGraph.members ?? []) {
      if (member.kind !== "event") continue;
      const name = formatEventMemberName(member.name);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      rows.push({
        name,
        pins: (member.pins ?? []).filter(
          (pin) => pin.typeId !== "exec" && pin.direction !== "in",
        ),
      });
    }
    for (const node of parentGraph.nodes) {
      if (node.type !== "flow.event.custom") continue;
      const raw =
        typeof node.data.name === "string"
          ? node.data.name
          : typeof node.data.title === "string"
            ? node.data.title
            : "";
      const name = formatEventMemberName(raw);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      const pins = Array.isArray(node.data.pins)
        ? (node.data.pins as GraphClassMemberPin[]).filter(
            (pin) => pin.typeId !== "exec" && pin.direction !== "in",
          )
        : [];
      rows.push({ name, pins });
    }
  }
  return rows;
}

function syncEventPins(
  graph: SerializedGraph,
  member: GraphClassMember,
  pins: GraphClassMemberPin[],
): SerializedGraph {
  const memberName = formatEventMemberName(member.name);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const nodeName =
        typeof node.data.name === "string"
          ? formatEventMemberName(node.data.name)
          : typeof node.data.eventName === "string"
            ? formatEventMemberName(node.data.eventName)
            : "";
      const isEvent =
        node.type === "flow.event.custom" &&
        (node.id === member.id || nodeName === memberName);
      const isCall =
        node.type === "flow.event.call" && nodeName === memberName;
      const isCallParent =
        node.type === "flow.event.callParent" &&
        (node.data.eventType === "flow.event.custom" ||
          !node.data.eventType) &&
        nodeName === memberName;
      if (!isEvent && !isCall && !isCallParent) return node;
      const nextData: Record<string, unknown> = { ...node.data, pins };
      if (isCall) {
        nextData.name = memberName;
        nextData.title = `Call ${memberName}`;
      }
      if (isCallParent) {
        nextData.eventName = memberName;
        nextData.name = memberName;
        nextData.title = `Call ${memberName} Parent`;
      }
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
  if (
    node.type !== "variables.get" &&
    node.type !== "variables.set" &&
    node.type !== "variables.getValidated"
  ) {
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

function stampVariableTypeOnData(
  data: Record<string, unknown>,
  member: Pick<
    GraphClassMember,
    "typeId" | "typeClassId" | "container" | "keyTypeId" | "keyTypeClassId"
  >,
): void {
  data.typeId = member.typeId ?? "float";
  if (member.typeClassId) data.typeClassId = member.typeClassId;
  else delete data.typeClassId;
  if (member.container === "array" || member.container === "map") {
    data.container = member.container;
  } else {
    delete data.container;
  }
  if (member.container === "map") {
    data.keyTypeId = member.keyTypeId ?? "string";
    if (member.keyTypeClassId) data.keyTypeClassId = member.keyTypeClassId;
    else delete data.keyTypeClassId;
  } else {
    delete data.keyTypeId;
    delete data.keyTypeClassId;
  }
}

function patchVariableAccessNode(
  node: SerializedGraph["nodes"][number],
  member: GraphClassMember,
): SerializedGraph["nodes"][number] {
  const access =
    node.type === "variables.set"
      ? "Set"
      : node.type === "variables.getValidated"
        ? "Validated Get"
        : "Get";
  const nextData: Record<string, unknown> = {
    ...node.data,
    variableId: member.id,
    variableName: member.name,
    title: `${access} ${member.name}`,
    scope: member.functionId ? "local" : (node.data.scope ?? "member"),
  };
  stampVariableTypeOnData(nextData, member);
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

export function syncVariableAccessNodes(
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

export type VariableAccessKind = "get" | "set" | "validatedGet";

export function isObjectInstanceVariableType(
  typeId: string | undefined,
  container?: string | null,
): boolean {
  if (container === "array" || container === "map") return false;
  return typeId === "object" || typeId === "actor";
}

export type GraphSpawnOptions = {
  position?: { x: number; y: number };
  functionId?: string | null;
  classId?: string;
  implicitSelf?: boolean;
  idFactory?: () => string;
};

function sliceNodeCount(
  graph: SerializedGraph,
  functionId?: string | null,
): number {
  if (functionId) return graph.functionGraphs?.[functionId]?.nodes.length ?? 0;
  return graph.nodes.length;
}

function spawnPosition(
  graph: SerializedGraph,
  options?: GraphSpawnOptions,
): { x: number; y: number } {
  if (options?.position) return options.position;
  return { x: 80, y: 80 + sliceNodeCount(graph, options?.functionId) * 80 };
}

function appendGraphNode(
  graph: SerializedGraph,
  node: {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  },
  functionId?: string | null,
): SerializedGraph {
  if (functionId) {
    const slice = graph.functionGraphs?.[functionId];
    if (!slice) return graph;
    return {
      ...graph,
      functionGraphs: {
        ...graph.functionGraphs,
        [functionId]: { ...slice, nodes: [...slice.nodes, node] },
      },
    };
  }
  return { ...graph, nodes: [...graph.nodes, node] };
}

/** Spawn a bound Get/Set/Validated Get node onto the event graph or a function slice. */
export function addVariableAccessNode(
  graph: SerializedGraph,
  member: GraphClassMember,
  access: VariableAccessKind,
  options?: GraphSpawnOptions,
): SerializedGraph {
  const type =
    access === "set"
      ? "variables.set"
      : access === "validatedGet"
        ? "variables.getValidated"
        : "variables.get";
  const title =
    access === "set"
      ? `Set ${member.name}`
      : access === "validatedGet"
        ? `Validated Get ${member.name}`
        : `Get ${member.name}`;
  const data: Record<string, unknown> = {
    title,
    variableName: member.name,
    variableId: member.id,
    scope: member.functionId ? "local" : "member",
    implicitSelf: options?.implicitSelf ?? true,
    __nodeType: type,
  };
  stampVariableTypeOnData(data, member);
  if (options?.classId) data.classId = options.classId;
  if (member.functionId) data.functionId = member.functionId;
  if (member.componentId) data.componentId = member.componentId;
  if (member.propertyKey) data.propertyKey = member.propertyKey;
  return appendGraphNode(
    graph,
    {
      id: nextId(options?.idFactory),
      type,
      position: spawnPosition(graph, options),
      data,
    },
    options?.functionId,
  );
}

/** Spawn a Call Custom Event node bound to a class event. */
export function addCallEventNode(
  graph: SerializedGraph,
  member: Pick<GraphClassMember, "name" | "pins">,
  options?: GraphSpawnOptions,
): SerializedGraph {
  const type = "flow.event.call";
  const bodyName = formatEventMemberName(member.name);
  const data: Record<string, unknown> = {
    title: `Call ${bodyName}`,
    name: bodyName,
    implicitSelf: options?.implicitSelf ?? true,
    pins: member.pins ?? [],
    __nodeType: type,
  };
  if (options?.classId) data.classId = options.classId;
  return appendGraphNode(
    graph,
    {
      id: nextId(options?.idFactory),
      type,
      position: spawnPosition(graph, options),
      data,
    },
    options?.functionId,
  );
}

/** Spawn a Call Function node bound to a class function. */
export function addCallFunctionNode(
  graph: SerializedGraph,
  member: Pick<GraphClassMember, "name" | "pins" | "runtime">,
  options?: GraphSpawnOptions,
): SerializedGraph {
  const type = "functions.call";
  const data: Record<string, unknown> = {
    title: `Call ${member.name}`,
    functionName: member.name,
    implicitSelf: options?.implicitSelf ?? true,
    pins: member.pins ?? [],
    __nodeType: type,
  };
  if (options?.classId) data.classId = options.classId;
  if (member.runtime) data.runtime = member.runtime;
  return appendGraphNode(
    graph,
    {
      id: nextId(options?.idFactory),
      type,
      position: spawnPosition(graph, options),
      data,
    },
    options?.functionId,
  );
}

export type ClassMemberDropKind = ClassBlueprintMemberKind;

export type ClassMemberDropRow = {
  id: string;
  kind: ClassMemberDropKind;
  name: string;
  eventType?: string;
  inherited?: boolean;
  inheritedFrom?: string;
  pins?: GraphClassMemberPin[];
};

export type GraphDropPoint = {
  containsClientPoint(clientX: number, clientY: number): boolean;
  clientToFlow(clientX: number, clientY: number): { x: number; y: number };
};

export type ClassMemberDropResult =
  | { kind: "ignore" }
  | {
      kind: "choose-access";
      memberId: string;
      position: { x: number; y: number };
    }
  | { kind: "spawn"; graph: SerializedGraph };

/** Decide Get/Set vs Call spawn when a Class tree row is dropped on the graph. */
export function resolveClassMemberDrop(options: {
  graph: SerializedGraph;
  memberId: string;
  members: readonly ClassMemberDropRow[];
  clientX: number;
  clientY: number;
  canvas: GraphDropPoint | null;
  functionId?: string | null;
  classId?: string;
  idFactory?: () => string;
}): ClassMemberDropResult {
  if (options.memberId.startsWith("section-")) return { kind: "ignore" };
  if (
    !options.canvas?.containsClientPoint(options.clientX, options.clientY)
  ) {
    return { kind: "ignore" };
  }
  const row = options.members.find((entry) => entry.id === options.memberId);
  if (!row) return { kind: "ignore" };
  const declared =
    options.graph.members?.find((entry) => entry.id === options.memberId) ??
    options.graph.members?.find(
      (entry) => entry.kind === row.kind && entry.name === row.name,
    );
  const position = options.canvas.clientToFlow(
    options.clientX,
    options.clientY,
  );
  const spawn: GraphSpawnOptions = {
    position,
    functionId: options.functionId,
    classId: row.inheritedFrom ?? options.classId,
    idFactory: options.idFactory,
  };
  if (row.kind === "variable") {
    return { kind: "choose-access", memberId: options.memberId, position };
  }
  if (row.kind === "function") {
    return {
      kind: "spawn",
      graph: addCallFunctionNode(options.graph, declared ?? row, spawn),
    };
  }
  if (row.kind === "event" && row.eventType === "flow.event.custom") {
    return {
      kind: "spawn",
      graph: addCallEventNode(options.graph, declared ?? row, spawn),
    };
  }
  return { kind: "ignore" };
}

/** Append a named class member. Events insert a custom event node; functions seed a graph. */
export function addClassMember(
  graph: SerializedGraph,
  kind: GraphClassMemberKind,
  name: string,
  idFactory?: () => string,
  extras?: Partial<GraphClassMember>,
  options?: { reservedNames?: readonly string[] },
): SerializedGraph {
  const trimmed = name.trim();
  if (!trimmed) return graph;
  const displayName =
    kind === "event" ? formatEventMemberName(trimmed) : trimmed;
  if (!displayName) return graph;
  if (
    kind === "variable" &&
    options?.reservedNames?.some((reserved) => reserved === displayName)
  ) {
    return graph;
  }
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
  const members = (graph.members ?? []).map((member) => {
    if (member.id !== memberId) return member;
    const next = { ...member, ...patch };
    if ("overridable" in patch && patch.overridable !== true) {
      delete next.overridable;
    }
    return next;
  });
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

export function pruneEventMembersToNodes(
  graph: SerializedGraph,
): SerializedGraph {
  const members = graph.members;
  if (!members?.length) return graph;
  const customNames = new Set<string>();
  const customIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "flow.event.custom") continue;
    customIds.add(node.id);
    const raw =
      typeof node.data.name === "string"
        ? node.data.name
        : typeof node.data.title === "string"
          ? node.data.title
          : "";
    const name = formatEventMemberName(raw);
    if (name) customNames.add(name);
  }
  const nextMembers = members.filter((member) => {
    if (member.kind !== "event") return true;
    const name = formatEventMemberName(member.name);
    return customIds.has(member.id) || (name.length > 0 && customNames.has(name));
  });
  if (nextMembers.length === members.length) return graph;
  return { ...graph, members: nextMembers };
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
