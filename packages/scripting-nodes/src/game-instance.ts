import {
  pin,
  type NodeDefinition,
  FLOAT,
  objectRef,
} from "@babylonslate/scripting";

export const gameInstanceNodes: NodeDefinition[] = [
  {
    id: "gameInstance.get",
    title: "Get Game Instance",
    category: "game-instance",
    description:
      "Returns the session Game Instance. Cast it to the project's Game Instance class.",
    pure: true,
    pins: () => [
      pin("gameInstance", "Game Instance", "out", objectRef("GameInstance")),
    ],
    codegen: () => ({ gameInstance: "ctx.getGameInstance()" }),
  },
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
