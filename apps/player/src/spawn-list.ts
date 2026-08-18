import type { ScriptBundleEntry } from "@babylonslate/bridge";
import { shouldSpawnScriptedActor } from "@babylonslate/runtime";

const ACTOR_LIFECYCLE_EVENTS = new Set(["onBeginPlay", "onTick"]);

/** Graph classes that Play may auto-spawn. UserInterface / Widget ids never spawn. */
export function playerSpawnListForScripts(
  scripts: readonly Pick<ScriptBundleEntry, "classId" | "entryPoints">[],
): Array<{ classId: string }> {
  const seen = new Set<string>();
  const spawn: Array<{ classId: string }> = [];
  for (const script of scripts) {
    if (!shouldSpawnScriptedActor(script.classId)) continue;
    if (
      !script.entryPoints.some(
        (entry) => entry.event && ACTOR_LIFECYCLE_EVENTS.has(entry.event),
      )
    ) {
      continue;
    }
    if (seen.has(script.classId)) continue;
    seen.add(script.classId);
    spawn.push({ classId: script.classId });
  }
  return spawn;
}
