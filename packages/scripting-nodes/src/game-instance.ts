import {
  pin,
  type NodeDefinition,
  FLOAT,
  objectRef,
} from "@babylonslate/scripting";

export const gameInstanceNodes: NodeDefinition[] = [
  {
    id: "gameInstance.getSceneLoadingProgress",
    title: "Get Scene Loading Progress",
    category: "game-instance",
    pure: true,
    pins: () => [pin("progress", "Progress", "out", FLOAT)],
    codegen: () => ({ progress: "ctx.getSceneLoadingProgress()" }),
  },
  {
    id: "gameInstance.getSceneReference",
    title: "Get Scene Reference",
    category: "game-instance",
    pure: true,
    pins: () => [pin("scene", "Scene", "out", objectRef("Scene"))],
    codegen: () => ({ scene: "ctx.getSceneReference()" }),
  },
];
