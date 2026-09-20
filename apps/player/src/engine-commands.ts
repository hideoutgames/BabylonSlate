import { isPlayEngineCommandType, type CommandMessage } from "@babylonslate/bridge";
import type { SerializedScene } from "@babylonslate/core";

export function applyPlayerEngineCommand(
  handle: { applyCommand: (command: CommandMessage) => void },
  command: { type: string } & Record<string, unknown>,
): boolean {
  if (!isPlayEngineCommandType(command.type)) {
    return false;
  }
  handle.applyCommand(command as CommandMessage);
  return true;
}

export function applyPlayerActiveScene(
  handle: {
    loadScene: (
      scene: SerializedScene,
      options?: { sceneAssetGuid?: string },
    ) => void;
    applySceneEnvironment: (scene: SerializedScene) => void;
    applyBakedSession: (scene: SerializedScene, sceneAssetGuid?: string) => void;
    resetAudioSession?: () => void;
    resetParticleSession?: () => void;
  },
  scenes: ReadonlyMap<string, SerializedScene>,
  command: { type: string; sceneAssetGuid?: unknown },
  currentSceneGuid?: string | null,
  forceReload = false,
): boolean {
  if (command.type !== "activeScene" || typeof command.sceneAssetGuid !== "string") {
    return false;
  }
  const scene = scenes.get(command.sceneAssetGuid);
  if (!forceReload && command.sceneAssetGuid === currentSceneGuid) {
    // The already-active scene skips the reload; its baked-lighting session
    // still has to bind because nothing else applies it on this path.
    if (scene) handle.applyBakedSession(scene, command.sceneAssetGuid);
    return true;
  }
  if (!scene) return false;
  handle.loadScene(scene, { sceneAssetGuid: command.sceneAssetGuid });
  handle.applySceneEnvironment(scene);
  handle.resetAudioSession?.();
  handle.resetParticleSession?.();
  return true;
}
