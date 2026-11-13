import type { DebugObserveTarget } from "./channels";

/** Whether two graph-debugger requests watch the same thing. */
export function sameDebugObserveTarget(a: DebugObserveTarget | null, b: DebugObserveTarget | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.kind !== b.kind) return false;
  return a.kind === "class" ? a.classId === (b as typeof a).classId : a.assetGuid === (b as typeof a).assetGuid;
}

/** `DebugGraphTrace.graphId` of a Behaviour Tree, which the runtime evaluates itself (its `assetGuid` is the tree's guid). */
export const BT_DEBUG_GRAPH_ID = "behaviour-tree";
const ANIM_STATE_MACHINE_DEBUG_PREFIX = "state-machine:";

/**
 * `DebugGraphTrace.graphId` of one of an Animation Graph's State Machines, which the runtime evaluates itself (its
 * `assetGuid` is the graph's guid). Its states and transitions trace and stop under it.
 */
export function animStateMachineDebugGraphId(machineId: string): string {
  return ANIM_STATE_MACHINE_DEBUG_PREFIX + machineId;
}

/** The State Machine id a debug graph id names, or null for any other graph. */
export function animStateMachineOfDebugGraphId(graphId: string | null | undefined): string | null {
  return graphId?.startsWith(ANIM_STATE_MACHINE_DEBUG_PREFIX) ? graphId.slice(ANIM_STATE_MACHINE_DEBUG_PREFIX.length) : null;
}
/** `DebugGraphTrace.graphId` of an Animation Graph's Animation Object graph, a compiled graph (its `assetGuid` is the asset's path). */
export const ANIM_OBJECT_DEBUG_GRAPH_ID = "animation-object";
