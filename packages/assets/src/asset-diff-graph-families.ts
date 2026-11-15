import { titleForBtClassId } from "@haptic/behaviour-tree/catalog";
import { displayNodeTitle, humanizePropertyLabel, type GraphClassMember } from "@haptic/core";
import { particleNodeDefinitionFor, PARTICLE_PARAMETER_NODE_TYPE, PARTICLE_UNSUPPORTED_V1_TYPES } from "@haptic/particle-graph/catalog";
import { materialNodeDefinition } from "@haptic/shader-graph/catalog";
import { isMaterialParameterNode } from "@haptic/shader-graph/parameters";
import {
  diffGraphSources,
  type ComparedNode,
  type ComparedWire,
  type GraphDiff,
  type GraphMemberGroupId,
  type GraphSource,
  type GraphSourceMember,
  type GraphSourceSection,
} from "./asset-diff-graph";
import { formatDiffValue, isPlainObject } from "./asset-diff-values";

// Each graph family's stored document, read into the graphs, members and
// fields the diff compares. Only what the family's catalog says is looked up
// (node titles, pin names); everything else is read as stored.

type Plain = Record<string, unknown>;
type StoredGraph = { nodes: unknown[]; edges: unknown[] };

const EVENT_GRAPH = "event";
/** A Material, Particle Graph or Behaviour Tree draws one graph. */
const MAIN_GRAPH = "graph";
const SCRIPT_SKIP = new Set(["nodes", "edges", "members", "functionGraphs"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function list(value: unknown): Plain[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function position(value: unknown): { x: number; y: number } | undefined {
  return isPlainObject(value) && typeof value.x === "number" && typeof value.y === "number" ? { x: value.x, y: value.y } : undefined;
}

function storedGraph(value: unknown): StoredGraph | null {
  return isPlainObject(value) && Array.isArray(value.nodes) && Array.isArray(value.edges) ? (value as StoredGraph) : null;
}

/** Every field but `skip`. */
function fieldsOf(document: Plain, skip: ReadonlySet<string>): Plain {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !skip.has(key)));
}

function without(row: Plain, key: string): Plain {
  return fieldsOf(row, new Set([key]));
}

function typeLabel(typeId: unknown, container?: unknown): string {
  const type = typeof typeId === "string" && typeId !== "" ? humanizePropertyLabel(typeId) : "";
  if (container === "array") return `${type} Array`;
  if (container === "map") return `${type} Map`;
  return type;
}

/** `Float · 1.5`, or the type alone without a default. */
function typedSummary(type: string, value: unknown, key: string): string {
  return value === undefined ? type : `${type} · ${formatDiffValue(value, key)}`;
}

// Script graphs: Classes, Scene Scripts and an Animation Graph's state, rule and Animation Object graphs.

/** A script node's canvas title, as the graph editor draws it. */
export function graphNodeTitle(node: { type: string; data: Plain }): string {
  const data = node.data;
  const nodeType = typeof data.__nodeType === "string" ? data.__nodeType : node.type;
  return displayNodeTitle(nodeType, typeof data.title === "string" ? data.title : undefined, typeof data.eventQualifier === "string" ? data.eventQualifier : undefined);
}

function scriptSection(id: string, title: string, graph: StoredGraph): GraphSourceSection {
  const nodes: ComparedNode[] = list(graph.nodes).map((node) => {
    const data = isPlainObject(node.data) ? node.data : {};
    const type = String(node.type ?? "");
    return { id: String(node.id), type, position: position(node.position), data, title: graphNodeTitle({ type, data }) };
  });
  const edges: ComparedWire[] = list(graph.edges).map((edge) => ({
    id: String(edge.id),
    source: String(edge.source),
    target: String(edge.target),
    ...(typeof edge.sourceHandle === "string" ? { sourceHandle: edge.sourceHandle } : {}),
    ...(typeof edge.targetHandle === "string" ? { targetHandle: edge.targetHandle } : {}),
  }));
  return { id, title, canvas: "script", nodes, edges, stored: { nodes: graph.nodes, edges: graph.edges } };
}

const SCRIPT_MEMBER_GROUP: Partial<Record<string, GraphMemberGroupId>> = { variable: "variables", function: "functions" };

function scriptMember(member: GraphClassMember): GraphSourceMember {
  const entry: GraphSourceMember = { id: member.id, name: member.name, group: SCRIPT_MEMBER_GROUP[member.kind] ?? "others", kind: member.kind, value: member };
  if (member.kind === "variable") entry.summary = typedSummary(typeLabel(member.typeId, member.container), member.defaultValue, member.name);
  return entry;
}

/** The Event Graph (`event`, or `eventId`) and each function's graph, with the members the script declares. */
function scriptGraphs(graph: StoredGraph & { members?: unknown; functionGraphs?: unknown }, eventId: string, eventTitle: string): Pick<GraphSource, "sections" | "members"> {
  const members = list(graph.members) as unknown as GraphClassMember[];
  const name = new Map(members.map((member) => [member.id, member.name]));
  const sections = [scriptSection(eventId, eventTitle, graph)];
  if (isPlainObject(graph.functionGraphs)) {
    for (const [id, value] of Object.entries(graph.functionGraphs)) {
      const fn = storedGraph(value);
      if (fn) sections.push(scriptSection(id, name.get(id) ?? id, fn));
    }
  }
  return { sections, members: members.map(scriptMember) };
}

/** A Class, a Scene Script or any other document storing a script's `nodes` and `edges`. */
export function scriptGraphSource(document: Plain): GraphSource | null {
  const graph = storedGraph(document);
  if (!graph) return null;
  return { ...scriptGraphs(graph, EVENT_GRAPH, "Event Graph"), items: [], fields: fieldsOf(document, SCRIPT_SKIP) };
}

// Material, Material Function and Particle Graph: `properties` per node, wires by `sourceNodeId` / `sourcePinId`.

function pinGraphWires(edges: unknown): ComparedWire[] {
  return list(edges).map((edge) => ({
    id: String(edge.id),
    source: String(edge.sourceNodeId),
    target: String(edge.targetNodeId),
    sourceHandle: String(edge.sourcePinId ?? ""),
    targetHandle: String(edge.targetPinId ?? ""),
  }));
}

function pinNames(pins: ReadonlyArray<{ id: string; name: string }> | undefined): ReadonlyMap<string, string> | undefined {
  return pins ? new Map(pins.map((pin) => [pin.id, pin.name])) : undefined;
}

function materialNode(node: Plain): ComparedNode {
  const type = String(node.type ?? "");
  const data = isPlainObject(node.properties) ? node.properties : {};
  const definition = materialNodeDefinition(type);
  const named = isMaterialParameterNode(type) ? text(data.name) : undefined;
  const entry: ComparedNode = { id: String(node.id), type, position: position(node.position), data, title: named ?? definition?.title ?? type };
  const names = pinNames(definition?.inputs);
  if (names) entry.pinNames = names;
  return entry;
}

function functionPinMember(pin: Plain, group: "inputs" | "outputs"): GraphSourceMember {
  const id = String(pin.id);
  const name = text(pin.name) ?? id;
  return { id: `${group}:${id}`, name, group, kind: group === "inputs" ? "input" : "output", value: pin, summary: typedSummary(typeLabel(pin.type), pin.defaultValue, name) };
}

/** A Material or Material Function: its graph, a function's Inputs and Outputs, and its settings. */
export function materialGraphSource(document: Plain): GraphSource | null {
  if (!Array.isArray(document.nodes)) return null;
  const section: GraphSourceSection = { id: MAIN_GRAPH, title: "Graph", canvas: "material", nodes: list(document.nodes).map(materialNode), edges: pinGraphWires(document.edges), stored: document };
  const members = [...list(document.inputs).map((pin) => functionPinMember(pin, "inputs")), ...list(document.outputs).map((pin) => functionPinMember(pin, "outputs"))];
  return { sections: [section], members, items: [], fields: fieldsOf(document, new Set(["nodes", "edges", "inputs", "outputs"])) };
}

/** A Particle Graph: its graph, its Parameters and its settings. */
export function particleGraphSource(document: Plain): GraphSource | null {
  if (!Array.isArray(document.nodes)) return null;
  const parameters = list(document.parameters);
  const parameterName = new Map(parameters.map((parameter) => [String(parameter.id), text(parameter.name)]));
  const nodes = list(document.nodes).map((node): ComparedNode => {
    const type = String(node.type ?? "");
    const data = isPlainObject(node.properties) ? node.properties : {};
    const definition = particleNodeDefinitionFor({ type, properties: data });
    const named = type === PARTICLE_PARAMETER_NODE_TYPE ? parameterName.get(String(data.parameterId ?? "")) : undefined;
    const entry: ComparedNode = { id: String(node.id), type, position: position(node.position), data, title: named ?? definition?.title ?? PARTICLE_UNSUPPORTED_V1_TYPES[type] ?? type };
    const names = pinNames(definition?.inputs);
    if (names) entry.pinNames = names;
    return entry;
  });
  const section: GraphSourceSection = { id: MAIN_GRAPH, title: "Graph", canvas: "particle", nodes, edges: pinGraphWires(document.edges), stored: document };
  const members = parameters.map((parameter): GraphSourceMember => {
    const name = text(parameter.name) ?? String(parameter.id);
    return { id: String(parameter.id), name, group: "parameters", kind: "parameter", value: parameter, summary: typedSummary(typeLabel(parameter.type), parameter.defaultValue, name) };
  });
  return { sections: [section], members, items: [], fields: fieldsOf(document, new Set(["nodes", "edges", "parameters"])) };
}

// Behaviour Tree: a node per tree node, a wire per parent-to-child link.

/** As the editor names a tree wire (`btEdgeId`), which the canvas draws. */
function treeWireId(parentId: string, childId: string): string {
  return `bt-${parentId}-${childId}`;
}

/**
 * A Behaviour Tree: its nodes (kind, decorators, services and the task's
 * settings) and links, the editor's stored positions, and its other fields.
 */
export function behaviourTreeSource(document: Plain): GraphSource | null {
  if (!Array.isArray(document.nodes)) return null;
  const positions = isPlainObject(document.editorPositions) ? document.editorPositions : {};
  const stored = list(document.nodes);
  const nodes = stored.map((node): ComparedNode => {
    const id = String(node.id);
    const classId = String(node.classId ?? "");
    const placed = position(positions[id]);
    return {
      id,
      type: "bt.node",
      ...(placed ? { position: placed } : {}),
      data: { kind: node.kind, classId, decorators: node.decorators ?? [], services: node.services ?? [], properties: node.properties ?? {} },
      title: titleForBtClassId(classId),
    };
  });
  const edges = stored.flatMap((node) => (Array.isArray(node.children) ? node.children : []).map((child): ComparedWire => ({
    id: treeWireId(String(node.id), String(child)),
    source: String(node.id),
    target: String(child),
    sourceHandle: "children",
    targetHandle: "parent",
  })));
  const section: GraphSourceSection = { id: MAIN_GRAPH, title: "Graph", canvas: "behaviour-tree", nodes, edges, stored: document };
  return { sections: [section], members: [], items: [], fields: fieldsOf(document, new Set(["nodes", "editorPositions"])) };
}

// Animation Graph: the State Machine, each state's and each rule's graph, and the Animation Object script.

const MACHINE_GRAPH = "machine";
const ANIMATION_OBJECT = "object";

/** A stored transition's settings: what is left without its ends and its rule graph. */
function transitionSettings(transition: Plain): Plain {
  return fieldsOf(transition, new Set(["id", "fromStateId", "toStateId", "ruleGraph"]));
}

/**
 * An Animation Graph: the State Machine (states and State Aliases as nodes,
 * transitions as wires), each state's graph, each transition's rule, the
 * Animation Object's graphs; its Variables and the Animation Object's
 * members; each transition's settings when they changed.
 */
export function animGraphSource(document: Plain): GraphSource | null {
  const machine = isPlainObject(document.stateMachine) ? document.stateMachine : null;
  if (!machine) return null;
  const states = list(machine.states);
  const aliases = list(machine.aliases);
  const transitions = list(machine.transitions);
  const entryStateId = machine.entryStateId;
  const nameOf = new Map([...states, ...aliases].map((row) => [String(row.id), text(row.name) ?? String(row.id)]));
  const transitionTitle = (transition: Plain) => `${nameOf.get(String(transition.fromStateId)) ?? String(transition.fromStateId)} To ${nameOf.get(String(transition.toStateId)) ?? String(transition.toStateId)}`;

  const machineNodes: ComparedNode[] = [
    ...states.map((state): ComparedNode => {
      const id = String(state.id);
      const data: Plain = { name: state.name, entry: id === entryStateId };
      if (state.events !== undefined) data.events = state.events;
      return { id, type: "anim.state", position: position(state.position), data, title: nameOf.get(id)! };
    }),
    ...aliases.map((alias): ComparedNode => {
      const id = String(alias.id);
      return { id, type: "anim.alias", position: position(alias.position), data: { name: alias.name, anyState: alias.anyState, stateIds: alias.stateIds ?? [] }, title: nameOf.get(id)! };
    }),
  ];
  const machineWires = transitions.map((transition): ComparedWire => ({
    id: String(transition.id),
    source: String(transition.fromStateId),
    target: String(transition.toStateId),
    ...(typeof transition.sourceHandle === "string" ? { sourceHandle: transition.sourceHandle } : {}),
    ...(typeof transition.targetHandle === "string" ? { targetHandle: transition.targetHandle } : {}),
  }));
  // The machine's canvas draws states and transitions; their graphs are their own sections.
  const lightMachine = { ...machine, states: states.map((state) => without(state, "stateGraph")), transitions: transitions.map((transition) => without(transition, "ruleGraph")) };
  const sections: GraphSourceSection[] = [{ id: MACHINE_GRAPH, title: "State Machine", canvas: "state-machine", nodes: machineNodes, edges: machineWires, stored: { stateMachine: lightMachine } }];
  for (const state of states) {
    const graph = storedGraph(state.stateGraph);
    if (graph) sections.push(scriptSection(`state:${String(state.id)}`, nameOf.get(String(state.id))!, graph));
  }
  for (const transition of transitions) {
    const graph = storedGraph(transition.ruleGraph);
    if (graph) sections.push(scriptSection(`rule:${String(transition.id)}`, transitionTitle(transition), graph));
  }
  const members: GraphSourceMember[] = list(document.variables).map((variable) => {
    const name = text(variable.name) ?? String(variable.id);
    return { id: String(variable.id), name, group: "variables", kind: "variable", value: variable, summary: typedSummary(typeLabel(variable.typeId), variable.defaultValue, name) };
  });
  const object = storedGraph(document.animationObject);
  if (object) {
    const script = scriptGraphs(object, ANIMATION_OBJECT, "Animation Object");
    sections.push(...script.sections);
    members.push(...script.members);
  }
  const items = transitions.map((transition) => ({ id: `transition:${String(transition.id)}`, title: transitionTitle(transition), value: transitionSettings(transition) }));
  return { sections, members, items, fields: fieldsOf(document, new Set(["stateMachine", "animationObject", "variables"])) };
}

const READERS: Partial<Record<string, (document: Plain) => GraphSource | null>> = {
  Material: materialGraphSource,
  MaterialFunction: materialGraphSource,
  ParticleGraph: particleGraphSource,
  BehaviourTree: behaviourTreeSource,
  AnimationGraph3D: animGraphSource,
  AnimationGraph2D: animGraphSource,
};

/** Whether a version of an asset of `type` diffs as graphs: a graph family's, or any document storing a script's `nodes` and `edges`. */
export function isGraphDocument(type: string, document: unknown): boolean {
  return READERS[type] !== undefined || storedGraph(document) !== null;
}

/** Two versions of a graph document of `type` (a script's without one, as a Scene stores its own), compared graph by graph. */
export function diffGraphDocuments(base: unknown, compare: unknown, type = ""): GraphDiff {
  const read = READERS[type] ?? scriptGraphSource;
  return diffGraphSources(isPlainObject(base) ? read(base) : null, isPlainObject(compare) ? read(compare) : null);
}
