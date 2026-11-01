import { nextCopyName } from "@haptic/assets";
import type { GraphClassMemberPin, SerializedGraph } from "@haptic/core";
import { pinPickerLabel } from "@haptic/editor-kit";
import { createEdgeId, type GraphPinDragSource } from "@haptic/graph-ui";
import { variableTypeFromPinType, type PinType } from "@haptic/scripting";
import { patchClassMember } from "./class-members";

const INPUT_NODE = "flow.function.input";
const OUTPUT_NODE = "flow.function.output";

type Endpoint = { direction: "in" | "out" };

/**
 * Which side of the function a wire dropped on `targetNodeId` adds a pin to:
 * a wire from an input pin onto the function's Input node adds an input, one
 * from an output pin onto its Output node adds an output. Null when the drop
 * adds nothing: another node, the wrong way round, an Interface
 * implementation (its signature is the interface's), or a wire whose type a
 * signature row cannot hold (exec, which connects to the node's own exec pin;
 * a Wildcard nothing has resolved; a Map, whose key type a row does not keep).
 */
function dropEndpoint(
  graph: SerializedGraph,
  functionId: string,
  targetNodeId: string,
  source: Pick<GraphPinDragSource, "pin" | "type">,
): Endpoint | null {
  const member = (graph.members ?? []).find((entry) => entry.id === functionId && entry.kind === "function");
  if (!member || member.implementsInterface) return null;
  const target = graph.functionGraphs?.[functionId]?.nodes.find((node) => node.id === targetNodeId);
  const role = target?.type === INPUT_NODE ? "in" : target?.type === OUTPUT_NODE ? "out" : null;
  if (!role || source.pin.kind === "exec") return null;
  // The Input node's pins are outputs, so it takes wires dragged from inputs.
  if ((role === "in") !== (source.pin.direction === "in")) return null;
  const kind = source.type.kind;
  if (kind === "exec" || kind === "wildcard" || kind === "map") return null;
  return { direction: role };
}

export function acceptsFunctionPinDrop(
  graph: SerializedGraph,
  functionId: string,
  targetNodeId: string,
  source: Pick<GraphPinDragSource, "pin" | "type">,
): boolean {
  return dropEndpoint(graph, functionId, targetNodeId, source) !== null;
}

/** A signature row of the wire's type, named after the type (`Float`, then `Float_1`, …). */
function pinRowForWire(
  type: PinType,
  direction: "in" | "out",
  takenNames: readonly string[],
): GraphClassMemberPin {
  const spec = variableTypeFromPinType(type);
  return {
    name: nextCopyName(pinPickerLabel(spec.typeId), [...takenNames]),
    typeId: spec.typeId,
    direction,
    ...(spec.typeClassId ? { typeClassId: spec.typeClassId } : {}),
    ...(spec.container !== "single" ? { container: spec.container } : {}),
    ...(spec.signature ? { signature: spec.signature } : {}),
  };
}

/**
 * Add a function input or output of the dropped wire's type and connect it to
 * the pin the wire came from, in one graph change. The new pin's name is free
 * among all of the function's pins, inputs and outputs alike. Returns null
 * when `acceptsFunctionPinDrop` would refuse the drop.
 */
export function addFunctionPinFromDrop(
  graph: SerializedGraph,
  functionId: string,
  targetNodeId: string,
  source: GraphPinDragSource,
  classId?: string,
): SerializedGraph | null {
  const endpoint = dropEndpoint(graph, functionId, targetNodeId, source);
  if (!endpoint) return null;
  const member = graph.members!.find((entry) => entry.id === functionId)!;
  const pins = member.pins ?? [];
  const row = pinRowForWire(source.type as PinType, endpoint.direction, pins.map((pin) => pin.name));
  const patched = patchClassMember(graph, functionId, { pins: [...pins, row] }, classId);
  const slice = patched.functionGraphs?.[functionId];
  if (!slice) return null;
  // Input node pins are outputs feeding the dragged input; Output node pins take the dragged output.
  const wire = endpoint.direction === "in"
    ? { source: targetNodeId, sourceHandle: row.name, target: source.nodeId, targetHandle: source.pin.id }
    : { source: source.nodeId, sourceHandle: source.pin.id, target: targetNodeId, targetHandle: row.name };
  // A data input takes one wire, so the new one replaces any it had.
  const edges = slice.edges.filter((edge) =>
    !(edge.target === wire.target && edge.targetHandle === wire.targetHandle));
  edges.push({ id: createEdgeId(wire.source, wire.sourceHandle, wire.target, wire.targetHandle), ...wire });
  return {
    ...patched,
    functionGraphs: { ...patched.functionGraphs, [functionId]: { ...slice, edges } },
  };
}
