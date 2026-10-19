import type { DebugObserveTarget } from "./channels";

/** Whether two graph-debugger requests watch the same thing. */
export function sameDebugObserveTarget(a: DebugObserveTarget | null, b: DebugObserveTarget | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.kind !== b.kind) return false;
  return a.kind === "class" ? a.classId === (b as typeof a).classId : a.assetGuid === (b as typeof a).assetGuid;
}

/** `DebugGraphTrace.graphId` of a Behaviour Tree, which the runtime evaluates itself (its `assetGuid` is the tree's guid). */
export const BT_DEBUG_GRAPH_ID = "behaviour-tree";
/** `DebugGraphTrace.graphId` of an Animation Graph's State Machine, which the runtime evaluates itself (its `assetGuid` is the graph's guid). */
export const ANIM_STATE_MACHINE_DEBUG_GRAPH_ID = "state-machine";
/** `DebugGraphTrace.graphId` of an Animation Graph's Animation Object graph, a compiled graph (its `assetGuid` is the asset's path). */
export const ANIM_OBJECT_DEBUG_GRAPH_ID = "animation-object";
