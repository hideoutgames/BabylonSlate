import {
  pin,
  type NodeDefinition,
  type PinType,
  BOOL,
  COLOR,
  EXEC,
  FLOAT,
  INT,
  ROTATOR,
  STRING,
  VEC3,
  assetRef,
  objectRef,
} from "@haptic/scripting";
import { selfActorPin } from "./self-pin";

type ParameterKind = "Float" | "Vector" | "Color";

const PARAMETER_VALUE: Record<ParameterKind, { type: PinType; defaultValue: unknown; description: string }> = {
  Float: { type: FLOAT, defaultValue: 1, description: "a Float parameter; a vector or color parameter takes it on every component" },
  Vector: { type: VEC3, defaultValue: { x: 0, y: 0, z: 0 }, description: "a Vector 3 parameter; a Vector 2 parameter takes X and Y" },
  Color: { type: COLOR, defaultValue: { x: 1, y: 1, z: 1, w: 1 }, description: "a Color parameter" },
};

const nameIn = () => ({ ...pin("name", "Name", "in", STRING), defaultValue: "" });

function parameterSetter(kind: ParameterKind): NodeDefinition {
  const value = PARAMETER_VALUE[kind];
  return {
    id: `particles.set${kind}Parameter`,
    title: `Set Particle ${kind} Parameter`,
    category: "particles",
    description: `Sets ${value.description} on the actor's particle components whose Particle System declares Name, while the effect runs. Not saved.`,
    searchAliases: ["particle parameter", `set ${kind.toLowerCase()} parameter`],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("actor"),
      nameIn(),
      pin("value", "Value", "in", value.type, "data", true, value.defaultValue),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setParticle${kind}Parameter(${ctx.input("actor")}, ${ctx.input("name")}, ${ctx.input("value")});`);
    },
  };
}

function parameterGetter(kind: ParameterKind): NodeDefinition {
  return {
    id: `particles.get${kind}Parameter`,
    title: `Get Particle ${kind} Parameter`,
    category: "particles",
    pure: true,
    description: "Returns a particle parameter of the first particle component on the actor whose Particle System declares Name: the value set at runtime, else the default.",
    searchAliases: ["particle parameter", `get ${kind.toLowerCase()} parameter`],
    pins: () => [
      selfActorPin("actor"),
      nameIn(),
      pin("value", "Value", "out", PARAMETER_VALUE[kind].type),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const read = `ctx.getParticle${kind}Parameter(${ctx.input("actor")}, ${ctx.input("name")})`;
      return { value: `${read}.value`, found: `${read}.found` };
    },
  };
}

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
  {
    id: "particles.emitBurst",
    title: "Emit Particle Burst",
    category: "particles",
    description: "Emits Count extra particles from the actor's playing particle systems: every emitter slot, or only the one at Slot. A system that is not playing ignores it.",
    searchAliases: ["burst", "emit particles"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("actor"),
      pin("count", "Count", "in", INT, "data", true, 10),
      pin("slot", "Slot", "in", INT, "data", true, -1),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.emitParticleBurst(${ctx.input("actor")}, ${ctx.input("count")}, ${ctx.input("slot")});`);
    },
  },
  parameterSetter("Float"),
  parameterSetter("Vector"),
  parameterSetter("Color"),
  parameterGetter("Float"),
  parameterGetter("Vector"),
  parameterGetter("Color"),
  {
    id: "particles.resetParameter",
    title: "Reset Particle Parameter",
    category: "particles",
    description: "Drops the value Set Particle Parameter gave Name on the actor's particle components, back to the default.",
    searchAliases: ["particle parameter", "reset parameter"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("actor"),
      nameIn(),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("success")} = ctx.resetParticleParameter(${ctx.input("actor")}, ${ctx.input("name")});`);
    },
  },
];
