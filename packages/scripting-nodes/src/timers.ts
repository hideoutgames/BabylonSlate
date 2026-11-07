import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
} from "@haptic/scripting";

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
  {
    id: "timers.retriggerableDelay",
    title: "Retriggerable Delay",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("duration", "duration", "in", FLOAT),
    ],
    // Keyed by node: a later call restarts the wait and only that call continues.
    codegen: (ctx) => {
      ctx.emit(`await ctx.retriggerableDelay(${JSON.stringify(ctx.node.id)}, ${ctx.input("duration")});`);
    },
  },
  {
    id: "timers.delayOneTick",
    title: "Delay One Tick",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.emit("await ctx.delayOneTick();");
    },
  },
];
