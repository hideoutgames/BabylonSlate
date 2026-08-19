import type { SerializedScene } from "@babylonslate/core";
import { parseNavMeshActorSettings } from "@babylonslate/navigation";

const flushes = new Set<() => Promise<void>>();

/** Register a mounted scene workspace bake flush. Returns unregister. */
export function registerNavBakeSaveFlush(flush: () => Promise<void>): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Save awaits each mounted scene that has Auto Bake On Save. Never throws. */
export async function flushNavBakeForSave(): Promise<void> {
  for (const flush of [...flushes]) {
    try {
      await flush();
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
