import type { AssetRegistry } from "@haptic/assets";
import type { DebugInstance, DebugObserveTarget } from "@haptic/bridge";
import { walkAncestry } from "@haptic/editor-kit";
import { classIdForGraphPath } from "../services/script-compiler";
import { registryClassParentLookup } from "./class-asset-lookup";

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
 * What the focused document is debugged against while a Simulation runs: a Class graph against the
 * objects of its class, a Behaviour Tree or Animation Graph against the components that run that
 * asset. Null for any other document, and for an asset the registry does not know.
 */
export function documentGraphDebugTarget(
  document: { kind: string; path: string } | undefined,
  registry: Pick<AssetRegistry, "generation" | "list" | "getByPath"> | null | undefined,
): DebugObserveTarget | null {
  if (!document) return null;
  if (document.kind === "graph") return classGraphDebugTarget(document.path, registryClassParentLookup(registry));
  if (document.kind !== "behaviour-tree" && document.kind !== "anim-graph") return null;
  const assetGuid = registry?.getByPath(document.path)?.header.guid;
  if (!assetGuid) return null;
  return document.kind === "behaviour-tree" ? { kind: "behaviourTree", assetGuid } : { kind: "animationGraph", assetGuid };
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
