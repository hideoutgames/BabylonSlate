import type { Edge } from "@xyflow/react";
import { passThroughTargets } from "@haptic/core";
import { hasSerializedPins, isRerouteNodeData, type SerializedPin } from "./graph-types";

type ConnectionEdges = ReadonlyArray<
  Pick<Edge, "source" | "target" | "sourceHandle" | "targetHandle">
>;

/** Wired pin ids by node id, for each pin direction. */
type WiredPins = Record<SerializedPin["direction"], Map<string, Set<string>>>;

// React Flow edge snapshots are immutable. Share the index across pins and
// store updates retaining the same array, without retaining old snapshots.
const wiredPinsByEdges = new WeakMap<ConnectionEdges, WiredPins>();

function addWired(pins: Map<string, Set<string>>, nodeId: string, pinId: string) {
  let ids = pins.get(nodeId);
  if (!ids) pins.set(nodeId, (ids = new Set()));
  ids.add(pinId);
}

export function isPinWired(
  edges: ConnectionEdges,
  nodeId: string,
  pin: Pick<SerializedPin, "id" | "direction">,
): boolean {
  let wiredPins = wiredPinsByEdges.get(edges);
  if (!wiredPins) {
    const index: WiredPins = { in: new Map(), out: new Map() };
    for (const edge of edges) {
      addWired(index.out, edge.source, edge.sourceHandle ?? "");
      addWired(index.in, edge.target, edge.targetHandle ?? "");
    }
    wiredPinsByEdges.set(edges, index);
    wiredPins = index;
  }
  // Nested lookups, so the per-frame query allocates nothing and no id can collide with another.
  return wiredPins[pin.direction].get(nodeId)?.has(pin.id) ?? false;
}

/**
 * A variable output (`reference: "writable"`) passes its variable by reference
 * while one of its wires ends on a reference input (a Seeded Random node's Seed,
 * a Pass-By-Reference function input). The graph then draws it as a reference pin.
 */
export function passesReference(
  edges: ConnectionEdges,
  nodeLookup: ReadonlyMap<string, { data: Record<string, unknown> }>,
  nodeId: string,
  pin: Pick<SerializedPin, "id" | "direction" | "reference">,
): boolean {
  if (pin.direction !== "out" || pin.reference !== "writable") return false;
  // Reroute knots pass the variable on, so the inputs past them count.
  const isKnot = (id: string) => isRerouteNodeData(nodeLookup.get(id)?.data);
  for (const end of passThroughTargets(edges, isKnot, nodeId, pin.id)) {
    const target = nodeLookup.get(end.nodeId)?.data;
    if (!hasSerializedPins(target)) continue;
    if (target.__pins.some((input) => input.id === end.pinId && input.reference === "required")) return true;
  }
  return false;
}
