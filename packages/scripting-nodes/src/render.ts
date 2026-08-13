import {
  pin,
  type NodeDefinition,
  EXEC,
  INT,
} from "@babylonslate/scripting";

export const renderNodes: NodeDefinition[] = [
  {
    id: "render.setResolution",
    title: "Set Render Resolution",
    category: "render",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("width", "width", "in", INT),
      pin("height", "height", "in", INT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setRenderResolution(${ctx.input("width")}, ${ctx.input("height")});`,
      );
    },
  },
];
