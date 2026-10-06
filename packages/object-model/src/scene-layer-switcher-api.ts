import type { EngineClassScriptApi, EngineScriptPin } from "./engine-script-api";

const EXEC_IN: EngineScriptPin = { name: "exec", typeId: "exec", direction: "in" };
const EXEC_OUT: EngineScriptPin = { name: "then", typeId: "exec", direction: "out" };
const ACTOR_OUT: EngineScriptPin = { name: "actor", typeId: "object", typeClassId: "SceneLayerActor", direction: "out" };

export const SCENE_LAYER_ACTOR_SCRIPT_API: EngineClassScriptApi = {
  classId: "SceneLayerActor",
  variables: [{ name: "Item Index", typeId: "int", propertyKey: "itemIndex", getOnly: true }],
  nativeEvents: [
    { name: "On Scene Layer Actor Switched To", eventType: "flow.event.sceneLayerActorSwitchedTo", exportName: "onSceneLayerActorSwitchedTo" },
    { name: "On Scene Layer Actor Switched From", eventType: "flow.event.sceneLayerActorSwitchedFrom", exportName: "onSceneLayerActorSwitchedFrom" },
  ],
};

export const SCENE_LAYER_SWITCHER_SCRIPT_API: EngineClassScriptApi = {
  classId: "SceneLayerActorSwitcher",
  variables: [
    { name: "Scene Layer Actors", typeId: "class", typeClassId: "SceneLayerActor", container: "array", propertyKey: "sceneLayerActors" },
    { name: "Initial Index", typeId: "int", propertyKey: "initialIndex" },
    { name: "Current Index", typeId: "int", propertyKey: "currentIndex", getOnly: true },
    { name: "Current Actor", typeId: "object", typeClassId: "SceneLayerActor", propertyKey: "currentActor", getOnly: true },
  ],
  functions: [
    { name: "Switch Scene Layer Actor", runtime: "switchSceneLayerActor", pins: [EXEC_IN, EXEC_OUT, { name: "index", typeId: "int", direction: "in" }, ACTOR_OUT] },
    { name: "Get Current Scene Layer Actor", runtime: "getCurrentSceneLayerActor", pins: [ACTOR_OUT] },
  ],
  nativeEvents: [
    ...(SCENE_LAYER_ACTOR_SCRIPT_API.nativeEvents ?? []),
    { name: "On Scene Layer Actor Switching", eventType: "flow.event.sceneLayerActorSwitching", exportName: "onSceneLayerActorSwitching" },
    { name: "On Scene Layer Actor Switched", eventType: "flow.event.sceneLayerActorSwitched", exportName: "onSceneLayerActorSwitched" },
  ],
};
