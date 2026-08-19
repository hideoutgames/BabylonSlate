import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  BOOL,
  FLOAT,
  actorRef,
  enumRef,
  structRef,
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_HIT_RESULT_STRUCT_ID,
} from "@babylonslate/scripting";

const HIT_RESULT = structRef(ENGINE_HIT_RESULT_STRUCT_ID);
const COLLISION_CHANNEL = enumRef(ENGINE_COLLISION_CHANNEL_ENUM_ID);

function emitMappedHit(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  expr: string,
  includeActor: boolean,
): void {
  const hitResult = ctx.output("hitResult");
  const hit = ctx.output("hit");
  const location = ctx.output("location");
  const parts = [
    `const __hit = ${expr};`,
    `${hitResult} = { Hit: __hit.hit, Location: __hit.location ?? { x: 0, y: 0, z: 0 }, Normal: __hit.normal ?? { x: 0, y: 1, z: 0 }, Actor: __hit.actor, Distance: __hit.distance ?? 0 };`,
    `${hit} = __hit.hit;`,
    `${location} = __hit.location;`,
  ];
  if (includeActor) {
    parts.push(`${ctx.output("actor")} = __hit.actor;`);
  }
  ctx.emit(`{ ${parts.join(" ")} }`);
}

/** Physics query and impulse nodes — sync on the calling execution pin (P7). */
export const physicsNodes: NodeDefinition[] = [
  {
    id: "physics.lineTrace",
    title: "Line Trace",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("start", "Start", "in", VEC3),
      pin("end", "End", "in", VEC3),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
      pin("actor", "Actor", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.lineTrace(${ctx.input("start")}, ${ctx.input("end")}, ${ctx.input("channel")})`,
        true,
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
      pin("center", "Center", "in", VEC3),
      pin("radius", "Radius", "in", FLOAT),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("count", "Count", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const count = ctx.output("count");
      const hitResult = ctx.output("hitResult");
      ctx.emit(
        `{ const __overlap = ctx.sphereOverlap(${ctx.input("center")}, ${ctx.input("radius")}, ${ctx.input("channel")}); ${count} = __overlap.actorIds.length; const __actor = __overlap.actorIds[0] ?? null; ${hitResult} = { Hit: __overlap.actorIds.length > 0, Location: ${ctx.input("center")}, Normal: { x: 0, y: 1, z: 0 }, Actor: __actor, Distance: 0 }; }`,
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
      pin("start", "Start", "in", VEC3),
      pin("end", "End", "in", VEC3),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.shapeSweep({ kind: "sphere", radius: 0.25 }, { position: ${ctx.input("start")}, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { position: ${ctx.input("end")}, rotation: { x: 0, y: 0, z: 0, w: 1 } }, ${ctx.input("channel")})`,
        false,
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
