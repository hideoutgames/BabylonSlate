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
    loadScene: (scene: SerializedScene) => void;
    applySceneEnvironment: (scene: SerializedScene) => void;
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
  if (!forceReload && command.sceneAssetGuid === currentSceneGuid) return true;
  const scene = scenes.get(command.sceneAssetGuid);
  if (!scene) return false;
  handle.loadScene(scene);
  handle.applySceneEnvironment(scene);
  handle.resetAudioSession?.();
  handle.resetParticleSession?.();
  return true;
}
