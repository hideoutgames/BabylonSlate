import { sameDebugObserveTarget, type CommandMessage } from "@haptic/bridge";
import type { RuntimeDriver } from "./driver-types";

/**
 * Follows a Behaviour Tree component the way the editor's graph debugger does, so the runtime
 * publishes its `btState`: the `which`-th component (in the roster's order) that runs the tree
 * asset `assetGuid`. Returns the followed component's guid.
 */
export function followBehaviourTree(
  runtime: Pick<RuntimeDriver, "applyDebugObserve">,
  commands: readonly CommandMessage[],
  assetGuid: string,
  which = 0,
): string {
  const target = { kind: "behaviourTree", assetGuid } as const;
  runtime.applyDebugObserve(target, null);
  const roster = new Map<string, true>();
  for (const command of commands) {
    if (command.type !== "debugRoster" || !sameDebugObserveTarget(command.target, target)) continue;
    if (command.reset) roster.clear();
    for (const id of command.removed) roster.delete(id);
    for (const instance of command.added) roster.set(instance.id, true);
  }
  const id = [...roster.keys()][which];
  if (id === undefined) throw new Error(`No Behaviour Tree component runs ${assetGuid}.`);
  runtime.applyDebugObserve(target, id);
  return id;
}
