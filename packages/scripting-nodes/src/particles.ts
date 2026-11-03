import {
  pin,
  type NodeDefinition,
  BOOL,
  EXEC,
  ROTATOR,
  STRING,
  VEC3,
  assetRef,
  objectRef,
} from "@haptic/scripting";

/**
 * Particle nodes that need no Particle component: one-off effects at a location or attached to
 * an actor. Everything that drives a Particle component (Play, Stop, Restart, Is Playing, Emit
 * Burst and its parameters) is a function of that component.
 */
export const particleNodes: NodeDefinition[] = [
  {
    id: "particles.spawnAtLocation",
    title: "Spawn Particles At Location",
    category: "particles",
    description: "Plays a Particle System once at a world location, without an actor class. With Auto Destroy the effect removes itself when it finishes or is stopped.",
    searchAliases: ["spawn emitter", "play effect", "spawn effect", "fx"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("system", "System", "in", assetRef("ParticleSystem")),
      pin("location", "Location", "in", VEC3),
      pin("rotation", "Rotation", "in", ROTATOR),
      pin("scale", "Scale", "in", VEC3, "data", true, { x: 1, y: 1, z: 1 }),
      pin("autoDestroy", "Auto Destroy", "in", BOOL, "data", true, true),
      pin("effect", "Effect", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("effect")} = ctx.spawnParticlesAtLocation(${ctx.input("system")}, ${ctx.input("location")}, ${ctx.input("rotation")}, ${ctx.input("scale")}, ${ctx.input("autoDestroy")});`);
    },
  },
  {
    id: "particles.spawnAttached",
    title: "Spawn Particles Attached",
    category: "particles",
    description: "Plays a Particle System attached to an actor, or one of its bones, without an actor class. If the actor is destroyed, the effect stops emitting, stays where it was, and finishes.",
    searchAliases: ["attach emitter", "attach effect", "spawn effect attached", "fx"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("system", "System", "in", assetRef("ParticleSystem")),
      pin("attachTo", "Attach To", "in", objectRef("Actor")),
      pin("bone", "Bone", "in", STRING, "data", true, ""),
      pin("locationOffset", "Location Offset", "in", VEC3),
      pin("rotationOffset", "Rotation Offset", "in", ROTATOR),
      pin("autoDestroy", "Auto Destroy", "in", BOOL, "data", true, true),
      pin("effect", "Effect", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("effect")} = ctx.spawnParticlesAttached(${ctx.input("system")}, ${ctx.input("attachTo")}, ${ctx.input("bone")}, ${ctx.input("locationOffset")}, ${ctx.input("rotationOffset")}, ${ctx.input("autoDestroy")});`);
    },
  },
];
