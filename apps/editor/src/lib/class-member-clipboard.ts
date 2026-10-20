import type {
  GraphClassMember,
  GraphClassMemberPin,
  SerializedComponent,
  SerializedGraph,
} from "@babylonslate/core";
import { nextCopyName } from "@babylonslate/assets";
import {
  engineParentOf,
  formatEventMemberName,
  formatEventTitle,
  walkAncestry,
} from "@babylonslate/editor-kit";
import {
  NODE_PLACEMENT_GAP,
  estimateGraphNodeSize,
  graphNodesBounds,
} from "@babylonslate/graph-ui";
import {
  isSceneLayerAllowedComponent,
  isSceneLayerExclusiveComponent,
} from "@babylonslate/object-model";
import { singletonEventKey, variableTypeFromPinType } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { renamedComponentName } from "../panels/add-component-catalog";
import {
  canRenameCustomEvent,
  classAllowsMemberKind,
  ensureCallParentForEvent,
  isScriptCatalogNodeAllowed,
  joinNames,
  nativeEventStubs,
  nativeEventTitle,
  patchVariableAccessNode,
  seedFunctionGraph,
  type ClassEventOptions,
} from "./class-members";
import { eventNameKeys } from "./graph-paste";
import { customEventsFromGraph } from "./overridable-functions";
import { defaultPrefabComponents, nextPrefabComponentId } from "./prefab-preview";

type GraphNode = SerializedGraph["nodes"][number];
type GraphEdge = SerializedGraph["edges"][number];

const CUSTOM_EVENT = "flow.event.custom";
const FUNCTION_INPUT = "flow.function.input";
const FUNCTION_OUTPUT = "flow.function.output";

/**
 * A copied variable with its full definition. A local variable keeps the
 * `functionId` of its source function; a component variable carries the
 * component it stands for, because the variable itself is not stored.
 */
export type ClipboardVariable = {
  member: GraphClassMember;
  component?: SerializedComponent;
  /** The Class whose names its function bodies were written against. */
  sourceClassId?: string;
};

/** A copied function: signature, local variables and the whole function graph. */
export type ClipboardFunction = {
  member: GraphClassMember;
  locals: GraphClassMember[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceClassId?: string;
};

/** A copied event: the event node alone, never the nodes it runs. */
export type ClipboardEvent = {
  node: GraphNode;
  /** A custom event the Class does not own (an override, a component event). An override keeps its binding; a component event pastes unbound. */
  bound: boolean;
  sourceClassId?: string;
};

/** Snapshot of Class members that survives switching between Class assets. */
export type ClassMemberClipboard = {
  variables: ClipboardVariable[];
  functions: ClipboardFunction[];
  events: ClipboardEvent[];
};

/** A Class tree row, as far as Copy needs to know it. */
export type ClassMemberCopyRow = {
  id: string;
  kind: GraphClassMember["kind"];
  name: string;
  inheritedFrom?: string;
  componentId?: string;
  functionId?: string;
};

export type ClassMemberCopySource = {
  graph: SerializedGraph;
  classId?: string;
  /** Class graphs by class id, where rows inherited from a parent are read. */
  parentGraphs?: Record<string, SerializedGraph>;
};

function collectClassMembers(
  rows: readonly ClassMemberCopyRow[],
  source: ClassMemberCopySource,
): ClassMemberClipboard | null {
  if (rows.length === 0) return null;
  const clip: ClassMemberClipboard = { variables: [], functions: [], events: [] };
  for (const row of rows) {
    if (row.kind === "interface") return null;
    const owner = row.inheritedFrom ? source.parentGraphs?.[row.inheritedFrom] : source.graph;
    const sourceClassId = row.inheritedFrom ?? source.classId;
    if (!owner) return null;
    if (row.componentId) {
      // The Class's own list wins: it holds the overrides of an inherited component.
      const component = [source.graph, owner]
        .flatMap((graph) => graph.components ?? [])
        .find((entry) => entry.id === row.componentId);
      if (row.kind !== "variable" || !component) return null;
      clip.variables.push({
        member: {
          id: `component:${component.id}`,
          kind: "variable",
          name: row.name,
          typeId: "object",
          typeClassId: component.classId,
          componentId: component.id,
        },
        component,
        ...(sourceClassId ? { sourceClassId } : {}),
      });
      continue;
    }
    if (row.functionId) {
      const local = (owner.members ?? []).find(
        (entry) =>
          entry.kind === "variable" && entry.id === row.id && entry.functionId === row.functionId,
      );
      if (row.kind !== "variable" || row.inheritedFrom || !local) return null;
      clip.variables.push({ member: local, ...(sourceClassId ? { sourceClassId } : {}) });
      continue;
    }
    if (row.kind === "event") {
      if (row.inheritedFrom) return null;
      const node = owner.nodes.find((entry) => entry.id === row.id);
      if (!node) return null;
      clip.events.push({
        node,
        bound: node.type === CUSTOM_EVENT && !canRenameCustomEvent(owner, node.id),
        ...(sourceClassId ? { sourceClassId } : {}),
      });
      continue;
    }
    // A row inherited from a parent is told apart by name; its id is a stub.
    const member = (owner.members ?? []).find((entry) =>
      entry.kind === row.kind &&
      !entry.functionId &&
      (row.inheritedFrom ? entry.name === row.name : entry.id === row.id),
    );
    if (!member) return null;
    if (row.kind === "variable") {
      clip.variables.push({ member, ...(sourceClassId ? { sourceClassId } : {}) });
      continue;
    }
    const slice = owner.functionGraphs?.[member.id];
    clip.functions.push({
      member,
      locals: (owner.members ?? []).filter(
        (entry) => entry.kind === "variable" && entry.functionId === member.id,
      ),
      nodes: slice?.nodes ?? [],
      edges: slice?.edges ?? [],
      ...(sourceClassId ? { sourceClassId } : {}),
    });
  }
  return clip;
}

/**
 * Whether Copy applies to the selected rows: at least one, and only
 * variables (including local and component variables), functions and events.
 * A Script Interface or a row whose source is gone rules it out.
 */
export function canCopyClassMembers(
  rows: readonly ClassMemberCopyRow[],
  source: ClassMemberCopySource,
): boolean {
  return collectClassMembers(rows, source) !== null;
}

/**
 * Snapshot the selected rows (see `canCopyClassMembers`), or null. Rows come
 * in tree order; so do the members of the snapshot.
 */
export function copyClassMembers(
  rows: readonly ClassMemberCopyRow[],
  source: ClassMemberCopySource,
): ClassMemberClipboard | null {
  const clip = collectClassMembers(rows, source);
  return clip ? structuredClone(clip) : null;
}

/** The parent Classes whose graphs are known, nearest first. */
export function classAncestorGraphs(options: {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
}): Array<{ classId: string; graph: SerializedGraph }> {
  const parentOf = options.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return walkAncestry(options.parentClass ?? null, parentOf).flatMap((classId) => {
    const graph = options.parentGraphs?.[classId];
    return graph ? [{ classId, graph }] : [];
  });
}

export type ClassMemberPasteOptions = {
  graph: SerializedGraph;
  clipboard: ClassMemberClipboard;
  /** The target Class's id; its own Call nodes carry it. */
  classId?: string;
  /** Every name the target lists per kind: its own, inherited, component and local rows. */
  takenNames: { variable: readonly string[]; function: readonly string[] };
  /** Parent Classes, nearest first: where inherited members and events come from. */
  ancestors?: ReadonlyArray<{ classId: string; graph: SerializedGraph }>;
  /** Parent and asset type of the target, which decide the events it can have. */
  eventOptions?: ClassEventOptions;
  /** The function of the target that local variables go into: the selected one, else the focused one. */
  targetFunctionId?: string | null;
  idFactory?: () => string;
};

export type PastedClassMember = {
  kind: "variable" | "function" | "event";
  id: string;
  name: string;
  /** A pasted component variable: the id of the component added with it. */
  componentId?: string;
  /** A pasted local variable: the function it went into. */
  functionId?: string;
};

export type SkippedClassMember = {
  kind: "variable" | "function" | "event";
  name: string;
  /**
   * `kind`: the Class cannot have that member. `unavailable`: an override of an inherited custom event the Class does not inherit.
   * `present`: it already has it. `function`: a local variable with no function to go into.
   */
  reason: "kind" | "unavailable" | "present" | "function";
};

export type ClassMemberPasteResult = {
  graph: SerializedGraph;
  pasted: PastedClassMember[];
  skipped: SkippedClassMember[];
};

type TargetMember = { member: GraphClassMember; classId?: string };
type TargetEvent = { name: string; pins: GraphClassMemberPin[]; classId?: string };

/** `Source Class + name` keys a member of the paste by what its function bodies call it. */
function nameKey(classId: string | undefined, name: string): string {
  return `${classId ?? ""}\0${name}`;
}

function typeKey(spec: {
  typeId?: unknown;
  typeClassId?: unknown;
  container?: unknown;
  keyTypeId?: unknown;
  keyTypeClassId?: unknown;
}): string {
  const container = spec.container === "array" || spec.container === "map" ? spec.container : "single";
  return [
    spec.typeId ?? "float",
    spec.typeClassId ?? "",
    container,
    container === "map" ? (spec.keyTypeId ?? "string") : "",
    container === "map" ? (spec.keyTypeClassId ?? "") : "",
  ].join("\0");
}

/** The data pins of a signature, whatever their order; exec pins are not part of the type. */
function signatureKey(pins: unknown): string {
  if (!Array.isArray(pins)) return "";
  return (pins as GraphClassMemberPin[])
    .filter((pin) => pin && pin.typeId !== "exec")
    .map((pin) => [
      pin.direction,
      pin.name,
      pin.container === "array" || pin.container === "map" ? pin.container : "single",
      pin.typeId,
      pin.typeClassId ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

function eventKey(node: Pick<GraphNode, "type" | "data">): string | undefined {
  return singletonEventKey({ typeId: node.type, properties: node.data }, false);
}

function customEventName(node: Pick<GraphNode, "data">): string {
  return formatEventMemberName(String(node.data.name ?? node.data.title ?? ""));
}

/** `Event Begin Play` → `Begin Play`; a component qualifier is not part of the name. */
function nativeEventBaseName(node: Pick<GraphNode, "type" | "data">): string {
  const title =
    typeof node.data.title === "string" && node.data.title
      ? node.data.title
      : nativeEventTitle(node.type);
  return formatEventMemberName(title).replace(/\s*\([^)]*\)\s*$/, "").trim() || "Event";
}

let nodeRegistry: ReturnType<typeof createDefaultNodeRegistry> | undefined;

/** The data outputs a native event node carries, as the parameters of a custom event: same names, types and order. */
function nativeEventOutputPins(node: Pick<GraphNode, "type" | "data">): GraphClassMemberPin[] {
  nodeRegistry ??= createDefaultNodeRegistry();
  return (nodeRegistry.get(node.type)?.pins(node.data) ?? [])
    .filter((pin) => pin.kind === "data" && pin.direction === "out")
    .map((pin) => {
      const type = variableTypeFromPinType(pin.type);
      return {
        name: pin.name,
        typeId: type.typeId,
        direction: "out" as const,
        ...(type.container !== "single" ? { container: type.container } : {}),
        ...(type.typeClassId ? { typeClassId: type.typeClassId } : {}),
      };
    });
}

/** A custom event bound to a component keeps the component out of its name: `Open (Door)` → `Open`. */
function componentCustomEventName(node: Pick<GraphNode, "data">): string {
  if (typeof node.data.name === "string" && node.data.name) return customEventName(node);
  return customEventName(node).replace(/\s*\([^)]*\)\s*$/, "").trim() || "Event";
}

function isComponentEvent(node: Pick<GraphNode, "data">): boolean {
  return typeof node.data.componentId === "string";
}

function eventTitleForNotice(node: Pick<GraphNode, "type" | "data">): string {
  return node.type === CUSTOM_EVENT
    ? customEventName(node)
    : formatEventTitle(nativeEventBaseName(node));
}

/** A name that is not taken: unchanged when free, else the repo's duplicate naming (`Name_1`). */
function uniqueName(name: string, taken: Set<string>): string {
  const unique = taken.has(name) ? nextCopyName(name, [...taken]) : name;
  taken.add(unique);
  return unique;
}

/**
 * Events show a copy index as a space (`Open Door 1`) where a variable keeps
 * the underscore, and are unique across case and compiled identifier.
 */
function uniqueEventName(name: string, taken: ReadonlySet<string>): string {
  const base = formatEventMemberName(name);
  const isTaken = (candidate: string) =>
    eventNameKeys({ name: candidate }).some((key) => taken.has(key));
  if (!isTaken(base)) return base;
  const stored = base.replace(/ (\d+)$/, "_$1");
  const used = [stored];
  for (;;) {
    const raw = nextCopyName(stored, used);
    const candidate = formatEventMemberName(raw);
    if (!isTaken(candidate)) return candidate;
    used.push(raw);
  }
}

function withClassId(node: GraphNode, classId: string | undefined): GraphNode {
  const data = { ...node.data };
  if (classId) data.classId = classId;
  else delete data.classId;
  return { ...node, data };
}

type FunctionPaste = {
  source: ClipboardFunction;
  member: GraphClassMember;
  /** Source local id → its copy. */
  locals: Map<string, GraphClassMember>;
};

type ReferenceTargets = {
  classId?: string;
  pastedVariablesById: Map<string, GraphClassMember>;
  /** Source component id → the variable of its copy. */
  pastedComponents: Map<string, GraphClassMember>;
  pastedVariablesByName: Map<string, GraphClassMember>;
  pastedFunctionsByName: Map<string, GraphClassMember>;
  pastedEventsByName: Map<string, { name: string; classId?: string }>;
  /** `Copy component id + source event name` → the unbound custom event pasted for a custom event of that component. */
  pastedComponentEvents: Map<string, { name: string; pins: GraphClassMemberPin[] }>;
  variables: TargetMember[];
  functions: TargetMember[];
  events: TargetEvent[];
};

/**
 * Point a node of a pasted function body at the member it meant, in the order
 * of the paste: the copy that came with it, then the target Class's member of
 * the same name and type. Anything else is left as it was, so validation
 * reports it; no member is created. Only references to the running object
 * qualify; a node that wires in its target object keeps its binding.
 */
function remapReferences(node: GraphNode, fn: FunctionPaste, refs: ReferenceTargets): GraphNode {
  const data = node.data;
  const sourceClassId = fn.source.sourceClassId;
  const isSelf = data.implicitSelf !== false && !data.componentId;
  const isOwn = !data.classId || data.classId === sourceClassId;
  switch (node.type) {
    case "variables.get":
    case "variables.set":
    case "variables.getValidated": {
      if (data.scope === "local" || typeof data.functionId === "string") {
        const local =
          fn.locals.get(String(data.variableId)) ??
          [...fn.locals.values()].find((entry) => entry.name === data.variableName);
        return local ? patchVariableAccessNode(node, local) : node;
      }
      if (typeof data.componentId === "string") {
        // A component pasted in the same paste is a copy with a new id; any other binding stays.
        const copy = refs.pastedComponents.get(data.componentId);
        if (!copy) return node;
        const patched = patchVariableAccessNode(node, copy);
        return withClassId({ ...patched, data: { ...patched.data, componentId: copy.componentId } }, refs.classId);
      }
      if (!isSelf || data.propertyKey) return node;
      const pasted = isOwn
        ? (refs.pastedVariablesById.get(String(data.variableId)) ??
          refs.pastedVariablesByName.get(nameKey(sourceClassId, String(data.variableName))))
        : undefined;
      if (pasted) return withClassId(patchVariableAccessNode(node, pasted), refs.classId);
      const type = typeKey(data);
      const found = refs.variables.find(
        (entry) => entry.member.name === data.variableName && typeKey(entry.member) === type,
      );
      return found ? withClassId(patchVariableAccessNode(node, found.member), found.classId) : node;
    }
    case "functions.call": {
      if (!isSelf || data.runtime) return node;
      const name = String(data.functionName);
      const pasted = isOwn ? refs.pastedFunctionsByName.get(nameKey(sourceClassId, name)) : undefined;
      if (pasted) {
        return withClassId(
          { ...node, data: { ...data, functionName: pasted.name, title: `Call ${pasted.name}` } },
          refs.classId,
        );
      }
      const signature = signatureKey(data.pins);
      const found = refs.functions.find(
        (entry) => entry.member.name === name && signatureKey(entry.member.pins) === signature,
      );
      return found ? withClassId(node, found.classId) : node;
    }
    case "flow.event.call": {
      if (!isSelf) return node;
      const name = formatEventMemberName(String(data.name ?? ""));
      const pasted = isOwn ? refs.pastedEventsByName.get(nameKey(sourceClassId, name)) : undefined;
      if (pasted) {
        return withClassId(
          { ...node, data: { ...data, name: pasted.name, title: `Call ${pasted.name}` } },
          refs.classId,
        );
      }
      const signature = signatureKey(data.pins);
      const found = refs.events.find(
        (entry) => entry.name === name && signatureKey(entry.pins) === signature,
      );
      return found ? withClassId(node, found.classId) : node;
    }
    default:
      return node;
  }
}

/**
 * A Call Custom Event whose target is a Get of a component pasted in the same
 * paste, and whose event is one of that component's pasted custom events,
 * calls the copy on the running object instead: the target wire goes, and the
 * Get with it when nothing else reads it. Every other call stays as it was.
 */
function retargetComponentEventCalls(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  refs: ReferenceTargets,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (refs.pastedComponentEvents.size === 0) return graph;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const retargeted = new Map<string, GraphNode>();
  const droppedEdges = new Set<GraphEdge>();
  const gets = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "flow.event.call" || node.data.implicitSelf !== false) continue;
    const wire = graph.edges.find((edge) => edge.target === node.id && edge.targetHandle === "target");
    const get = wire ? byId.get(wire.source) : undefined;
    if (!wire || get?.type !== "variables.get" || typeof get.data.componentId !== "string") continue;
    const copy = refs.pastedComponentEvents.get(
      `${get.data.componentId}\0${formatEventMemberName(String(node.data.name ?? ""))}`,
    );
    if (!copy) continue;
    droppedEdges.add(wire);
    gets.add(get.id);
    retargeted.set(
      node.id,
      withClassId(
        {
          ...node,
          data: {
            ...node.data,
            name: copy.name,
            title: `Call ${copy.name}`,
            implicitSelf: true,
            pins: structuredClone(copy.pins),
          },
        },
        refs.classId,
      ),
    );
  }
  if (retargeted.size === 0) return graph;
  const edges = graph.edges.filter((edge) => !droppedEdges.has(edge));
  const unused = new Set([...gets].filter((id) => !edges.some((edge) => edge.source === id)));
  return {
    nodes: graph.nodes.flatMap((node) => (unused.has(node.id) ? [] : [retargeted.get(node.id) ?? node])),
    edges: edges.filter((edge) => !unused.has(edge.target)),
  };
}

/** The function graph of a copy: fresh ids, wires kept, references remapped. */
function pastedFunctionGraph(
  fn: FunctionPaste,
  refs: ReferenceTargets,
  newId: () => string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (fn.source.nodes.length === 0) return seedFunctionGraph(fn.member);
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const node of fn.source.nodes) {
    const conventional =
      node.type === FUNCTION_INPUT
        ? `${fn.member.id}-input`
        : node.type === FUNCTION_OUTPUT
          ? `${fn.member.id}-output`
          : undefined;
    const id = conventional && !used.has(conventional) ? conventional : newId();
    used.add(id);
    ids.set(node.id, id);
  }
  const nodes = fn.source.nodes.map((node) =>
    remapReferences({ ...node, id: ids.get(node.id)! }, fn, refs),
  );
  const edges = fn.source.edges.flatMap((edge) => {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) return [];
    return [{
      ...edge,
      id: `e:${source}:${edge.sourceHandle ?? ""}:${target}:${edge.targetHandle ?? ""}`,
      source,
      target,
    }];
  });
  return retargetComponentEventCalls({ nodes, edges }, refs);
}

/** Members a graph declares directly: not a function's locals, not a component's virtual variable. */
function declaredMembers(graph: SerializedGraph | undefined, kind: GraphClassMember["kind"]): GraphClassMember[] {
  return (graph?.members ?? []).filter(
    (member) => member.kind === kind && !member.functionId && !member.componentId,
  );
}

/**
 * The target's component tree. `local` is what the Class authors; a Class that
 * never authored any and inherits none shows the starter box, which a new
 * component must not displace. `components` adds the inherited ones, whose ids
 * a copy must not take.
 */
function componentTarget(options: ClassMemberPasteOptions): {
  local: SerializedComponent[];
  components: SerializedComponent[];
  accepts: (classId: string) => boolean;
} {
  const inherited = (options.ancestors ?? []).flatMap((ancestor) => ancestor.graph.components ?? []);
  const authored = options.graph.components;
  const local = Array.isArray(authored) ? authored : inherited.length > 0 ? [] : defaultPrefabComponents();
  const parentOf = options.eventOptions?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const overlay = walkAncestry(options.eventOptions?.parentClass ?? null, parentOf).includes("SceneLayerActor");
  return {
    local,
    components: [...inherited, ...local],
    accepts: (classId) =>
      overlay ? isSceneLayerAllowedComponent(classId) : !isSceneLayerExclusiveComponent(classId),
  };
}

/** Properties that name another component (`targetComponentId`) follow it when that one was copied too. */
function remapComponentReferences(
  properties: Record<string, unknown>,
  copies: ReadonlyMap<string, GraphClassMember>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const copy = key.endsWith("ComponentId") && typeof value === "string" ? copies.get(value) : undefined;
    mapped[key] = copy?.componentId ?? value;
  }
  return mapped;
}

/**
 * Paste the snapshot into a Class as duplicates, in one graph change.
 *
 * - Variables, functions (and their locals) and custom events take a free
 *   name when theirs is taken, by the repo's duplicate naming.
 * - Function bodies are copied with fresh node ids and their references
 *   remapped (see `remapReferences`); a function's interface and override
 *   bindings stay with the original.
 * - Local variables go into `targetFunctionId`; without one they are left out.
 * - A component variable adds a copy of its component to the Class (attached
 *   to the root, or to the copy of its parent when that came too).
 * - Events go into the event graph below the existing nodes. A native event
 *   the target's own graph lacks, and its Class can have, is pasted as that
 *   event, wired to Call Parent like one added by hand; otherwise (the Class
 *   cannot have it or has it) it becomes a custom event named like a
 *   duplicate (`Begin Play 1`) with the native event's data outputs as its
 *   parameters.
 * - An event bound to a component, native or custom, always becomes such a
 *   custom event, bound to no component and without Call Parent, whether or
 *   not the target has that component.
 * - In a pasted function, a Call Custom Event wired to a Get of a component
 *   pasted too, for one of that component's pasted custom events, calls the
 *   copy on the running object (`retargetComponentEventCalls`).
 * - An override of an inherited custom event is wired to Call Parent as well.
 * - A component added by a paste is named like a variable (`Mesh_1`).
 */
export function pasteClassMembers(options: ClassMemberPasteOptions): ClassMemberPasteResult {
  const { clipboard, classId } = options;
  const newId = options.idFactory ?? (() => crypto.randomUUID());
  const ancestors = options.ancestors ?? [];
  const added: GraphClassMember[] = [];
  const pasted: PastedClassMember[] = [];
  const skipped: SkippedClassMember[] = [];

  const takenVariables = new Set(options.takenNames.variable);
  const takenFunctions = new Set(options.takenNames.function);
  for (const member of options.graph.members ?? []) {
    if (member.kind === "variable") takenVariables.add(member.name);
    else if (member.kind === "function") takenFunctions.add(member.name);
  }

  const refs: ReferenceTargets = {
    classId,
    pastedVariablesById: new Map(),
    pastedComponents: new Map(),
    pastedVariablesByName: new Map(),
    pastedFunctionsByName: new Map(),
    pastedEventsByName: new Map(),
    pastedComponentEvents: new Map(),
    variables: [
      ...declaredMembers(options.graph, "variable").map((member) => ({ member, classId })),
      ...ancestors.flatMap((ancestor) =>
        declaredMembers(ancestor.graph, "variable").map((member) => ({ member, classId: ancestor.classId })),
      ),
    ],
    functions: [
      ...declaredMembers(options.graph, "function").map((member) => ({ member, classId })),
      ...ancestors.flatMap((ancestor) =>
        declaredMembers(ancestor.graph, "function").map((member) => ({ member, classId: ancestor.classId })),
      ),
    ],
    events: [
      ...customEventsFromGraph(options.graph).map((event) => ({ ...event, classId })),
      ...ancestors.flatMap((ancestor) =>
        customEventsFromGraph(ancestor.graph).map((event) => ({ ...event, classId: ancestor.classId })),
      ),
    ],
  };

  // Local variables go into one function of the target; a component variable
  // brings a copy of its component. Neither is a member row of the Class.
  const targetFunctionId = (options.graph.members ?? []).find(
    (member) => member.kind === "function" && !member.functionId && member.id === options.targetFunctionId,
  )?.id;
  const variablesAllowed = classAllowsMemberKind("variable", options.eventOptions);
  const target = componentTarget(options);
  const pastedComponents: Array<{ source: SerializedComponent; copy: SerializedComponent }> = [];
  for (const entry of clipboard.variables) {
    const name = entry.member.name;
    if (entry.component) {
      const source = entry.component;
      if (!variablesAllowed || !target.accepts(source.classId)) {
        skipped.push({ kind: "variable", name, reason: "kind" });
        continue;
      }
      const label = uniqueName(name, takenVariables);
      const copy: SerializedComponent = {
        id: nextPrefabComponentId([...target.components, ...pastedComponents.map((entry) => entry.copy)]),
        classId: source.classId,
        ...(renamedComponentName(source.classId, label) ? { name: label } : {}),
        ...(source.category !== undefined ? { category: source.category } : {}),
        properties: structuredClone(source.properties),
        parentId: null,
        ...(source.transform ? { transform: structuredClone(source.transform) } : {}),
      };
      pastedComponents.push({ source, copy });
      const variable: GraphClassMember = {
        id: `component:${copy.id}`,
        kind: "variable",
        name: label,
        typeId: "object",
        typeClassId: copy.classId,
        componentId: copy.id,
      };
      refs.pastedComponents.set(source.id, variable);
      pasted.push({ kind: "variable", id: variable.id, name: label, componentId: copy.id });
      continue;
    }
    if (entry.member.functionId) {
      if (!classAllowsMemberKind("variable", { ...options.eventOptions, local: true })) {
        skipped.push({ kind: "variable", name, reason: "kind" });
      } else if (!targetFunctionId) {
        skipped.push({ kind: "variable", name, reason: "function" });
      } else {
        const local: GraphClassMember = {
          ...structuredClone(entry.member),
          id: newId(),
          name: uniqueName(name, takenVariables),
          functionId: targetFunctionId,
        };
        added.push(local);
        pasted.push({ kind: "variable", id: local.id, name: local.name, functionId: targetFunctionId });
      }
      continue;
    }
    if (!variablesAllowed) {
      skipped.push({ kind: "variable", name, reason: "kind" });
      continue;
    }
    const copy: GraphClassMember = {
      ...structuredClone(entry.member),
      id: newId(),
      name: uniqueName(name, takenVariables),
    };
    added.push(copy);
    refs.pastedVariablesById.set(entry.member.id, copy);
    refs.pastedVariablesByName.set(nameKey(entry.sourceClassId, name), copy);
    pasted.push({ kind: "variable", id: copy.id, name: copy.name });
  }
  // A copy is attached to the Class root unless the component it hung from came along.
  const components = pastedComponents.map(({ source, copy }) => {
    const parent = source.parentId ? refs.pastedComponents.get(source.parentId)?.componentId : undefined;
    return {
      ...copy,
      parentId: parent ?? null,
      properties: remapComponentReferences(copy.properties, refs.pastedComponents),
    };
  });

  const functions: FunctionPaste[] = [];
  for (const entry of clipboard.functions) {
    const member: GraphClassMember = {
      ...structuredClone(entry.member),
      id: newId(),
      name: uniqueName(entry.member.name, takenFunctions),
    };
    // The original keeps the interface it implements and the function it overrides.
    delete member.implementsInterface;
    delete member.overrides;
    const locals = new Map<string, GraphClassMember>();
    for (const local of entry.locals) {
      locals.set(local.id, {
        ...structuredClone(local),
        id: newId(),
        name: uniqueName(local.name, takenVariables),
        functionId: member.id,
      });
    }
    functions.push({ source: entry, member, locals });
    refs.pastedFunctionsByName.set(nameKey(entry.sourceClassId, entry.member.name), member);
    pasted.push({ kind: "function", id: member.id, name: member.name });
  }

  // Events: names and nodes first, so function bodies can call the copies.
  const eventNodes: GraphNode[] = [];
  const callParents: Array<{
    id: string;
    eventType: string;
    eventName?: string;
    parentClassId: string;
    pins?: GraphClassMemberPin[];
  }> = [];
  const parentClassId = options.eventOptions?.parentClass?.trim();
  const eventsAllowed = classAllowsMemberKind("event", options.eventOptions);
  const presentEvents = new Set<string>();
  const takenEvents = new Set<string>();
  const claimEvent = (name: string) => {
    for (const key of eventNameKeys({ name })) takenEvents.add(key);
  };
  for (const node of options.graph.nodes) {
    const key = eventKey(node);
    if (key !== undefined) presentEvents.add(key);
  }
  // Only the target's own nodes make a native event present; a parent's does not.
  // Each inherited custom event maps to the nearest ancestor that has it.
  const inheritedEvents = new Map<string, string>();
  for (const ancestor of ancestors) {
    for (const event of customEventsFromGraph(ancestor.graph)) {
      claimEvent(event.name);
      const inheritedKey = `${CUSTOM_EVENT}\0${event.name}`;
      if (!inheritedEvents.has(inheritedKey)) inheritedEvents.set(inheritedKey, ancestor.classId);
    }
  }
  for (const event of customEventsFromGraph(options.graph)) claimEvent(event.name);
  for (const slice of Object.values(options.graph.functionGraphs ?? {})) {
    for (const node of slice.nodes) {
      if (node.type === CUSTOM_EVENT) claimEvent(customEventName(node));
    }
  }

  const bounds = graphNodesBounds(options.graph.nodes);
  const cursor = bounds
    ? { x: bounds.x, y: bounds.y + bounds.height + NODE_PLACEMENT_GAP }
    : { x: 80, y: 80 };
  const placeEvent = (node: GraphNode, pins: ReadonlyArray<{ direction?: string }>): GraphNode => {
    const placed = { ...node, id: newId(), position: { x: cursor.x, y: cursor.y } };
    cursor.y += estimateGraphNodeSize([{ direction: "out" }, ...pins]).height + NODE_PLACEMENT_GAP;
    eventNodes.push(placed);
    return placed;
  };
  const customEvent = (name: string, pins: GraphClassMemberPin[]): void => {
    const node = placeEvent(
      {
        id: "",
        type: CUSTOM_EVENT,
        position: { x: 0, y: 0 },
        data: { title: formatEventTitle(name), name, pins, __nodeType: CUSTOM_EVENT },
      },
      pins,
    );
    claimEvent(name);
    added.push({ id: node.id, kind: "event", name, pins });
    pasted.push({ kind: "event", id: node.id, name });
  };

  for (const entry of clipboard.events) {
    const source = structuredClone(entry.node);
    const title = eventTitleForNotice(source);
    if (!eventsAllowed) {
      skipped.push({ kind: "event", name: title, reason: "kind" });
      continue;
    }
    if (source.type === CUSTOM_EVENT) {
      const pins = Array.isArray(source.data.pins) ? (source.data.pins as GraphClassMemberPin[]) : [];
      if (isComponentEvent(source)) {
        const name = uniqueEventName(componentCustomEventName(source), takenEvents);
        customEvent(name, pins);
        // Calls from a pasted function that target the component it came with end up here.
        const copyComponent = refs.pastedComponents.get(String(source.data.componentId))?.componentId;
        if (copyComponent) refs.pastedComponentEvents.set(`${copyComponent}\0${customEventName(source)}`, { name, pins });
        continue;
      }
      if (!entry.bound) {
        const name = uniqueEventName(customEventName(source), takenEvents);
        customEvent(name, pins);
        refs.pastedEventsByName.set(nameKey(entry.sourceClassId, customEventName(source)), {
          name,
          classId,
        });
        continue;
      }
      const key = eventKey(source);
      if (key !== undefined && presentEvents.has(key)) {
        skipped.push({ kind: "event", name: title, reason: "present" });
      } else if (
        source.data.eventQualifier === "Inherited" &&
        !inheritedEvents.has(`${CUSTOM_EVENT}\0${customEventName(source)}`)
      ) {
        skipped.push({ kind: "event", name: title, reason: "unavailable" });
      } else {
        if (key !== undefined) presentEvents.add(key);
        const node = placeEvent(source, pins);
        pasted.push({ kind: "event", id: node.id, name: customEventName(source) });
        // An override of an inherited event calls its parent's, like one added from the Events menu.
        const inheritedFrom = inheritedEvents.get(`${CUSTOM_EVENT}\0${customEventName(source)}`);
        if (source.data.eventQualifier === "Inherited" && inheritedFrom) {
          callParents.push({
            id: node.id,
            eventType: node.type,
            eventName: customEventName(source),
            parentClassId: inheritedFrom,
            pins,
          });
        }
      }
      continue;
    }
    const key = eventKey(source);
    if (
      isComponentEvent(source) ||
      !isScriptCatalogNodeAllowed(source.type, options.eventOptions) ||
      (key !== undefined && presentEvents.has(key))
    ) {
      // A native event the Class cannot have or already has, or that is bound to a component, is a
      // custom event that takes its outputs. The native event holds its own name, so its copy is the first duplicate of it.
      const base = nativeEventBaseName(source);
      customEvent(
        uniqueEventName(base, new Set([...takenEvents, ...eventNameKeys({ name: base })])),
        nativeEventOutputPins(source),
      );
      continue;
    }
    if (key !== undefined) presentEvents.add(key);
    const node = placeEvent(source, []);
    pasted.push({ kind: "event", id: node.id, name: title });
    // Like a Begin Play added by hand: a child's event replaces its parent's unless it calls it.
    if (
      parentClassId &&
      nativeEventStubs(options.eventOptions).some((stub) => stub.eventType === source.type)
    ) {
      callParents.push({ id: node.id, eventType: node.type, parentClassId });
    }
  }

  const functionGraphs: NonNullable<SerializedGraph["functionGraphs"]> = {};
  for (const fn of functions) {
    added.push(fn.member, ...fn.locals.values());
    functionGraphs[fn.member.id] = pastedFunctionGraph(fn, refs, newId);
  }

  if (pasted.length === 0) return { graph: options.graph, pasted, skipped };
  let graph: SerializedGraph = {
    ...options.graph,
    members: [...(options.graph.members ?? []), ...added],
    nodes: [...options.graph.nodes, ...eventNodes],
    ...(functions.length > 0
      ? { functionGraphs: { ...options.graph.functionGraphs, ...functionGraphs } }
      : {}),
    ...(components.length > 0 ? { components: [...target.local, ...components] } : {}),
  };
  for (const call of callParents) {
    graph = ensureCallParentForEvent(graph, {
      eventNodeId: call.id,
      eventType: call.eventType,
      ...(call.eventName ? { eventName: call.eventName } : {}),
      parentClassId: call.parentClassId,
      ...(call.pins ? { pins: call.pins } : {}),
    });
  }
  return { graph, pasted, skipped };
}

/** One sentence per reason for the members a paste left out, or null when it left out none. */
export function skippedMembersNotice(skipped: readonly SkippedClassMember[]): string | null {
  const sentences: string[] = [];
  const reasons: Array<[SkippedClassMember["reason"], (plural: boolean) => string]> = [
    ["kind", () => "can't be added to this Class."],
    ["unavailable", (plural) => `${plural ? "aren't" : "isn't"} available in this Class.`],
    ["present", (plural) => `${plural ? "are" : "is"} already in this graph.`],
    ["function", (plural) => `${plural ? "need" : "needs"} a function. Select or open one first.`],
  ];
  for (const [reason, tail] of reasons) {
    const names = skipped.filter((entry) => entry.reason === reason).map((entry) => entry.name);
    if (names.length > 0) sentences.push(`${joinNames(names)} ${tail(names.length > 1)}`);
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}
