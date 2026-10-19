import type { DebugObserveTarget } from "./channels";

/** Whether two graph-debugger requests watch the same thing. */
export function sameDebugObserveTarget(a: DebugObserveTarget | null, b: DebugObserveTarget | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.kind !== b.kind) return false;
  return a.kind === "class" ? a.classId === (b as typeof a).classId : a.assetGuid === (b as typeof a).assetGuid;
}
