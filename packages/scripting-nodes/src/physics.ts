import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  BOOL,
  FLOAT,
  INT,
  ROTATOR,
  objectRef,
  arrayOf,
  enumRef,
  structRef,
  COLLISION_CHANNEL_MEMBERS,
  ENGINE_COLLISION_CHANNEL_ENUM_ID,
  ENGINE_HIT_RESULT_STRUCT_ID,
  ENGINE_MOTION_TYPE_ENUM_ID,
  diagnostic,
  listValidationRules,
  registerValidationRule,
  readPinDefault,
  type Diagnostic,
  type GraphPin,
  type TypeContext,
  type LogicGraph,
} from "@haptic/scripting";
import { selfActorPin } from "./self-pin";
import { enumGuidOf, enumValueOf } from "./enum";

const HIT_RESULT = structRef(ENGINE_HIT_RESULT_STRUCT_ID);
const COLLISION_CHANNEL = enumRef(ENGINE_COLLISION_CHANNEL_ENUM_ID);
const ACTOR_ARRAY = arrayOf(objectRef("Actor"));
const MOTION_TYPE = enumRef(ENGINE_MOTION_TYPE_ENUM_ID);
type Codegen = Parameters<NonNullable<NodeDefinition["codegen"]>>[0];

/** Nodes whose unwired Radius must be above zero (`physics.radius`). */
const RADIUS_NODES = new Set([
  "physics.sphereOverlap", "physics.shapeSweep", "physics.multiSphereTrace", "physics.capsuleTrace", "physics.capsuleOverlap",
]);

const execPins = () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];
const channelPin = () => pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true);
const ignorePin = () => pin("actorsToIgnore", "Actors To Ignore", "in", ACTOR_ARRAY, "data", true, []);
const orientationPin = () => pin("orientation", "Orientation", "in", ROTATOR, "data", true);
const halfSizePin = () => pin("halfSize", "Half Size", "in", VEC3, "data", true, { x: 0.5, y: 0.5, z: 0.5 });
const radiusPin = (value: number) => pin("radius", "Radius", "in", FLOAT, "data", true, value);
const halfHeightPin = () => pin("halfHeight", "Half Height", "in", FLOAT, "data", true, 0.5);
const hitPins = () => [
  pin("hitResult", "Hit Result", "out", HIT_RESULT),
  pin("hit", "Hit", "out", BOOL),
  pin("location", "Location", "out", VEC3),
  pin("normal", "Normal", "out", VEC3),
  pin("distance", "Distance", "out", FLOAT),
  pin("actor", "Actor", "out", objectRef("Actor")),
];

/** A box (Half Size) or capsule (Radius, Half Height along its Up axis) query shape. */
const boxShape = (ctx: Codegen) => `{ kind: "box", halfExtents: ${ctx.input("halfSize")} }`;
const capsuleShape = (ctx: Codegen) => `{ kind: "capsule", radius: ${ctx.input("radius")}, halfHeight: ${ctx.input("halfHeight")} }`;
/** The statement that reads the Orientation pin once into `__rot`, for the poses of one query. */
const readOrientation = (ctx: Codegen) => `const __rot = ctx.rotatorToQuat(${ctx.input("orientation")});`;
/** A pose at `position`, turned by `__rot` (see `readOrientation`), or unturned for a node without an Orientation pin. */
const pose = (ctx: Codegen, position: string, oriented: boolean) =>
  `{ position: ${ctx.input(position)}, rotation: ${oriented ? "__rot" : "{ x: 0, y: 0, z: 0, w: 1 }"} }`;

/** Box Trace and Capsule Trace: a linear sweep of the shape at Orientation, first hit only. */
function shapeTraceNode(id: string, title: string, shapePins: () => GraphPin[], shape: (ctx: Codegen) => string, description: string): NodeDefinition {
  return {
    id, title, category: "physics", description,
    pins: () => [
      ...execPins(),
      pin("start", "Start", "in", VEC3),
      pin("end", "End", "in", VEC3),
      ...shapePins(),
      orientationPin(),
      channelPin(),
      ignorePin(),
      ...hitPins(),
    ],
    codegen: (ctx) => {
      emitMappedHit(ctx, `ctx.shapeSweep(${shape(ctx)}, ${pose(ctx, "start", true)}, ${pose(ctx, "end", true)}, ${ctx.input("channel")}, ${ctx.input("actorsToIgnore")})`, readOrientation(ctx));
    },
  };
}

/** Multi Line Trace and Multi Sphere Trace: every actor along the path, nearest first. */
function multiTraceNode(id: string, title: string, shapePins: () => GraphPin[], shape: (ctx: Codegen) => string, description: string): NodeDefinition {
  return {
    id, title, category: "physics", description,
    searchAliases: ["multi trace", "trace all", "hits"],
    pins: () => [
      ...execPins(),
      pin("start", "Start", "in", VEC3),
      pin("end", "End", "in", VEC3),
      ...shapePins(),
      channelPin(),
      ignorePin(),
      pin("hits", "Hits", "out", arrayOf(HIT_RESULT)),
      pin("hit", "Hit", "out", BOOL),
    ],
    codegen: (ctx) => {
      const hits = ctx.output("hits");
      ctx.emit(`${hits} = ctx.multiTrace(${shape(ctx)}, ${pose(ctx, "start", false)}, ${pose(ctx, "end", false)}, ${ctx.input("channel")}, ${ctx.input("actorsToIgnore")}); ${ctx.output("hit")} = ${hits}.length > 0;`);
    },
  };
}

/** Box and Capsule Overlap Actors: the actors the shape at Center and Orientation overlaps. */
function shapeOverlapNode(id: string, title: string, shapePins: () => GraphPin[], shape: (ctx: Codegen) => string, description: string): NodeDefinition {
  return {
    id, title, category: "physics", description,
    pins: () => [
      ...execPins(),
      pin("center", "Center", "in", VEC3),
      ...shapePins(),
      orientationPin(),
      channelPin(),
      pin("actors", "Actors", "out", ACTOR_ARRAY),
      pin("count", "Count", "out", INT),
    ],
    codegen: (ctx) => {
      const actors = ctx.output("actors");
      ctx.emit(`{ ${readOrientation(ctx)} ${actors} = ctx.shapeOverlap(${shape(ctx)}, ${pose(ctx, "center", true)}, ${ctx.input("channel")}); ${ctx.output("count")} = ${actors}.length; }`);
    },
  };
}

/** Get Physics Linear Velocity and Get Physics Angular Velocity In Degrees. */
function velocityRead(id: string, title: string, outName: string, angular: boolean, description: string): NodeDefinition {
  return {
    id, title, category: "physics", pure: true, description,
    pins: () => [selfActorPin("target", "Target"), pin("velocity", outName, "out", VEC3)],
    codegen: (ctx) => ({ velocity: `ctx.physicsVelocity(${ctx.input("target")}, ${angular})` }),
  };
}

/** Set Physics Linear Velocity and Set Physics Angular Velocity In Degrees. */
function velocityWrite(id: string, title: string, inName: string, angular: boolean, description: string): NodeDefinition {
  return {
    id, title, category: "physics", description,
    pins: () => [
      ...execPins(),
      selfActorPin("target", "Target"),
      pin("velocity", inName, "in", VEC3),
      pin("addToCurrent", "Add To Current", "in", BOOL, "data", true, false),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setPhysicsVelocity(${ctx.input("target")}, ${angular}, ${ctx.input("velocity")}, ${ctx.input("addToCurrent")});`);
    },
  };
}

/** A miss reports zero Location and Normal on the struct and on the exploded pins alike. */
function emitMappedHit(
  ctx: Parameters<NonNullable<NodeDefinition["codegen"]>>[0],
  expr: string,
  setup = "",
): void {
  const hitResult = ctx.output("hitResult");
  const hit = ctx.output("hit");
  const location = ctx.output("location");
  const normal = ctx.output("normal");
  const distance = ctx.output("distance");
  const actor = ctx.output("actor");
  ctx.emit(
    `{ ${setup} const __hit = ${expr}; ${hitResult} = { Hit: __hit.hit === true, Location: __hit.location ?? { x: 0, y: 0, z: 0 }, Normal: __hit.normal ?? { x: 0, y: 0, z: 0 }, Actor: __hit.actor ?? null, Distance: __hit.distance ?? 0 }; ${hit} = __hit.hit === true; ${location} = __hit.location ?? { x: 0, y: 0, z: 0 }; ${normal} = __hit.normal ?? { x: 0, y: 0, z: 0 }; ${distance} = __hit.distance ?? 0; ${actor} = __hit.actor ?? null; }`,
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
    const wired = new Set(graph.edges.map((edge) => `${edge.targetNodeId}\t${edge.targetPinId}`));
    for (const node of graph.nodes) {
      if (!RADIUS_NODES.has(node.typeId) || wired.has(`${node.id}\tradius`)) {
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

const COLLISION_CHANNELS: readonly string[] = COLLISION_CHANNEL_MEMBERS;

/**
 * A query treats a channel name it does not know as All, so a stale literal (a graph saved before the channels were
 * renamed, or a hand-edited name) would silently widen the query. Unwired Channel defaults and Make Enum values are
 * the places a literal channel is authored; a wired value is checked where it is made.
 */
function validateCollisionChannels(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const report = (graph: LogicGraph, nodeId: string, pinId: string | undefined, value: unknown) => {
    if (value === undefined || value === null || value === "" || (typeof value === "string" && COLLISION_CHANNELS.includes(value))) return;
    out.push(
      diagnostic({
        severity: "warning",
        code: "physics.channel",
        message: `Unknown collision channel "${String(value)}": the query treats it as All. Use ${COLLISION_CHANNEL_MEMBERS.join(", ")}.`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId,
        pinId,
      }),
    );
  };
  for (const graph of graphs) {
    const wired = new Set(graph.edges.map((edge) => `${edge.targetNodeId}\t${edge.targetPinId}`));
    for (const node of graph.nodes) {
      if (node.typeId === "enum.make" && enumGuidOf(node.properties) === ENGINE_COLLISION_CHANNEL_ENUM_ID) {
        report(graph, node.id, undefined, enumValueOf(node.properties));
        continue;
      }
      for (const pin of node.pins) {
        if (
          pin.direction !== "in" || pin.kind !== "data" || pin.type.kind !== "enumRef" ||
          pin.type.guid !== ENGINE_COLLISION_CHANNEL_ENUM_ID || wired.has(`${node.id}\t${pin.id}`)
        ) continue;
        report(graph, node.id, pin.id, readPinDefault(node.properties, pin.id));
      }
    }
  }
  return out;
}

/** Register radius validation for sphere overlap / sphere shape sweep, and collision channel validation. */
export function registerPhysicsValidationRules(): void {
  const registered = new Set(listValidationRules().map((rule) => rule.id));
  if (!registered.has("physics.radius")) {
    registerValidationRule({
      id: "physics.radius",
      run: validatePhysicsRadius,
    });
  }
  if (!registered.has("physics.channel")) {
    registerValidationRule({
      id: "physics.channel",
      run: validateCollisionChannels,
    });
  }
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
      pin("drawDebug", "Draw Debug", "in", BOOL, "data", true, true),
      pin("actorsToIgnore", "Actors To Ignore", "in", ACTOR_ARRAY, "data", true, []),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
      pin("normal", "Normal", "out", VEC3),
      pin("distance", "Distance", "out", FLOAT),
      pin("actor", "Actor", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      emitMappedHit(
        ctx,
        `ctx.lineTrace(${ctx.input("start")}, ${ctx.input("end")}, ${ctx.input("channel")}, { drawDebug: ${ctx.input("drawDebug")}, actorsToIgnore: ${ctx.input("actorsToIgnore")} })`,
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
      radiusPin(0.5),
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
      radiusPin(0.5),
      pin("channel", "Channel", "in", COLLISION_CHANNEL, "data", true),
      pin("hitResult", "Hit Result", "out", HIT_RESULT),
      pin("hit", "Hit", "out", BOOL),
      pin("location", "Location", "out", VEC3),
      pin("normal", "Normal", "out", VEC3),
      pin("distance", "Distance", "out", FLOAT),
      pin("actor", "Actor", "out", objectRef("Actor")),
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
      selfActorPin("target"),
      pin("impulse", "impulse", "in", VEC3),
      pin("strength", "strength", "in", FLOAT, "data", true, 1),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.addImpulse(${ctx.input("target")}, ${ctx.input("impulse")}, ${ctx.input("strength")});`,
      );
    },
  },
  velocityRead("physics.getLinearVelocity", "Get Physics Linear Velocity", "Velocity", false,
    "Target's Rigid Body velocity in units per second, at its center of mass. Zero without a body."),
  velocityWrite("physics.setLinearVelocity", "Set Physics Linear Velocity", "Velocity", false,
    "Replaces Target's Rigid Body velocity, in units per second, or adds to it with Add To Current. Only a Dynamic body moves by its velocity."),
  velocityRead("physics.getAngularVelocity", "Get Physics Angular Velocity In Degrees", "Angular Velocity", true,
    "Target's Rigid Body spin in degrees per second about each world axis. Zero without a body."),
  velocityWrite("physics.setAngularVelocity", "Set Physics Angular Velocity In Degrees", "Angular Velocity", true,
    "Replaces Target's Rigid Body spin, in degrees per second about each world axis, or adds to it with Add To Current. In 2D only Z turns."),
  {
    id: "physics.addForce",
    title: "Add Force",
    category: "physics",
    description: "Pushes Target's Rigid Body for this frame: an impulse of Force times the frame's Delta Seconds, so calling it every frame accelerates the body steadily.",
    pins: () => [...execPins(), selfActorPin("target", "Target"), pin("force", "Force", "in", VEC3)],
    codegen: (ctx) => {
      ctx.emit(`ctx.addForce(${ctx.input("target")}, ${ctx.input("force")}, ctx.getDeltaSeconds());`);
    },
  },
  {
    id: "physics.addTorque",
    title: "Add Torque",
    category: "physics",
    description: "Twists Target's Rigid Body for this frame about its center of mass: Torque is a world axis whose length is the strength, applied for the frame's Delta Seconds.",
    pins: () => [...execPins(), selfActorPin("target", "Target"), pin("torque", "Torque", "in", VEC3)],
    codegen: (ctx) => {
      ctx.emit(`ctx.addTorque(${ctx.input("target")}, ${ctx.input("torque")}, ctx.getDeltaSeconds());`);
    },
  },
  {
    id: "physics.setMotionType",
    title: "Set Motion Type",
    category: "physics",
    description: "Sets the Motion Type of Target's Rigid Body: Dynamic simulates, Kinematic follows the actor's transform and pushes Dynamic bodies, Static never moves.",
    searchAliases: ["simulate physics", "set simulate physics", "kinematic", "dynamic", "static"],
    pins: () => [
      ...execPins(),
      selfActorPin("target", "Target"),
      pin("motionType", "Motion Type", "in", MOTION_TYPE, "data", true, "Dynamic"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setMotionType(${ctx.input("target")}, ${ctx.input("motionType")});`);
    },
  },
  {
    id: "physics.setActorEnableCollision",
    title: "Set Actor Enable Collision",
    category: "physics",
    description: "Turns all of Target's collision off or back on. While off, its shapes block and overlap nothing and traces and overlaps skip it; its Rigid Body keeps simulating.",
    searchAliases: ["collision enabled", "disable collision", "no collision"],
    pins: () => [
      ...execPins(),
      selfActorPin("target", "Target"),
      pin("enabled", "Enabled", "in", BOOL, "data", true, true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setActorCollisionEnabled(${ctx.input("target")}, ${ctx.input("enabled")});`);
    },
  },
  {
    id: "physics.getActorEnableCollision",
    title: "Get Actor Enable Collision",
    category: "physics",
    pure: true,
    description: "False while Set Actor Enable Collision has turned Target's collision off.",
    pins: () => [selfActorPin("target", "Target"), pin("enabled", "Enabled", "out", BOOL)],
    codegen: (ctx) => ({ enabled: `ctx.isActorCollisionEnabled(${ctx.input("target")})` }),
  },
  shapeTraceNode("physics.boxTrace", "Box Trace", () => [halfSizePin()], boxShape,
    "Sweeps a box of Half Size, turned by Orientation, from Start to End and returns the first thing it hits."),
  shapeTraceNode("physics.capsuleTrace", "Capsule Trace", () => [radiusPin(0.5), halfHeightPin()], capsuleShape,
    "Sweeps a capsule from Start to End and returns the first thing it hits. Half Height is the straight part's half length along the capsule's Up axis, which Orientation turns."),
  multiTraceNode("physics.multiLineTrace", "Multi Line Trace", () => [], () => "null",
    "Traces a line from Start to End and returns every actor it passes through as a Hit Result, nearest first, one per actor."),
  multiTraceNode("physics.multiSphereTrace", "Multi Sphere Trace", () => [radiusPin(0.5)],
    (ctx) => `{ kind: "sphere", radius: ${ctx.input("radius")} }`,
    "Sweeps a sphere from Start to End and returns every actor it touches as a Hit Result, nearest first, one per actor."),
  shapeOverlapNode("physics.boxOverlap", "Box Overlap Actors", () => [halfSizePin()], boxShape,
    "The actors whose collision a box of Half Size at Center, turned by Orientation, overlaps."),
  shapeOverlapNode("physics.capsuleOverlap", "Capsule Overlap Actors", () => [radiusPin(0.5), halfHeightPin()], capsuleShape,
    "The actors whose collision a capsule at Center overlaps. Half Height is the straight part's half length along the capsule's Up axis, which Orientation turns."),
  {
    id: "physics.moveCharacter",
    title: "Move Character",
    category: "physics",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target"),
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
