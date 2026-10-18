import {
  pin,
  type NodeDefinition,
  EXEC,
  actorRef,
} from "@babylonslate/scripting";
import { actorOrSelf } from "./self-pin";

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
      ctx.emit(`ctx.playParticles(${actorOrSelf(ctx, "actor")});`);
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
      ctx.emit(`ctx.stopParticles(${actorOrSelf(ctx, "actor")});`);
    },
  },
];
