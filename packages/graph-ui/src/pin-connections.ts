import type { Edge } from "@xyflow/react";
import { passThroughTargets } from "@haptic/core";
import { hasSerializedPins, isRerouteNodeData, type SerializedPin } from "./graph-types";

type ConnectionEdges = ReadonlyArray<
  Pick<Edge, "source" | "target" | "sourceHandle" | "targetHandle">
>;

/** Wired pin ids by node id, for each pin direction. */
export type WiredPins = Record<SerializedPin["direction"], Map<string, Set<string>>>;

export const EMPTY_WIRED_PINS: WiredPins = { in: new Map(), out: new Map() };

// React Flow edge snapshots are immutable. Share the index across pins and
// store updates retaining the same array, without retaining old snapshots.
const wiredPinsByEdges = new WeakMap<ConnectionEdges, WiredPins>();

function addWired(pins: Map<string, Set<string>>, nodeId: string, pinId: string) {
  let ids = pins.get(nodeId);
  if (!ids) pins.set(nodeId, (ids = new Set()));
  ids.add(pinId);
}

/** Builds a direction-indexed lookup of wired pins once per edges snapshot. */
export function buildWiredPins(edges: ConnectionEdges): WiredPins {
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
  return wiredPins;
}

export function isPinWired(
  edges: ConnectionEdges,
  nodeId: string,
  pin: Pick<SerializedPin, "id" | "direction">,
): boolean {
  const wiredPins = buildWiredPins(edges);
  // Nested lookups, so the per-frame query allocates nothing and no id can collide with another.
  return wiredPins[pin.direction].get(nodeId)?.has(pin.id) ?? false;
}

type NodeLookup = ReadonlyMap<string, { data: Record<string, unknown> }>;

/** An answer and the data object of every node the walk read, as it read them. */
type ReferenceAnswer = { passes: boolean; read: Map<string, Record<string, unknown> | undefined> };

/** Answers by node id then pin id, per edges snapshot. */
const referenceByEdges = new WeakMap<ConnectionEdges, Map<string, Map<string, ReferenceAnswer>>>();

/**
 * A variable output (`reference: "writable"`) passes its variable by reference
 * while one of its wires ends on a reference input (a Seeded Random node's Seed,
 * a Pass-By-Reference function input). The graph then draws it as a reference pin.
 *
 * Every pin of the canvas asks again on each store update (a pan, zoom or drag
 * frame), so the answer is kept per edges snapshot and reused while each node
 * the walk read (the knots it passed and the inputs it reached) still has the
 * same data object: React Flow keeps a node's data on a move, and a data edit
 * replaces it.
 */
export function passesReference(
  edges: ConnectionEdges,
  nodeLookup: NodeLookup,
  nodeId: string,
  pin: Pick<SerializedPin, "id" | "direction" | "reference">,
): boolean {
  if (pin.direction !== "out" || pin.reference !== "writable") return false;
  let byNode = referenceByEdges.get(edges);
  if (!byNode) referenceByEdges.set(edges, (byNode = new Map()));
  let byPin = byNode.get(nodeId);
  if (!byPin) byNode.set(nodeId, (byPin = new Map()));
  const cached = byPin.get(pin.id);
  if (cached && everyReadUnchanged(cached.read, nodeLookup)) return cached.passes;
  const answer = walkPassesReference(edges, nodeLookup, nodeId, pin.id);
  byPin.set(pin.id, answer);
  return answer.passes;
}

function everyReadUnchanged(read: ReferenceAnswer["read"], nodeLookup: NodeLookup): boolean {
  for (const [id, data] of read) if (nodeLookup.get(id)?.data !== data) return false;
  return true;
}

function walkPassesReference(edges: ConnectionEdges, nodeLookup: NodeLookup, nodeId: string, pinId: string): ReferenceAnswer {
  const read: ReferenceAnswer["read"] = new Map();
  const dataOf = (id: string) => {
    const data = nodeLookup.get(id)?.data;
    read.set(id, data);
    return data;
  };
  // Reroute knots pass the variable on, so the inputs past them count.
  const isKnot = (id: string) => isRerouteNodeData(dataOf(id));
  for (const end of passThroughTargets(edges, isKnot, nodeId, pinId)) {
    const target = dataOf(end.nodeId);
    if (!hasSerializedPins(target)) continue;
    if (target.__pins.some((input) => input.id === end.pinId && input.reference === "required")) return { passes: true, read };
  }
  return { passes: false, read };
}

/**
 * Computes all writable output pins that pass a variable by reference once per
 * `(edges, pinNodes)` change, replacing per-pin React Flow store subscriptions.
 */
export function buildReferencePins(
  edges: ConnectionEdges,
  nodes: ReadonlyArray<{ id: string; data?: Record<string, unknown> }>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (edges.length === 0) return result;
  const wired = buildWiredPins(edges);
  if (wired.out.size === 0) return result;
  let lookup: Map<string, { data: Record<string, unknown> }> | null = null;
  for (const node of nodes) {
    const wiredOut = wired.out.get(node.id);
    if (!wiredOut || !hasSerializedPins(node.data)) continue;
    for (const pin of node.data.__pins) {
      if (pin.direction !== "out" || pin.reference !== "writable" || !wiredOut.has(pin.id)) continue;
      if (!lookup) {
        lookup = new Map();
        for (const entry of nodes) {
          if (entry.data) lookup.set(entry.id, { data: entry.data });
        }
      }
      if (walkPassesReference(edges, lookup, node.id, pin.id).passes) {
        let ids = result.get(node.id);
        if (!ids) result.set(node.id, (ids = new Set()));
        ids.add(pin.id);
      }
    }
  }
  return result;
}
