import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
} from "@babylonslate/scripting";

export const sceneNodes: NodeDefinition[] = [
  {
    id: "scene.change",
    title: "Change Scene",
    category: "scene",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("scene", "scene", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.changeScene(${ctx.input("scene")});`);
    },
  },
];
