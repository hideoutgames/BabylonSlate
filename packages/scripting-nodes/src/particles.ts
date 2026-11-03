import {
  pin,
  type NodeDefinition,
  BOOL,
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
  {
    id: "particles.isPlaying",
    title: "Is Particles Playing",
    category: "particles",
    pure: true,
    description: "True while any particle component on the actor is playing: from Play until a Once system finishes, Stop is called, or the system cannot play.",
    searchAliases: ["particles playing", "is emitting"],
    pins: () => [
      selfActorPin("actor"),
      pin("out", "Playing", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: `ctx.isParticlesPlaying(${ctx.input("actor")})` }),
  },
];
