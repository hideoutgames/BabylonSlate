import {
  actorRef,
  BOOL,
  ENGINE_SCENE_STREAMING_STATE_ENUM_ID,
  enumRef,
  EXEC,
  FLOAT,
  pin,
  STRING,
  type NodeDefinition,
  type PinType,
} from "@babylonslate/scripting";

const TARGET = actorRef("SceneStreamingActor");

function query(method: string, title: string, result: PinType, description: string): NodeDefinition {
  return {
    id: `sceneStreaming.${method}`,
    title,
    category: "scene",
    description,
    pure: true,
    pins: () => [pin("target", "Target", "in", TARGET), pin("out", "Out", "out", result)],
    codegen: (ctx) => ({ out: `ctx.${method}(${ctx.input("target")})` }),
  };
}

function operation(method: string, title: string, blocking: boolean, description: string): NodeDefinition {
  return {
    id: `sceneStreaming.${method}`,
    title,
    category: "scene",
    description,
    latent: blocking,
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      pin("target", "Target", "in", TARGET),
    ],
    codegen: (ctx) => {
      ctx.emit(`${blocking ? "await " : ""}ctx.${method}(${ctx.input("target")});`);
    },
  };
}

export const sceneStreamingNodes: NodeDefinition[] = [
  query("getTargetSceneName", "Get Target Scene Name", STRING, "Returns the target Scene asset name of this Scene Streaming Actor."),
  operation("loadSceneAsync", "Load Scene Async", false, "Starts loading this scene instance while game simulation and the Then pin continue."),
  operation("unloadSceneAsync", "Unload Scene Async", false, "Starts unloading only this scene instance while game simulation and the Then pin continue."),
  operation("loadSceneBlocking", "Load Scene Blocking", true, "Pauses game simulation until this scene instance is fully ready, then executes Then."),
  operation("unloadSceneBlocking", "Unload Scene Blocking", true, "Pauses game simulation until this scene instance is unloaded, then executes Then."),
  query("isSceneLoaded", "Is Scene Loaded", BOOL, "True only after all runtime actors and render resources for this scene instance are ready."),
  query("getSceneLoadProgress", "Get Scene Load Progress", FLOAT, "Loading progress from 0 to 1. Fully loaded is 1; unloaded is 0."),
  query("getSceneState", "Get Scene State", enumRef(ENGINE_SCENE_STREAMING_STATE_ENUM_ID), "Returns this instance's Scene Streaming State: Unloaded, Loading, Loaded, or Unloading."),
];
