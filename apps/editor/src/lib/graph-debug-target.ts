import type { DebugInstance, DebugObserveTarget } from "@babylonslate/bridge";
import { walkAncestry } from "@babylonslate/editor-kit";
import { classIdForGraphPath } from "../services/script-compiler";

/** Classes that run without an instance (libraries, commands, editor utilities): nothing to follow. */
const INSTANCELESS_BASES = ["FunctionLibrary", "EditorFunctionLibrary", "EditorUtilityObject", "BDebugCommand"];

/**
 * What a focused Class graph is debugged against while a Simulation runs: the live
 * instances whose class is exactly this one. Null for a class that never has instances.
 */
export function classGraphDebugTarget(
  assetPath: string,
  parentOf: (classId: string) => string | null | undefined,
): DebugObserveTarget | null {
  const classId = classIdForGraphPath(assetPath);
  const ancestry = walkAncestry(classId, parentOf);
  return ancestry.some((id) => INSTANCELESS_BASES.includes(id)) ? null : { kind: "class", classId };
}

/**
 * The name each instance shows in the instance select: its own name, a component under its
 * actor, and a short id suffix wherever two entries would otherwise read alike.
 */
export function debugInstanceNames(instances: readonly DebugInstance[]): Map<string, string> {
  const base = (instance: DebugInstance) =>
    instance.ownerLabel ? `${instance.label} (${instance.ownerLabel})` : instance.label;
  const counts = new Map<string, number>();
  for (const instance of instances) counts.set(base(instance), (counts.get(base(instance)) ?? 0) + 1);
  return new Map(instances.map((instance) => [
    instance.id,
    counts.get(base(instance)) === 1 ? base(instance) : `${base(instance)} · ${instance.id.slice(0, 8)}`,
  ]));
}
