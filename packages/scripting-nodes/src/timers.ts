import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
} from "@babylonslate/scripting";

export const timerNodes: NodeDefinition[] = [
  {
    id: "timers.delay",
    title: "Delay",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("duration", "duration", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(`await ctx.delay(${ctx.input("duration")});`);
    },
  },
];
