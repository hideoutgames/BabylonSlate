/**
 * Convert to Math Expression and Convert to Math Nodes: one Math Expression node for a selection of
 * ordinary math nodes, and the ordinary nodes for a Math Expression node. Both read the one table in
 * `@haptic/scripting-nodes` (`MATH_EXPRESSION_NODE_TABLE`), so a construct and its node never drift
 * apart, and both are a single graph change (one undo step).
 */
import type { SerializedGraph } from "@haptic/core";
import {
  analyzeMathExpression,
  isMathReservedName,
  isMathType,
  MATH_EXPRESSION_NODE_ID,
  MATH_TYPE_AXES,
  mathExpressionInputPinId,
  mathExpressionInputType,
  mathExpressionNodeState,
  mathExpressionOutputPinId,
  mathTypeOfPinType,
  pinDefaultPropertyKey,
  type GraphPin,
  type MathType,
  type NodeRegistry,
} from "@haptic/scripting";
import { MATH_EXPRESSION_NODE_TABLE, mathExpressionNodePlan, type MathNodeEntry } from "@haptic/scripting-nodes";
import { catalogTypeId } from "../services/graph-node-refresh";

type Node = SerializedGraph["nodes"][number];
type Edge = SerializedGraph["edges"][number];

const ENTRY_BY_TYPE = new Map<string, MathNodeEntry>();
for (const entry of MATH_EXPRESSION_NODE_TABLE) if (!ENTRY_BY_TYPE.has(entry.typeId)) ENTRY_BY_TYPE.set(entry.typeId, entry);

function pinsOf(node: Node, registry: NodeRegistry): GraphPin[] {
  if (Array.isArray(node.data.__pins)) return node.data.__pins as GraphPin[];
  const properties = { ...node.data };
  delete properties.__pins;
  delete properties.__nodeType;
  return registry.get(catalogTypeId(node))?.pins(properties) ?? [];
}

/** Whether `node` is an ordinary math node a formula expresses exactly: in the table, Float and vector pins only, enabled. */
export function isFormulaExpressibleNode(node: Node, registry: NodeRegistry): boolean {
  if (node.data.__disabled === true) return false;
  if (!ENTRY_BY_TYPE.has(catalogTypeId(node))) return false;
  const pins = pinsOf(node, registry);
  return pins.length > 0 && pins.every((pin) => pin.kind === "data" && isMathType(pin.type.kind));
}

/** Convert to Math Expression applies to the selection: every node is an expressible math node. */
export function canConvertToMathExpression(graph: SerializedGraph, nodeIds: readonly string[], registry: NodeRegistry): boolean {
  if (nodeIds.length === 0) return false;
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return nodeIds.every((id) => {
    const node = byId.get(id);
    return node !== undefined && isFormulaExpressibleNode(node, registry);
  });
}

// ---------------------------------------------------------------------------------------------
// Nodes to formula.

type Printed = { text: string; prec: number };
const ATOM = 5;
const POWER = 4;
const UNARY = 3;
const PRODUCT = 2;
const SUM = 1;
const atom = (text: string): Printed => ({ text, prec: ATOM });
const wrap = (value: Printed, min: number) => value.prec >= min ? value.text : `(${value.text})`;

function printNumber(value: number): Printed | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (Object.is(value, -0)) return { text: "-0", prec: UNARY };
  return value < 0 ? { text: `-${String(-value)}`, prec: UNARY } : atom(String(value));
}

function printLiteral(value: unknown, type: MathType): Printed | undefined {
  if (type === "float") return printNumber(typeof value === "number" ? value : 0);
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parts = MATH_TYPE_AXES[type].map((axis) => printNumber(typeof record[axis] === "number" ? record[axis] as number : 0));
  if (parts.some((part) => !part)) return undefined;
  return atom(`${type}(${parts.map((part) => part!.text).join(", ")})`);
}

const OPERATORS: Readonly<Record<string, number>> = { "+": SUM, "-": SUM, "*": PRODUCT, "/": PRODUCT, "%": PRODUCT, "^": POWER };

function printConstruct(entry: MathNodeEntry, args: Printed[]): Printed {
  const op = OPERATORS[entry.construct];
  if (op === POWER) return { text: `${wrap(args[0]!, ATOM)}^${wrap(args[1]!, UNARY)}`, prec: POWER };
  if (op !== undefined) return { text: `${wrap(args[0]!, op)} ${entry.construct} ${wrap(args[1]!, op + 1)}`, prec: op };
  if (entry.construct === "neg") return { text: `-${wrap(args[0]!, POWER)}`, prec: UNARY };
  if (entry.construct === "literal") return args[0]!;
  return atom(`${entry.construct}(${args.map((arg) => arg.text).join(", ")})`);
}

/** A formula name from a display name: lower camel case, a letter first, never a built-in or taken name. */
function variableName(base: string, taken: Set<string>): string {
  const words = base.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  let name = words.map((word, index) => index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)).join("");
  if (!name) name = "value";
  if (!/^[A-Za-z_]/.test(name)) name = `v${name}`;
  name = name.slice(0, 48);
  // A node named for its function (Clamp, Lerp) would take the function's name.
  if (isMathReservedName(name)) name = `${name}Result`;
  let candidate = name;
  for (let index = 2; isMathReservedName(candidate) || taken.has(candidate); index++) candidate = `${name}${index}`;
  taken.add(candidate);
  return candidate;
}

function nodeTitle(node: Node, registry: NodeRegistry): string {
  if (typeof node.data.variableName === "string" && node.data.variableName) return node.data.variableName;
  if (typeof node.data.title === "string" && node.data.title) return node.data.title;
  return registry.get(catalogTypeId(node))?.title ?? "value";
}

/** One Math Expression node computing what the selection computes; null when it cannot be expressed. */
export function convertToMathExpression(
  graph: SerializedGraph,
  nodeIds: readonly string[],
  registry: NodeRegistry,
  newId: string,
): SerializedGraph | null {
  if (!canConvertToMathExpression(graph, nodeIds, registry)) return null;
  const selected = new Set(nodeIds);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const nodes = nodeIds.map((id) => byId.get(id)!);
  const into = new Map<string, Edge>();
  const outOf = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    into.set(`${edge.target}\u0000${edge.targetHandle ?? ""}`, edge);
    const key = `${edge.source}\u0000${edge.sourceHandle ?? ""}`;
    outOf.set(key, [...(outOf.get(key) ?? []), edge]);
  }
  // Order: each node after the selected nodes it reads.
  const order: Node[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: Node): boolean => {
    const seen = state.get(node.id);
    if (seen === "done") return true;
    if (seen === "visiting") return false;
    state.set(node.id, "visiting");
    for (const edge of graph.edges) {
      if (edge.target === node.id && selected.has(edge.source) && !visit(byId.get(edge.source)!)) return false;
    }
    state.set(node.id, "done");
    order.push(node);
    return true;
  };
  if (!nodes.every(visit)) return null;

  const taken = new Set<string>();
  const inputs: Array<{ name: string; source: Edge; type: MathType | undefined }> = [];
  const inputBySource = new Map<string, string>();
  const statements: string[] = [];
  const values = new Map<string, Printed>();
  const externalOutputs: Array<{ key: string; name: string; edges: Edge[] }> = [];
  const consumers = (nodeId: string, pinId: string) => outOf.get(`${nodeId}\u0000${pinId}`) ?? [];
  const internalUses = (nodeId: string, pinId: string) => consumers(nodeId, pinId).filter((edge) => selected.has(edge.target)).length;
  const externalUses = (nodeId: string, pinId: string) => consumers(nodeId, pinId).filter((edge) => !selected.has(edge.target));
  // A Break node reading several components of a computed vector reads it from one named value.
  const forceShared = new Set<string>();
  for (const node of nodes) {
    if (ENTRY_BY_TYPE.get(catalogTypeId(node))?.construct !== "member") continue;
    const used = ["x", "y", "z", "w"].filter((axis) => consumers(node.id, axis).length > 0).length;
    const source = into.get(`${node.id}\u0000in`);
    if (used > 1 && source && selected.has(source.source)) forceShared.add(`${source.source}\u0000${source.sourceHandle ?? ""}`);
  }
  const sinks = nodes.filter((node) => pinsOf(node, registry).every((pin) => pin.direction !== "out" || internalUses(node.id, pin.id) === 0));
  const anyExternal = nodes.some((node) => pinsOf(node, registry).some((pin) => pin.direction === "out" && externalUses(node.id, pin.id).length > 0));

  for (const node of order) {
    const entry = ENTRY_BY_TYPE.get(catalogTypeId(node))!;
    const pins = pinsOf(node, registry);
    const args: Printed[] = [];
    for (const pinId of entry.args) {
      const pin = pins.find((candidate) => candidate.id === pinId && candidate.direction === "in");
      if (!pin) continue;
      const edge = into.get(`${node.id}\u0000${pinId}`);
      if (edge && selected.has(edge.source)) {
        const value = values.get(`${edge.source}\u0000${edge.sourceHandle ?? ""}`);
        if (!value) return null;
        args.push(value);
      } else if (edge) {
        const key = `${edge.source}\u0000${edge.sourceHandle ?? ""}`;
        let name = inputBySource.get(key);
        if (!name) {
          const source = byId.get(edge.source);
          const sourcePins = source ? pinsOf(source, registry) : [];
          const outputs = sourcePins.filter((candidate) => candidate.direction === "out");
          const sourcePin = sourcePins.find((candidate) => candidate.id === edge.sourceHandle);
          const title = source ? nodeTitle(source, registry) : "value";
          name = variableName(outputs.length > 1 && sourcePin && !source?.data.variableName ? `${title} ${sourcePin.name}` : title, taken);
          inputBySource.set(key, name);
          // The reading pin's type: an Integer source into a Float pin is a Float.
          inputs.push({ name, source: edge, type: mathTypeOfPinType(pin.type) });
        }
        args.push(atom(name));
      } else {
        const stored = node.data[pinDefaultPropertyKey(pinId)];
        const literal = printLiteral(stored !== undefined ? stored : pin.defaultValue, pin.type.kind as MathType);
        if (!literal) return null;
        args.push(literal);
      }
    }
    const outputs = entry.construct === "member"
      ? MATH_TYPE_AXES[pins.find((pin) => pin.id === "in")!.type.kind as MathType].map((axis) => [axis, atom(`${wrap(args[0]!, ATOM)}.${axis}`)] as const)
      : [[entry.out, printConstruct(entry, args)] as const];
    for (const [pinId, printed] of outputs) {
      const key = `${node.id}\u0000${pinId}`;
      const external = externalUses(node.id, pinId);
      const isSink = !anyExternal && sinks.includes(node);
      if (external.length > 0 || isSink) {
        const pin = pins.find((candidate) => candidate.id === pinId);
        const name = variableName(outputs.length > 1 ? `${nodeTitle(node, registry)} ${pin?.name ?? pinId}` : nodeTitle(node, registry), taken);
        statements.push(`${name} = ${printed.text}`);
        values.set(key, atom(name));
        externalOutputs.push({ key, name, edges: external });
      } else if (internalUses(node.id, pinId) > 1 || (forceShared.has(key) && printed.prec < ATOM)) {
        const name = variableName(nodeTitle(node, registry), taken);
        statements.push(`let ${name} = ${printed.text}`);
        values.set(key, atom(name));
      } else {
        values.set(key, printed);
      }
    }
  }

  const formula = statements.join("\n");
  const wiredInputTypes = Object.fromEntries(inputs.flatMap((input) => input.type ? [[input.name, input.type]] : []));
  const typeOf = (name: string) => Object.hasOwn(wiredInputTypes, name) ? wiredInputTypes[name] as MathType : undefined;
  const analyzed = analyzeMathExpression(formula, typeOf);
  if (!analyzed.ok || analyzed.analysis.typeError) return null;

  const center = nodes.reduce((sum, node) => ({ x: sum.x + node.position.x / nodes.length, y: sum.y + node.position.y / nodes.length }), { x: 0, y: 0 });
  const mathNode: Node = {
    id: newId,
    type: MATH_EXPRESSION_NODE_ID,
    position: { x: Math.round(center.x), y: Math.round(center.y) },
    data: { formula, ...(inputs.length > 0 ? { wiredInputTypes } : {}) },
  };
  const edges: Edge[] = graph.edges.filter((edge) => !selected.has(edge.source) && !selected.has(edge.target));
  for (const input of inputs) {
    edges.push({ id: `${newId}:${input.name}`, source: input.source.source, sourceHandle: input.source.sourceHandle,
      target: newId, targetHandle: mathExpressionInputPinId(input.name) });
  }
  for (const output of externalOutputs) {
    for (const edge of output.edges) edges.push({ ...edge, source: newId, sourceHandle: mathExpressionOutputPinId(output.name) });
  }
  return { ...graph, nodes: [...graph.nodes.filter((node) => !selected.has(node.id)), mathNode], edges };
}

// ---------------------------------------------------------------------------------------------
// Formula to nodes.

/** Why Convert to Math Nodes cannot run on `node`, or null when it can. */
export function mathNodesConversionRefusal(node: Node): string | null {
  if (catalogTypeId(node) !== MATH_EXPRESSION_NODE_ID) return "Not a Math Expression";
  const state = mathExpressionNodeState(node.data);
  if (state.error || !state.analysis) return "The formula has errors";
  if (state.analysis.signature.outputs.length === 0) return "The formula has no outputs";
  return null;
}

const COLUMN = 380;
const ROW = 170;

/**
 * The ordinary nodes for a Math Expression node: one per operation, laid out left to right by
 * depth around the node's position, with its wires reconnected and unwired inputs' values as the
 * reading pins' defaults. `newId(index)` names the plan's nodes. Null when it cannot convert.
 */
export function convertMathExpressionToNodes(
  graph: SerializedGraph,
  nodeId: string,
  newId: (index: number) => string,
): SerializedGraph | null {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node || mathNodesConversionRefusal(node)) return null;
  const analysis = mathExpressionNodeState(node.data).analysis!;
  const plan = mathExpressionNodePlan(analysis);
  // Only what an output reads.
  const keep = new Set<number>();
  const mark = (index: number) => {
    if (keep.has(index)) return;
    keep.add(index);
    for (const source of Object.values(plan.nodes[index]!.inputs)) if (source.kind === "node") mark(source.node);
  };
  for (const output of plan.outputs) if (output.kind === "node") mark(output.node);
  const depth = new Map<number, number>();
  const depthOf = (index: number): number => {
    const known = depth.get(index);
    if (known !== undefined) return known;
    const sources = Object.values(plan.nodes[index]!.inputs).filter((source) => source.kind === "node");
    const value = sources.length === 0 ? 0 : 1 + Math.max(...sources.map((source) => depthOf((source as { node: number }).node)));
    depth.set(index, value);
    return value;
  };
  const kept = [...keep].sort((a, b) => a - b);
  const columns = new Map<number, number[]>();
  for (const index of kept) columns.set(depthOf(index), [...(columns.get(depthOf(index)) ?? []), index]);
  const maxDepth = Math.max(0, ...columns.keys());
  const ids = new Map(kept.map((index, order) => [index, newId(order)] as const));
  const { inputs, outputs } = analysis.signature;
  const inputEdge = (name: string) => graph.edges.find((edge) => edge.target === nodeId && edge.targetHandle === mathExpressionInputPinId(name));
  const inputValue = (index: number): unknown => {
    const name = inputs[index]!.name;
    const stored = node.data[pinDefaultPropertyKey(mathExpressionInputPinId(name))];
    if (stored !== undefined) return stored;
    const type = mathExpressionInputType(node.data, name);
    return type === "float" ? 0 : Object.fromEntries(MATH_TYPE_AXES[type].map((axis) => [axis, 0]));
  };
  const newNodes: Node[] = [];
  const newEdges: Edge[] = [];
  for (const [column, members] of columns) {
    members.forEach((index, row) => {
      const planned = plan.nodes[index]!;
      const data: Record<string, unknown> = { ...planned.properties };
      for (const [pinId, source] of Object.entries(planned.inputs)) {
        if (source.kind === "node") {
          newEdges.push({ id: `${ids.get(index)}:${pinId}`, source: ids.get(source.node)!, sourceHandle: source.pin, target: ids.get(index)!, targetHandle: pinId });
        } else if (source.kind === "input") {
          const wire = inputEdge(inputs[source.index]!.name);
          if (wire) newEdges.push({ id: `${ids.get(index)}:${pinId}`, source: wire.source, sourceHandle: wire.sourceHandle, target: ids.get(index)!, targetHandle: pinId });
          else data[pinDefaultPropertyKey(pinId)] = inputValue(source.index);
        }
      }
      newNodes.push({
        id: ids.get(index)!,
        type: planned.typeId,
        position: {
          x: Math.round(node.position.x + (column - maxDepth / 2) * COLUMN),
          y: Math.round(node.position.y + (row - (members.length - 1) / 2) * ROW),
        },
        data,
      });
    });
  }
  const edges = graph.edges.filter((edge) => edge.target !== nodeId && edge.source !== nodeId);
  for (const edge of graph.edges) {
    if (edge.source !== nodeId) continue;
    const index = outputs.findIndex((output) => mathExpressionOutputPinId(output.name) === edge.sourceHandle);
    const source = plan.outputs[index];
    if (!source || source.kind !== "node") continue;
    edges.push({ ...edge, source: ids.get(source.node)!, sourceHandle: source.pin });
  }
  return { ...graph, nodes: [...graph.nodes.filter((entry) => entry.id !== nodeId), ...newNodes], edges: [...edges, ...newEdges] };
}
