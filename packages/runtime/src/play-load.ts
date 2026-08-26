import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import { type SerializedScene, type SerializedSceneLayer } from "@babylonslate/core";
import {
  createInProcessRuntime,
  type RuntimeDriver,
  type RuntimeDriverOptions,
} from "./driver";

export type PlayLoadControl = Extract<ControlMessage, { type: "load" }>;

/**
 * Map a worker `load` control message onto `createInProcessRuntime` physics
 * options so Play's scene settings actually reach the backend factory.
 */
export function runtimeOptionsFromLoadControl(
  msg: PlayLoadControl,
): Pick<
  RuntimeDriverOptions,
  | "seed"
  | "physicsWorld"
  | "gravity"
  | "havokWasmUrl"
  | "playScene"
  | "playSceneGuid"
  | "seedDemoActors"
  | "gameInstanceClass"
  | "sceneLibrary"
  | "sceneGuidByKey"
  | "sceneLayerLibrary"
  | "includeDebugCommands"
  | "infiniteLoopDetection"
  | "loopCount"
  | "audioAssetGuids"
  | "animClipCatalog"
> {
  const sceneLibrary: Record<string, SerializedScene> = {};
  const sceneGuidByKey: Record<string, string> = {};
  const sceneLayerLibrary: Record<string, SerializedSceneLayer> = {};
  for (const entry of msg.scenes ?? []) {
    sceneLibrary[entry.guid] = entry.scene;
    sceneGuidByKey[entry.guid] = entry.guid;
    if (entry.scene.name) {
      sceneLibrary[entry.scene.name] = entry.scene;
      sceneGuidByKey[entry.scene.name] = entry.guid;
    }
  }
  for (const entry of msg.sceneLayers ?? []) {
    sceneLayerLibrary[entry.guid] = entry.layer;
    if (entry.layer.name) {
      sceneLayerLibrary[entry.layer.name] = entry.layer;
    }
  }
  return {
    seed: msg.seed ?? 1,
    physicsWorld: msg.physicsWorld === "2d" ? "2d" : "3d",
    gravity: msg.gravity ?? [0, -9.81, 0],
    havokWasmUrl: msg.havokWasmUrl,
    playScene: msg.scene,
    playSceneGuid: msg.sceneAssetGuid,
    seedDemoActors: msg.scene ? false : true,
    gameInstanceClass: msg.gameInstanceClass,
    sceneLibrary: Object.keys(sceneLibrary).length > 0 ? sceneLibrary : undefined,
    sceneGuidByKey:
      Object.keys(sceneGuidByKey).length > 0 ? sceneGuidByKey : undefined,
    sceneLayerLibrary:
      Object.keys(sceneLayerLibrary).length > 0 ? sceneLayerLibrary : undefined,
    includeDebugCommands: msg.includeDebugCommands,
    infiniteLoopDetection: msg.infiniteLoopDetection,
    loopCount: msg.loopCount,
    ...(msg.audioAssetGuids && msg.audioAssetGuids.length > 0
      ? { audioAssetGuids: msg.audioAssetGuids }
      : {}),
    ...(msg.animClipCatalog && msg.animClipCatalog.length > 0
      ? { animClipCatalog: msg.animClipCatalog }
      : {}),
  };
}

/** Create the in-process driver the game worker uses after a `load` message. */
export function createRuntimeFromLoad(
  msg: PlayLoadControl,
  onCommand: (command: CommandMessage) => void,
): RuntimeDriver {
  return createInProcessRuntime({
    ...runtimeOptionsFromLoadControl(msg),
    onCommand,
  });
}

const NON_ACTOR_SCRIPT_CLASS_IDS = new Set([
  "GameInstance",
  "FunctionLibrary",
  "EditorUtilityObject",
  "EditorFunctionLibrary",
  "SceneLayer",
  "Scene",
]);

/** GameInstance, FunctionLibrary, and editor classes are never spawned as Actors. */
export function shouldSpawnScriptedActor(classId: string): boolean {
  return !NON_ACTOR_SCRIPT_CLASS_IDS.has(classId);
}

/** Skip graph-only spawns whose class already exists as a scene actor. */
export function unmatchedScriptSpawns<T extends { classId: string }>(
  spawn: readonly T[],
  sceneClassIds: ReadonlySet<string>,
): T[] {
  return spawn.filter(
    (entry) =>
      shouldSpawnScriptedActor(entry.classId) &&
      !sceneClassIds.has(entry.classId),
  );
}
