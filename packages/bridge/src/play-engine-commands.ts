import type { CommandMessage } from "./channels";

/** Worker/runtime commands the Play/player Babylon handle must apply. */
export const PLAY_ENGINE_COMMAND_TYPES = [
  "assignMesh",
  "assignMaterial",
  "possessCamera",
  "setShadowQuality",
  "spawn",
  "despawn",
  "playSound",
  "stopSound",
  "setChannelVolume",
  "setGlobalVolume",
  "setFrameCap",
  "setRenderQuality",
  "setResolutionScale",
  "assignParticle",
  "setParticlePlaying",
  "setFreeCam",
  "setWireframe",
  "setShowBounds",
  "setShowCollision",
  "setShowNav",
  "setShowAudioDebug",
  "debugColliders",
  "debugDraw",
  "setCursorVisible",
  "animState",
  "sceneLayerCreate",
  "sceneLayerRemove",
  "sceneLayerClear",
  "sceneLayerPostProcess",
] as const satisfies readonly CommandMessage["type"][];

export type PlayEngineCommandType = (typeof PLAY_ENGINE_COMMAND_TYPES)[number];

const PLAY_ENGINE_COMMAND_TYPE_SET = new Set<string>(PLAY_ENGINE_COMMAND_TYPES);

export function isPlayEngineCommandType(
  type: string,
): type is PlayEngineCommandType {
  return PLAY_ENGINE_COMMAND_TYPE_SET.has(type);
}
