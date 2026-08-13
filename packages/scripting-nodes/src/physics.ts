import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  BOOL,
  FLOAT,
  actorRef,
} from "@babylonslate/scripting";

/** Physics query and impulse nodes — sync on the calling execution pin (P7). */
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
    id: "physics.sphereOverlap",
    title: "Sphere Overlap",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("center", "center", "in", VEC3),
      pin("radius", "radius", "in", FLOAT),
      pin("count", "count", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const count = ctx.output("count");
      ctx.emit(
        `{ const __overlap = ctx.sphereOverlap(${ctx.input("center")}, ${ctx.input("radius")}); ${count} = __overlap.actorIds.length; }`,
      );
    },
  },
  {
    id: "physics.shapeSweep",
    title: "Shape Sweep",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("start", "start", "in", VEC3),
      pin("end", "end", "in", VEC3),
      pin("hit", "hit", "out", BOOL),
      pin("location", "location", "out", VEC3),
    ],
    codegen: (ctx) => {
      const hit = ctx.output("hit");
      const location = ctx.output("location");
      ctx.emit(
        `{ const __sweep = ctx.shapeSweep({ kind: "sphere", radius: 0.25 }, { position: ${ctx.input("start")}, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { position: ${ctx.input("end")}, rotation: { x: 0, y: 0, z: 0, w: 1 } }); ${hit} = __sweep.hit; ${location} = __sweep.location; }`,
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
  {
    id: "physics.moveCharacter",
    title: "Move Character",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", actorRef("Actor")),
      pin("translation", "translation", "in", VEC3),
      pin("offset", "offset", "in", FLOAT, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.moveCharacter(${ctx.input("target")}, ${ctx.input("translation")}, ${ctx.input("offset")});`,
      );
    },
  },
];
