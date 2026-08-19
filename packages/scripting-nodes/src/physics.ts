import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  BOOL,
  FLOAT,
  INT,
  actorRef,
  arrayOf,
  enumRef,
  structRef,
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_HIT_RESULT_STRUCT_ID,
  diagnostic,
  listValidationRules,
  registerValidationRule,
  readPinDefault,
  type TypeContext,
  type LogicGraph,
} from "@babylonslate/scripting";

const HIT_RESULT = structRef(ENGINE_HIT_RESULT_STRUCT_ID);
const COLLISION_CHANNEL = enumRef(ENGINE_COLLISION_CHANNEL_ENUM_ID);
const ACTOR_ARRAY = arrayOf(actorRef("Actor"));

function emitMappedHit(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  expr: string,
): void {
  const hitResult = ctx.output("hitResult");
  const hit = ctx.output("hit");
  const location = ctx.output("location");
  const normal = ctx.output("normal");
  const distance = ctx.output("distance");
  const actor = ctx.output("actor");
  ctx.emit(
    `{ const __hit = ${expr}; ${hitResult} = { Hit: __hit.hit === true, Location: __hit.location ?? { x: 0, y: 0, z: 0 }, Normal: __hit.normal ?? { x: 0, y: 0, z: 0 }, Actor: __hit.actor ?? null, Distance: __hit.distance ?? 0 }; ${hit} = __hit.hit === true; ${location} = __hit.location ?? null; ${normal} = __hit.normal ?? null; ${distance} = __hit.distance ?? 0; ${actor} = __hit.actor ?? null; }`,
  );
}

function radiusFromNode(node: {
  properties: Record<string, unknown>;
}): number | undefined {
  const raw = readPinDefault(node.properties, "radius");
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function validatePhysicsRadius(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
) {
  const out = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (
        node.typeId !== "physics.sphereOverlap" &&
        node.typeId !== "physics.shapeSweep"
      ) {
        continue;
      }
      const radius = radiusFromNode(node);
      if (radius === undefined) continue;
      if (radius <= 0) {
        out.push(
          diagnostic({
            code: "physics.radius",
            message: `Radius must be greater than 0 (got ${radius})`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
            pinId: "radius",
          }),
        );
      }
    }
  }
  return out;
}

/** Register radius validation for sphere overlap / sphere shape sweep. */
export function registerPhysicsValidationRules(): void {
  if (listValidationRules().some((rule) => rule.id === "physics.radius")) {
    return;
  }
  registerValidationRule({
    id: "physics.radius",
    run: validatePhysicsRadius,
  });
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
      pin("normal", "Normal", "out", VEC3),
      pin("distance", "Distance", "out", FLOAT),
      pin("actor", "Actor", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.lineTrace(${ctx.input("start")}, ${ctx.input("end")}, ${ctx.input("channel")})`,
      );
    },
  },
  {
    id: "physics.sphereOverlap",
    title: "Sphere Overlap Actors",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("center", "Center", "in", VEC3),
      pin("radius", "Radius", "in", FLOAT),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("actors", "Actors", "out", ACTOR_ARRAY),
      pin("count", "Count", "out", INT),
    ],
    codegen: (ctx) => {
      const actors = ctx.output("actors");
      const count = ctx.output("count");
      ctx.emit(
        `{ const __overlap = ctx.sphereOverlap(${ctx.input("center")}, ${ctx.input("radius")}, ${ctx.input("channel")}); ${actors} = __overlap.actors ?? []; ${count} = ${actors}.length; }`,
      );
    },
  },
  {
    id: "physics.shapeSweep",
    title: "Sphere Shape Sweep",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("start", "Start", "in", VEC3),
      pin("end", "End", "in", VEC3),
      pin("radius", "Radius", "in", FLOAT),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
      pin("normal", "Normal", "out", VEC3),
      pin("distance", "Distance", "out", FLOAT),
      pin("actor", "Actor", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.shapeSweep({ kind: "sphere", radius: ${ctx.input("radius")} }, { position: ${ctx.input("start")}, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { position: ${ctx.input("end")}, rotation: { x: 0, y: 0, z: 0, w: 1 } }, ${ctx.input("channel")})`,
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
