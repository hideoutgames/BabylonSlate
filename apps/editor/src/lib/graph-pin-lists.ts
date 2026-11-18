import type { GraphAddPin } from "@haptic/graph-ui";
import { pinDefaultPropertyKey } from "@haptic/scripting";
import {
  MAKE_ARRAY_DEFAULT_ITEMS,
  MAKE_CONTAINER_MAX_COUNT,
  MAKE_MAP_DEFAULT_PAIRS,
  SEQUENCE_DEFAULT_OUTPUTS,
  SEQUENCE_MAX_OUTPUTS,
  makeArrayItemCount,
  makeMapPairCount,
  sequenceOutputCount,
} from "@haptic/scripting-nodes";

/**
 * A Script node whose pin list grows with a whole-number property: its Inspector count row and the
 * node's **+ Add Pin** control both read these limits, and the catalog's own clamp reads the count.
 */
export interface GrowablePinList {
  /** The node data key holding the count. */
  property: "count";
  /** Inputs (`in`) or outputs (`out`): the side the Add Pin control sits on. */
  side: "in" | "out";
  min: number;
  max: number;
  /** The count of a new node, and of one without the property. */
  defaultCount: number;
  /** The count the node's pins follow, clamped as the catalog clamps it. */
  count: (data: Record<string, unknown>) => number;
  /**
   * The pin id prefixes of one entry, in pin order: entry `i` owns `<prefix><i>` for each (Make
   * Map's pair `key<i>` and `value<i>`). Entries count from 0.
   */
  entryPins: readonly string[];
}

/** Script nodes with a growable pin list, by catalog type id. */
const GROWABLE_PIN_LISTS: ReadonlyMap<string, GrowablePinList> = new Map<string, GrowablePinList>([
  ["array.make", {
    property: "count", side: "in", min: 0, max: MAKE_CONTAINER_MAX_COUNT,
    defaultCount: MAKE_ARRAY_DEFAULT_ITEMS, count: makeArrayItemCount, entryPins: ["item"],
  }],
  ["map.make", {
    property: "count", side: "in", min: 0, max: MAKE_CONTAINER_MAX_COUNT,
    defaultCount: MAKE_MAP_DEFAULT_PAIRS, count: makeMapPairCount, entryPins: ["key", "value"],
  }],
  ["flow.sequence", {
    property: "count", side: "out", min: 1, max: SEQUENCE_MAX_OUTPUTS,
    defaultCount: SEQUENCE_DEFAULT_OUTPUTS, count: sequenceOutputCount, entryPins: ["then"],
  }],
]);

export function growablePinList(typeId: string): GrowablePinList | undefined {
  return GROWABLE_PIN_LISTS.get(typeId);
}

/** The node's Add Pin control (`__addPin`), or undefined when it has no growable list or is at its maximum. */
export function addPinControlFor(typeId: string, data: Record<string, unknown>): GraphAddPin | undefined {
  const list = growablePinList(typeId);
  if (!list || list.count(data) >= list.max) return undefined;
  return { side: list.side, label: "Add Pin" };
}

/** The data patch Add Pin applies: one more pin, or null at the maximum or for a node without a growable list. */
export function addPinPatch(typeId: string, data: Record<string, unknown>): Record<string, unknown> | null {
  const list = growablePinList(typeId);
  if (!list) return null;
  const current = list.count(data);
  return current < list.max ? { [list.property]: current + 1 } : null;
}

/** The entry of the node's growable list a pin belongs to, or undefined for any other pin. */
export function pinListEntryIndex(typeId: string, pinId: string): number | undefined {
  const list = growablePinList(typeId);
  return list ? entryPinOf(list, pinId)?.index : undefined;
}

function entryPinOf(list: GrowablePinList, pinId: string): { prefix: string; index: number } | undefined {
  for (const prefix of list.entryPins) {
    if (!pinId.startsWith(prefix)) continue;
    const digits = pinId.slice(prefix.length);
    if (/^(0|[1-9]\d*)$/.test(digits)) return { prefix, index: Number(digits) };
  }
  return undefined;
}

type PinListEdge = { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };

/**
 * Remove Pin: the node without entry `index` of its growable list. Later entries move down one,
 * carrying their wires (the handle on this node renamed) and stored `default:<pin>` values; the
 * removed entry's wires and values are dropped, and the count falls by one. Null for a node without
 * a growable list, at the list's minimum, or for an index outside it.
 */
export function removePinListEntry<E extends PinListEdge>(
  typeId: string,
  nodeId: string,
  data: Record<string, unknown>,
  edges: readonly E[],
  index: number,
): { data: Record<string, unknown>; edges: E[] } | null {
  const list = growablePinList(typeId);
  if (!list) return null;
  const count = list.count(data);
  if (count <= list.min || !Number.isInteger(index) || index < 0 || index >= count) return null;
  const nextData: Record<string, unknown> = { ...data, [list.property]: count - 1 };
  for (const prefix of list.entryPins) {
    for (let entry = index; entry < count; entry++) delete nextData[pinDefaultPropertyKey(`${prefix}${entry}`)];
    for (let entry = index + 1; entry < count; entry++) {
      const value = data[pinDefaultPropertyKey(`${prefix}${entry}`)];
      if (value !== undefined) nextData[pinDefaultPropertyKey(`${prefix}${entry - 1}`)] = value;
    }
  }
  const handleKey = list.side === "in" ? "targetHandle" : "sourceHandle";
  const nextEdges: E[] = [];
  for (const edge of edges) {
    const handle = edge[handleKey];
    const entry = (list.side === "in" ? edge.target : edge.source) === nodeId && handle
      ? entryPinOf(list, handle)
      : undefined;
    if (!entry || entry.index >= count || entry.index < index) {
      nextEdges.push(edge);
    } else if (entry.index > index) {
      nextEdges.push({ ...edge, [handleKey]: `${entry.prefix}${entry.index - 1}` });
    }
  }
  return { data: nextData, edges: nextEdges };
}
