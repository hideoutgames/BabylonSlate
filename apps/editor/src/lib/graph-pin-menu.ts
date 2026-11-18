/**
 * The Script graph host's items in a pin's menu (`GraphEditor.contextMenuItemsForPin`, after the
 * canvas's own Break Links), and the Add Pin control's action. Each builds the whole next graph, so
 * the host commits it as one change (one Undo step).
 */
import type { SerializedGraph } from "@haptic/core";
import type { NestedMenuItem } from "@haptic/editor-kit";
import { hasSerializedPins } from "@haptic/graph-ui";
import { pinTypeKey, resolveWildcardPinTypes, type PinType, type WildcardPin } from "@haptic/scripting";
import {
  isNumericOperandType,
  numericOperandChoices,
  numericOperands,
  numericOperandType,
  numericOperandTypeName,
  numericOperandTypeOf,
  numericOperandTypePatch,
  type NumericOperandType,
} from "@haptic/scripting-nodes";
import { catalogTypeId } from "../services/graph-node-refresh";
import { addPinPatch, pinListEntryIndex, removePinListEntry } from "./graph-pin-lists";
import { wiredSource, type WireEnd } from "./reroute-wires";

type GraphNode = SerializedGraph["nodes"][number];

/** `graph` with `patch` merged into one node's data; an undefined value removes its key. */
function withNodeData(graph: SerializedGraph, nodeId: string, patch: Record<string, unknown>): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const data: Record<string, unknown> = { ...node.data, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete data[key];
      return { ...node, data };
    }),
  };
}

/** The graph after the node's Add Pin, or null when it has no growable list or is at its maximum. */
export function addPinToNode(graph: SerializedGraph, nodeId: string): SerializedGraph | null {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  const patch = node ? addPinPatch(catalogTypeId(node), node.data) : null;
  return patch ? withNodeData(graph, nodeId, patch) : null;
}

/** The type a wire end carries, with a wildcard resolved by the wires around it. */
function wireEndType(graph: SerializedGraph, end: WireEnd): PinType | undefined {
  const pinsOf = (node: GraphNode | undefined): WildcardPin[] =>
    hasSerializedPins(node?.data) ? (node.data.__pins as WildcardPin[]) : [];
  const type = pinsOf(graph.nodes.find((node) => node.id === end.nodeId)).find((pin) => pin.id === end.pinId)?.type;
  if (type?.kind !== "resolvingWildcard") return type;
  return resolveWildcardPinTypes({
    nodes: graph.nodes.map((node) => ({ id: node.id, pins: pinsOf(node) })),
    edges: graph.edges.map((edge) => ({
      sourceNodeId: edge.source, sourcePinId: edge.sourceHandle ?? "",
      targetNodeId: edge.target, targetPinId: edge.targetHandle ?? "",
    })),
  }).resolved.get(pinTypeKey(end.nodeId, end.pinId));
}

/**
 * **Convert Pin** on a math operand: the types the operand may take, the current one checked. A
 * wired operand offers only what its wire keeps (the wire's type, and Float for an Integer wire),
 * so the pick is not retyped back; nothing to choose leaves the submenu out.
 */
function convertPinItem(
  graph: SerializedGraph,
  node: GraphNode,
  typeId: string,
  pinId: string,
  commit: (next: SerializedGraph) => void,
): NestedMenuItem | null {
  const operands = numericOperands(typeId);
  const index = operands.findIndex((operand) => operand.pinId === pinId);
  const operand = operands[index];
  if (!operand) return null;
  const other = operands.length === 2 ? operands[1 - index] : undefined;
  const current = numericOperandType(node.data, operand.property);
  let choices = numericOperandChoices(typeId, other ? numericOperandType(node.data, other.property) : undefined);
  const source = wiredSource(graph, node.id, pinId);
  if (source) {
    const wire = numericOperandTypeOf(wireEndType(graph, source));
    const kept: readonly NumericOperandType[] = wire === "int" ? ["int", "float"] : wire ? [wire] : [];
    choices = choices.filter((type) => kept.includes(type));
  }
  if (choices.length === 0 || (choices.length === 1 && choices[0] === current)) return null;
  return {
    type: "submenu",
    id: "convert-pin",
    label: "Convert Pin",
    testId: "graph-pin-convert",
    items: [{
      type: "radio-group",
      id: "convert-pin-type",
      value: current,
      closeOnClick: true,
      onValueChange: (value) => {
        if (value === current || !isNumericOperandType(value)) return;
        commit(withNodeData(graph, node.id, numericOperandTypePatch(operand, value)));
      },
      items: choices.map((type) => ({
        id: type,
        value: type,
        label: numericOperandTypeName(type),
        testId: `graph-pin-convert-${type}`,
      })),
    }],
  };
}

/**
 * A Script graph pin's host menu items, in order: **Convert Pin** (math operands), **Add Pin** (any
 * pin of a node whose growable list is below its maximum) and **Remove Pin** (a pin of that list,
 * above its minimum: the entry goes and later ones move down with their wires and values).
 * `graph` is the graph as the canvas shows it (hydrated pins); `commit` takes the whole next graph.
 */
export function scriptPinMenuItems(
  graph: SerializedGraph,
  nodeId: string,
  pinId: string,
  commit: (next: SerializedGraph) => void,
): NestedMenuItem[] {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const typeId = catalogTypeId(node);
  const items: NestedMenuItem[] = [];
  const convert = convertPinItem(graph, node, typeId, pinId, commit);
  if (convert) items.push(convert);
  const added = addPinToNode(graph, nodeId);
  if (added) items.push({ id: "add-pin", label: "Add Pin", testId: "graph-pin-add", onSelect: () => commit(added) });
  const entry = pinListEntryIndex(typeId, pinId);
  const removed = entry === undefined ? null : removePinListEntry(typeId, nodeId, node.data, graph.edges, entry);
  if (removed) {
    items.push({
      id: "remove-pin",
      label: "Remove Pin",
      testId: "graph-pin-remove",
      onSelect: () => commit({
        ...graph,
        nodes: graph.nodes.map((candidate) => (candidate.id === nodeId ? { ...candidate, data: removed.data } : candidate)),
        edges: removed.edges,
      }),
    });
  }
  return items;
}
