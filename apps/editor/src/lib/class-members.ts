import {
  normalizeClassMemberCategory,
  type GraphClassMember,
  type GraphClassMemberKind,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@haptic/core";
import {
  engineParentOf,
  formatEventMemberName,
  formatEventTitle,
  walkAncestry,
} from "@haptic/editor-kit";
import {
  dispatcherEventPins,
  dispatcherNodeData,
  dropGraphNodes,
  isOwnFunctionCall,
  isVariableAccessNode,
  mapGraphNodes,
  nextId,
  syncVariableAccessNodes,
} from "./class-member-nodes";
import {
  DISPATCHER_NODE_TYPE_IDS,
  OUTPUT_DELEGATE_PIN_ID,
  type DispatcherNodeAction,
} from "@haptic/scripting-nodes";
import { delegateSignatureSource } from "@haptic/scripting";
import { signatureOfPins } from "./delegate-signatures";

export {
  COLLISION_EVENT_TYPE_IDS,
  GET_GAME_INSTANCE_NODE_ID,
  LINEAGE_NATIVE_EVENT_TYPES,
  NATIVE_CLASS_EVENT_TYPES,
  OVERLAY_MOUSE_EVENT_TYPE_IDS,
  isEditorUtilityChain,
  isLineageNativeEventAllowed,
  isScriptCatalogNodeAllowed,
  lineageNativeEventBases,
  lineageNativeEventTypes,
  nativeEventStubs,
  nativeEventTitle,
  nativeStubId,
  seededNativeEventTypes,
  type ClassEventOptions,
} from "./class-event-catalog";
export {
  NEW_MEMBER_NAMES,
  blueprintSectionsForClass,
  classAllowsMemberKind,
  functionLibraryShowsEventGraphEmpty,
  memberNamePromptCopy,
  nextNewMemberName,
  variableFieldsForPickerType,
  type BlueprintSection,
  type ClassBlueprintMemberKind,
} from "./class-member-sections";
export {
  addCallEventNode,
  addCallFunctionNode,
  addDispatcherNodes,
  createEventNodeData,
  dispatcherEventNodeData,
  dispatcherEventPins,
  dispatcherNodeData,
  freeDispatcherEventName,
  type DispatcherDropAction,
  addVariableAccessNode,
  isObjectInstanceVariableType,
  patchVariableAccessNode,
  syncVariableAccessNodes,
  type GraphSpawnOptions,
  type VariableAccessKind,
} from "./class-member-nodes";
export {
  callParentDisplayTitle,
  callParentNodeId,
  ensureCallParentForEvent,
  ensureEventNodeOnGraph,
  eventDataPinsFromNode,
  inheritedCustomEventSeeds,
} from "./class-event-nodes";
export {
  canDropClassMember,
  completeClassMemberDrop,
  droppedRowsNotice,
  dropVariableBinding,
  joinNames,
  placeClassMemberDrop,
  resolveClassMemberDrop,
  variableAccessAllowed,
  type ClassMemberDropKind,
  type ClassMemberDropResult,
  type ClassMemberDropRow,
  type GraphDropPoint,
} from "./class-member-drop";

export type { GraphClassMember, GraphClassMemberKind, GraphClassMemberPin };

export const DEFAULT_FUNCTION_PINS: GraphClassMemberPin[] = [
  { name: "exec", typeId: "exec", direction: "in" },
  { name: "then", typeId: "exec", direction: "out" },
];

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
  if (kind === "event" || kind === "dispatcher") {
    return { pins: extras?.pins ?? [] };
  }
  return {};
}

export function seedFunctionGraph(
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

function syncEventPins(
  graph: SerializedGraph,
  member: GraphClassMember,
  pins: GraphClassMemberPin[],
): SerializedGraph {
  const memberName = formatEventMemberName(member.name);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      // Call Parent names its event in `eventName`; the event and Call Custom
      // Event use `name`.
      const rawName =
        node.type === "flow.event.callParent" ? node.data.eventName : node.data.name;
      const nodeName =
        typeof rawName === "string" ? formatEventMemberName(rawName) : "";
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
  classId: string | undefined,
): SerializedGraph {
  const member = (graph.members ?? []).find((entry) => entry.id === memberId);
  const syncCalls = (nodes: SerializedGraph["nodes"]) =>
    nodes.map((node) => {
      if (!member || !isOwnFunctionCall(node, member.name, classId)) {
        return node;
      }
      const nextData: Record<string, unknown> = { ...node.data, pins };
      delete nextData.__pins;
      return { ...node, data: nextData };
    });
  // Calls live in the Event Graph and in other functions (or recursively).
  const functionGraphs = graph.functionGraphs
    ? Object.fromEntries(
        Object.entries(graph.functionGraphs).map(([id, entry]) => [
          id,
          { ...entry, nodes: syncCalls(entry.nodes) },
        ]),
      )
    : undefined;
  const withCalls: SerializedGraph = {
    ...graph,
    nodes: syncCalls(graph.nodes),
    ...(functionGraphs ? { functionGraphs } : {}),
  };
  const slice = withCalls.functionGraphs?.[memberId];
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

/** The open Class and its ancestry, so member edits can tell its own Call Function nodes from others. */
export type ClassMemberEditContext = {
  /** This document's class id; Call Function nodes stamped with it, or with none, are its own. */
  classId?: string;
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  /** Class graphs keyed by class id, used to find a parent that declares a function. */
  parentGraphs?: Record<string, SerializedGraph>;
};

/** The nearest parent Class that declares a function named like `member`. */
function inheritedFunctionClassId(
  member: GraphClassMember,
  context: ClassMemberEditContext | undefined,
): string | undefined {
  const parentOf = context?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const parentClass =
    context?.parentClass ?? (context?.classId ? parentOf(context.classId) : null);
  for (const ancestor of walkAncestry(parentClass, parentOf)) {
    const declares = context?.parentGraphs?.[ancestor]?.members?.some(
      (entry) => entry.kind === "function" && entry.name === member.name,
    );
    if (declares) return ancestor;
  }
  return member.overrides?.name === member.name ? member.overrides.classId : undefined;
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

/** Only locally declared events own their names; overrides keep their binding. */
export function canRenameCustomEvent(
  graph: SerializedGraph,
  nodeId: string,
): boolean {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  return Boolean(
    node?.type === "flow.event.custom" &&
      !node.data.componentId &&
      !node.data.eventQualifier &&
      !String(node.data.title ?? "").endsWith("(Inherited)") &&
      !graph.edges.some((edge) =>
        edge.source === nodeId && graph.nodes.some(
          (entry) => entry.id === edge.target && entry.type === "flow.event.callParent",
        ),
      ),
  );
}

export function customEventRenameError(
  graph: SerializedGraph,
  nodeId: string,
  name: string,
): string | null {
  if (!canRenameCustomEvent(graph, nodeId)) {
    return "This Event Name Is Defined By Its Parent Or Component.";
  }
  const formatted = formatEventMemberName(name);
  if (!formatted) return "Enter An Event Name.";
  if (graph.nodes.some((node) =>
    node.id !== nodeId &&
    node.type === "flow.event.custom" &&
    formatEventMemberName(String(node.data.name ?? node.data.title ?? ""))
      .toLowerCase() === formatted.toLowerCase(),
  )) {
    return "An Event With This Name Already Exists.";
  }
  return null;
}

/** Rename a declaration and calls in this document as one undoable graph edit. */
export function renameCustomEvent(
  graph: SerializedGraph,
  nodeId: string,
  name: string,
  classId?: string,
): SerializedGraph {
  if (customEventRenameError(graph, nodeId, name)) return graph;
  const event = graph.nodes.find((node) => node.id === nodeId)!;
  const previousName = formatEventMemberName(
    String(event.data.name ?? event.data.title ?? ""),
  );
  const nextName = formatEventMemberName(name);
  if (previousName === nextName) return graph;
  const next = mapGraphNodes(graph, (node) => {
    const isEvent = node === event;
    const isCall =
      node.type === "flow.event.call" &&
      formatEventMemberName(String(node.data.name ?? "")) === previousName &&
      !node.data.componentId &&
      (node.data.implicitSelf === true ||
        !node.data.classId || node.data.classId === classId);
    if (!isEvent && !isCall) return node;
    return {
      ...node,
      data: {
        ...node.data,
        name: nextName,
        title: isEvent ? formatEventTitle(nextName) : `Call ${nextName}`,
      },
    };
  });
  return {
    ...next,
    ...(graph.members ? {
      members: graph.members.map((member) =>
        member.kind === "event" &&
        (member.id === nodeId || formatEventMemberName(member.name) === previousName)
          ? { ...member, name: nextName }
          : member,
      ),
    } : {}),
  };
}

/** Retarget this Class's own Call Function nodes, in every graph, to a renamed function. */
function renameFunctionCalls(
  graph: SerializedGraph,
  previousName: string,
  nextName: string,
  classId: string | undefined,
): SerializedGraph {
  return mapGraphNodes(graph, (node) =>
    isOwnFunctionCall(node, previousName, classId)
      ? {
          ...node,
          data: { ...node.data, functionName: nextName, title: `Call ${nextName}` },
        }
      : node,
  );
}

const DISPATCHER_ACTION_BY_TYPE: Record<string, DispatcherNodeAction> = Object.fromEntries(
  Object.entries(DISPATCHER_NODE_TYPE_IDS).map(([action, type]) => [type, action as DispatcherNodeAction]),
);

/** A Call, Bind, Unbind or Unbind All node of this Class's own dispatcher `name`. */
function isOwnDispatcherNode(
  node: SerializedGraph["nodes"][number],
  name: string,
  classId: string | undefined,
): boolean {
  return (
    node.type in DISPATCHER_ACTION_BY_TYPE &&
    node.data.name === name &&
    (node.data.implicitSelf === true || !node.data.classId || node.data.classId === classId)
  );
}

/**
 * Carry a dispatcher's new name or inputs to everything this Class built from
 * it: its own Call / Bind / Unbind nodes, the custom events wired to a Bind or
 * Unbind (they take its signature, as in Unreal) and the Delegate types whose
 * signature was copied from it.
 */
function syncDispatcher(
  graph: SerializedGraph,
  previousName: string,
  member: GraphClassMember,
  classId: string | undefined,
): SerializedGraph {
  const dispatcherNodeIds = new Set<string>();
  let next = mapGraphNodes(graph, (node) => {
    if (!isOwnDispatcherNode(node, previousName, classId)) return node;
    dispatcherNodeIds.add(node.id);
    const action = DISPATCHER_ACTION_BY_TYPE[node.type]!;
    const nextData: Record<string, unknown> = {
      ...node.data,
      ...dispatcherNodeData(member, action, {
        classId: typeof node.data.classId === "string" ? node.data.classId : undefined,
        implicitSelf: node.data.implicitSelf === true,
      }),
    };
    delete nextData.__pins;
    return { ...node, data: nextData };
  });
  // Custom events live in the Event Graph, so the wires that bind them do too.
  const boundEventIds = new Set(
    next.edges
      .filter((edge) =>
        edge.sourceHandle === OUTPUT_DELEGATE_PIN_ID &&
        edge.targetHandle === "event" &&
        dispatcherNodeIds.has(edge.target))
      .map((edge) => edge.source),
  );
  const eventPins = dispatcherEventPins(member);
  for (const node of next.nodes) {
    if (!boundEventIds.has(node.id) || node.type !== "flow.event.custom") continue;
    const name = formatEventMemberName(String(node.data.name ?? ""));
    const eventMember = (next.members ?? []).find(
      (entry) => entry.kind === "event" && (entry.id === node.id || formatEventMemberName(entry.name) === name),
    );
    next = syncEventPins(next, eventMember ?? { id: node.id, kind: "event", name }, eventPins);
    if (eventMember) {
      next = {
        ...next,
        members: (next.members ?? []).map((entry) => entry === eventMember ? { ...entry, pins: eventPins } : entry),
      };
    }
  }
  return syncDelegateCopies(
    next,
    delegateSignatureSource(classId ?? "", previousName),
    delegateSignatureSource(classId ?? "", member.name),
    signatureOfPins(member.pins),
    classId,
  );
}

/** Retarget this Class's Delegate types copied from one dispatcher to its new name and inputs. */
function syncDelegateCopies(
  graph: SerializedGraph,
  previousSource: string,
  nextSource: string,
  signature: NonNullable<GraphClassMember["signature"]>,
  classId: string | undefined,
): SerializedGraph {
  const copy = <T extends { typeId?: string; typeClassId?: string }>(row: T): T =>
    row.typeId === "delegate" && row.typeClassId === previousSource
      ? { ...row, typeClassId: nextSource, signature: signature.map((input) => ({ ...input })) }
      : row;
  let next = graph;
  for (const member of graph.members ?? []) {
    const variable = member.kind === "variable" ? copy(member) : member;
    const pins = member.pins?.map(copy);
    const changedPins = pins?.some((pin, index) => pin !== member.pins![index]) === true;
    if (variable === member && !changedPins) continue;
    const updated: GraphClassMember = { ...variable, ...(changedPins ? { pins } : {}) };
    next = {
      ...next,
      members: (next.members ?? []).map((entry) => entry.id === member.id ? updated : entry),
    };
    if (updated.kind === "variable") next = syncVariableAccessNodes(next, updated);
    else if (changedPins && updated.kind === "event") next = syncEventPins(next, updated, pins!);
    else if (changedPins && updated.kind === "function") next = syncFunctionGraphPins(next, updated.id, pins!, classId);
    else if (changedPins && updated.kind === "dispatcher") next = syncDispatcher(next, updated.name, updated, classId);
  }
  return next;
}

export function patchClassMember(
  graph: SerializedGraph,
  memberId: string,
  patch: Partial<GraphClassMember>,
  /** This document's class id, so a function rename or signature edit reaches only its own Calls. */
  classId?: string,
): SerializedGraph {
  const previous = (graph.members ?? []).find((member) => member.id === memberId);
  if (previous?.kind === "event" && patch.name !== undefined) {
    const event = graph.nodes.find((node) =>
      node.type === "flow.event.custom" &&
      (node.id === memberId ||
        formatEventMemberName(String(node.data.name ?? "")) ===
          formatEventMemberName(previous.name)),
    );
    if (!event || customEventRenameError(graph, event.id, patch.name)) return graph;
    graph = renameCustomEvent(graph, event.id, patch.name);
    patch = { ...patch, name: formatEventMemberName(patch.name) };
  }
  if (previous?.kind === "function" && patch.name !== undefined && patch.name !== previous.name) {
    graph = renameFunctionCalls(graph, previous.name, patch.name, classId);
  }
  const members = (graph.members ?? []).map((member) => {
    if (member.id !== memberId) return member;
    const next = { ...member, ...patch };
    if ("overridable" in patch && patch.overridable !== true) {
      delete next.overridable;
    }
    // Soft is the absence of the property.
    if ("loading" in patch && patch.loading !== "hard") delete next.loading;
    if ("unit" in patch && !patch.unit) delete next.unit;
    if ("category" in patch) {
      const category = normalizeClassMemberCategory(patch.category);
      if (category) next.category = category;
      else delete next.category;
    }
    return next;
  });
  const next = { ...graph, members };
  const declared = next.members?.find((member) => member.id === memberId);
  if (declared?.kind === "variable") {
    return syncVariableAccessNodes(next, declared);
  }
  if (declared?.kind === "dispatcher" && previous) {
    return patch.name !== undefined || patch.pins
      ? syncDispatcher(next, previous.name, declared, classId)
      : next;
  }
  if (!patch.pins) return next;
  if (declared?.kind === "event") {
    return syncEventPins(next, declared, patch.pins);
  }
  return syncFunctionGraphPins(next, memberId, patch.pins, classId);
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
  context?: ClassMemberEditContext,
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
    const next = { ...graph, members, functionGraphs };
    const ownCall = (node: SerializedGraph["nodes"][number]) =>
      isOwnFunctionCall(node, declared.name, context?.classId);
    // A parent's function of that name still answers this Class's Calls.
    const inherited = inheritedFunctionClassId(declared, context);
    if (inherited) {
      return mapGraphNodes(next, (node) =>
        ownCall(node) ? { ...node, data: { ...node.data, classId: inherited } } : node,
      );
    }
    // Otherwise its own Call Function nodes go with it, as a rename retargets them.
    return dropGraphNodes(next, ownCall);
  }
  if (declared?.kind === "event") {
    const eventName = formatEventMemberName(declared.name);
    const dropIds = new Set(
      graph.nodes
        .filter((node) => {
          if (node.type === "flow.event.call") return false;
          if (node.type === "flow.event.callParent") {
            return (
              node.data.eventType === "flow.event.custom" &&
              formatEventMemberName(String(node.data.eventName ?? "")) === eventName
            );
          }
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
  if (declared?.kind === "variable") {
    // Get / Set / Validated Get nodes go with the variable, as a rename syncs them.
    return dropGraphNodes({ ...graph, members }, (node) =>
      isVariableAccessNode(node, declared),
    );
  }
  if (declared?.kind === "dispatcher") {
    // Its Call / Bind / Unbind nodes go with it, as a rename retargets them.
    return dropGraphNodes({ ...graph, members }, (node) =>
      isOwnDispatcherNode(node, declared.name, context?.classId),
    );
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

/** The signature rows a delegate input stands for: a dispatcher node's inputs, else the input's own signature. */
function delegateInputRows(
  node: SerializedGraph["nodes"][number],
  pinId: string,
): GraphClassMemberPin[] | null {
  const rows = Array.isArray(node.data.pins) ? (node.data.pins as GraphClassMemberPin[]) : [];
  if (node.type in DISPATCHER_ACTION_BY_TYPE && pinId === "event") {
    return dispatcherEventPins({ pins: rows });
  }
  const row = rows.find((entry) => entry.name === pinId && entry.typeId === "delegate");
  if (!row) return null;
  return (row.signature ?? []).map((input, index) => ({
    ...input,
    name: `Input ${index + 1}`,
    direction: "out" as const,
  }));
}

/**
 * Give each custom event that takes nothing the signature of the delegate
 * input its Output Delegate was just wired to, as Unreal does: wiring an empty
 * event to Bind Event to On Damaged gives it On Damaged's inputs, names
 * included, in the same change.
 */
export function adoptBoundEventSignatures(
  graph: SerializedGraph,
  classId?: string,
): SerializedGraph {
  let next = graph;
  for (const edge of graph.edges) {
    if (edge.sourceHandle !== OUTPUT_DELEGATE_PIN_ID || !edge.targetHandle) continue;
    const event = next.nodes.find((node) => node.id === edge.source);
    if (event?.type !== "flow.event.custom") continue;
    const current = Array.isArray(event.data.pins) ? (event.data.pins as GraphClassMemberPin[]) : [];
    if (current.some((pin) => pin.typeId !== "exec")) continue;
    const target = next.nodes.find((node) => node.id === edge.target);
    const pins = target ? delegateInputRows(target, edge.targetHandle) : null;
    if (!pins || pins.length === 0) continue;
    const name = formatEventMemberName(String(event.data.name ?? event.data.title ?? "Custom"));
    const member = (next.members ?? []).find(
      (entry) => entry.kind === "event" && (entry.id === event.id || formatEventMemberName(entry.name) === name),
    );
    // A canvas-only event gets its member row here, as the Inspector's first pin edit gives it one.
    const withMember: SerializedGraph = member
      ? next
      : { ...next, members: [...(next.members ?? []), { id: event.id, kind: "event", name, pins: [] }] };
    next = patchClassMember(withMember, member?.id ?? event.id, { pins }, classId);
  }
  return next;
}
