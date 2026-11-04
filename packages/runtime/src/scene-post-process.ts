import { newGuid } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import type { Scene, World } from "@haptic/object-model";
import type { ScriptHostServices } from "./script-host-services";

export interface ScenePostProcessHost {
  world(): World;
  emit(command: CommandMessage): void;
  frameId(): number;
}

function emitStack(host: ScenePostProcessHost, scene: Scene): void {
  host.emit({ type: "scenePostProcess", postProcessStack: scene.postProcessStack.map((entry) => ({ ...entry })) });
}

/**
 * Register Scene Post-Processing: a new pass for `materialGuid` after the
 * current Scene's passes, with its own Entry ID. Lasts until the Scene changes.
 */
export function registerScenePostProcess(host: ScenePostProcessHost, materialGuid: string): void {
  const scene = host.world().currentScene;
  const guid = String(materialGuid ?? "").trim();
  if (!scene || scene.destroyed || !guid) return;
  scene.postProcessStack.push({ id: newGuid(), materialGuid: guid, enabled: true });
  emitStack(host, scene);
}

/** Unregister Scene Post-Processing: removes the first pass that uses `materialGuid`; a missing one is logged. */
export function unregisterScenePostProcess(host: ScenePostProcessHost, materialGuid: string): void {
  const scene = host.world().currentScene;
  const guid = String(materialGuid ?? "").trim();
  if (!scene || scene.destroyed || !guid) return;
  const index = scene.postProcessStack.findIndex((entry) => entry.materialGuid === guid);
  if (index < 0) {
    host.emit({
      type: "log",
      severity: "error",
      category: "scene",
      message: `Scene post-process ${guid} is not registered on the current Scene`,
      frameId: host.frameId(),
    });
    return;
  }
  // Removing the entry invalidates its Get Post Process Entry reference.
  scene.postProcessStack.splice(index, 1);
  emitStack(host, scene);
}

/** Script calls for the current Scene's post-process passes. */
export function createScenePostProcessHostBindings(host: ScenePostProcessHost): Pick<ScriptHostServices,
  "registerScenePostProcess" | "unregisterScenePostProcess"> {
  return {
    registerScenePostProcess: (materialGuid) => registerScenePostProcess(host, materialGuid),
    unregisterScenePostProcess: (materialGuid) => unregisterScenePostProcess(host, materialGuid),
  };
}
