import {
  pin,
  type NodeDefinition,
  EXEC,
  actorRef,
} from "@babylonslate/scripting";

export const particleNodes: NodeDefinition[] = [
  {
    id: "particles.play",
    title: "Play Particles",
    category: "particles",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("actor", "actor", "in", actorRef("Actor"), "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.playParticles(${ctx.input("actor")});`);
    },
  },
  {
    id: "particles.stop",
    title: "Stop Particles",
    category: "particles",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("actor", "actor", "in", actorRef("Actor"), "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.stopParticles(${ctx.input("actor")});`);
    },
  },
];
