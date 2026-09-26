import type { Edge } from "@xyflow/react";
import type { SerializedPin } from "./graph-types";

type ConnectionEdges = ReadonlyArray<
  Pick<Edge, "source" | "target" | "sourceHandle" | "targetHandle">
>;

// React Flow edge snapshots are immutable. Share the index across pins and
// store updates retaining the same array, without retaining old snapshots.
const wiredPinsByEdges = new WeakMap<ConnectionEdges, ReadonlySet<string>>();

function pinKey(
  nodeId: string,
  direction: SerializedPin["direction"],
  pinId: string,
) {
  return JSON.stringify([nodeId, direction, pinId]);
}

export function isPinWired(
  edges: ConnectionEdges,
  nodeId: string,
  pin: Pick<SerializedPin, "id" | "direction">,
): boolean {
  let wiredPins = wiredPinsByEdges.get(edges);
  if (!wiredPins) {
    const index = new Set<string>();
    for (const edge of edges) {
      index.add(pinKey(edge.source, "out", edge.sourceHandle ?? ""));
      index.add(pinKey(edge.target, "in", edge.targetHandle ?? ""));
    }
    wiredPinsByEdges.set(edges, index);
    wiredPins = index;
  }
  return wiredPins.has(pinKey(nodeId, pin.direction, pin.id));
}
