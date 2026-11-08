import type { SerializedScene } from "@haptic/core";
import { parseNavMeshActorSettings } from "@haptic/navigation/settings";
import type { ProjectSceneWriter } from "../services/project-write-admission";

const flushes = new Set<(writer?: ProjectSceneWriter) => Promise<void>>();

/** Register a mounted scene workspace bake flush. Returns unregister. */
export function registerNavBakeSaveFlush(flush: (writer?: ProjectSceneWriter) => Promise<void>): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Save awaits each mounted scene that has Auto Bake On Save. Never throws. */
export async function flushNavBakeForSave(writer?: ProjectSceneWriter): Promise<void> {
  for (const flush of [...flushes]) {
    try {
      await flush(writer);
    } catch {
      // Bake errors stay in NavBakeDialog; Save must not hang.
    }
  }
}

/** NavMeshComponent properties that should bake when the scene is saved. */
export function navMeshAutoBakeProperties(
  scene: SerializedScene | null | undefined,
): Record<string, unknown>[] {
  if (!scene) return [];
  const rows: Record<string, unknown>[] = [];
  for (const actor of scene.actors) {
    for (const component of actor.components) {
      if (component.classId !== "NavMeshComponent") continue;
      if (!parseNavMeshActorSettings(component.properties).autoBakeOnSave) {
        continue;
      }
      rows.push(component.properties);
    }
  }
  return rows;
}
