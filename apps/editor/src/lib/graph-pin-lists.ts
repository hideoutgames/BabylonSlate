import type { GraphAddPin } from "@haptic/graph-ui";
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
}

/** Script nodes with a growable pin list, by catalog type id. */
const GROWABLE_PIN_LISTS: ReadonlyMap<string, GrowablePinList> = new Map<string, GrowablePinList>([
  ["array.make", {
    property: "count", side: "in", min: 0, max: MAKE_CONTAINER_MAX_COUNT,
    defaultCount: MAKE_ARRAY_DEFAULT_ITEMS, count: makeArrayItemCount,
  }],
  ["map.make", {
    property: "count", side: "in", min: 0, max: MAKE_CONTAINER_MAX_COUNT,
    defaultCount: MAKE_MAP_DEFAULT_PAIRS, count: makeMapPairCount,
  }],
  ["flow.sequence", {
    property: "count", side: "out", min: 1, max: SEQUENCE_MAX_OUTPUTS,
    defaultCount: SEQUENCE_DEFAULT_OUTPUTS, count: sequenceOutputCount,
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
