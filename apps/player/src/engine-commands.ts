import type { CommandMessage } from "@babylonslate/bridge";
import type { SerializedScene } from "@babylonslate/core";

const ENGINE_COMMAND_TYPES = new Set<CommandMessage["type"]>([
  "assignMesh",
  "assignMaterial",
  "possessCamera",
  "setShadowQuality",
  "animState",
  "spawn",
  "playSound",
  "stopSound",
  "setChannelVolume",
  "setGlobalVolume",
  "setFrameCap",
  "setRenderQuality",
  "setResolutionScale",
  "setFreeCam",
  "setWireframe",
  "setShowBounds",
  "setShowCollision",
  "setShowNav",
  "debugColliders",
  "assignParticle",
  "setParticlePlaying",
]);

export function applyPlayerEngineCommand(
  handle: { applyCommand: (command: CommandMessage) => void },
  command: { type: string } & Record<string, unknown>,
): boolean {
  if (!ENGINE_COMMAND_TYPES.has(command.type as CommandMessage["type"])) {
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
): boolean {
  if (command.type !== "activeScene" || typeof command.sceneAssetGuid !== "string") {
    return false;
  }
  const scene = scenes.get(command.sceneAssetGuid);
  if (!scene) return false;
  handle.loadScene(scene);
  handle.applySceneEnvironment(scene);
  handle.resetAudioSession?.();
  handle.resetParticleSession?.();
  return true;
}
