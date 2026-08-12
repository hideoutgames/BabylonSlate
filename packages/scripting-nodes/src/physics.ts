import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  BOOL,
  FLOAT,
  actorRef,
} from "@babylonslate/scripting";

/** Stubs until P7 — compile but validate as available API surface. */
export const physicsNodes: NodeDefinition[] = [
  {
    id: "physics.lineTrace",
    title: "Line Trace",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("start", "start", "in", VEC3),
      pin("end", "end", "in", VEC3),
      pin("hit", "hit", "out", BOOL),
      pin("location", "location", "out", VEC3),
      pin("actor", "actor", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      const hit = ctx.output("hit");
      const location = ctx.output("location");
      const actor = ctx.output("actor");
      ctx.emit(
        `({ hit: ${hit}, location: ${location}, actor: ${actor} } = ctx.lineTrace(${ctx.input("start")}, ${ctx.input("end")}));`,
      );
    },
  },
  {
    id: "physics.addImpulse",
    title: "Add Impulse",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", actorRef("Actor")),
      pin("impulse", "impulse", "in", VEC3),
      pin("strength", "strength", "in", FLOAT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.addImpulse(${ctx.input("target")}, ${ctx.input("impulse")}, ${ctx.input("strength")});`,
      );
    },
  },
];
