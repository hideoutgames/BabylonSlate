import {
  pin,
  type NodeDefinition,
  EXEC,
} from "@haptic/scripting";
import { selfActorPin } from "./self-pin";

export const particleNodes: NodeDefinition[] = [
  {
    id: "particles.play",
    title: "Play Particles",
    category: "particles",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("actor"),
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
      selfActorPin("actor"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.stopParticles(${ctx.input("actor")});`);
    },
  },
];
