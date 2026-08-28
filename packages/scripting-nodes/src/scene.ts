import {
  pin,
  type NodeDefinition,
  EXEC,
  assetRef,
} from "@babylonslate/scripting";

const SCENE_ASSET = assetRef("Scene");

export const sceneNodes: NodeDefinition[] = [
  {
    id: "scene.change",
    title: "Change Scene",
    category: "scene",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("scene", "scene", "in", SCENE_ASSET),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.changeScene(${ctx.input("scene")});`);
    },
  },
];
