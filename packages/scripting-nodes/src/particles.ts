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
    id: "particles.restart",
    title: "Restart Particles",
    category: "particles",
    description: "Cuts the particles on screen and plays the actor's particle systems from the start, whatever their Retrigger; looping systems too.",
    searchAliases: ["replay particles", "retrigger"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("actor"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.restartParticles(${ctx.input("actor")});`);
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
