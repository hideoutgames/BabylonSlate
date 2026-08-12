import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
  FLOAT,
} from "@babylonslate/scripting";

export const audioNodes: NodeDefinition[] = [
  {
    id: "audio.play",
    title: "Play Sound",
    category: "audio",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("asset", "asset", "in", STRING),
      pin("volume", "volume", "in", FLOAT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.playSound(${ctx.input("asset")}, ${ctx.input("volume")});`,
      );
    },
  },
];
