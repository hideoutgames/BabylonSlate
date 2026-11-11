import {
  pin,
  type NodeDefinition,
  EXEC,
  classRef,
  objectRef,
  BOOL,
  STRING,
  arrayOf,
  TRANSFORM,
} from "@haptic/scripting";
import { selfActorPin, subject } from "./self-pin";
import { liveReferenceCall } from "./live-reference";

/**
 * The Spawn Actor nodes prepare the Class, then create the actor. Async lets
 * gameplay run while the Class prepares; Blocking prepares at High priority and
 * holds the simulation meanwhile, like Load Class (Blocking). The deferred pair
 * stops before Begin Play, for Finish Deferred Spawn Actor.
 */
function spawnNode(
  id: string,
  title: string,
  call: "spawnActorAsync" | "beginDeferredSpawnActorAsync",
  blocking: boolean,
): NodeDefinition {
  return {
    id,
    title,
    category: "actor",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("classId", "classId", "in", classRef("Actor")),
      pin("transform", "Transform", "in", TRANSFORM, "data", true),
      pin("out", "out", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      const options = blocking ? ", { blocking: true }" : "";
      ctx.emit(
        `${ctx.output("out")} = (yield ctx.${call}(${ctx.input("classId")}, ${ctx.input("transform")}${options}));`,
      );
    },
  };
}

export const actorNodes: NodeDefinition[] = [
  {
    id: "actor.getSelf",
    title: "Get Self",
    category: "actor",
    pure: true,
    pins: () => [pin("out", "out", "out", objectRef("Actor"))],
    codegen: () => ({ out: `ctx.self` }),
  },
  {
    id: "actor.destroy",
    title: "Destroy Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.destroyActor(${ctx.input("target")});`);
    },
  },
  {
    id: "actor.getName",
    title: "Get Actor Name",
    category: "actor",
    pure: true,
    pins: () => [
      selfActorPin("target"),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `ctx.getActorName(${ctx.input("target")})`,
    }),
  },
  {
    id: "actor.isValid",
    title: "Is Valid",
    category: "actor",
    pure: true,
    pins: () => [
      pin("target", "Object", "in", objectRef("Object")),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: liveReferenceCall(ctx, ctx.input("target")) }),
  },
  spawnNode("actor.spawn", "Spawn Actor (Async)", "spawnActorAsync", false),
  spawnNode("actor.spawnBlocking", "Spawn Actor (Blocking)", "spawnActorAsync", true),
  spawnNode("actor.deferredSpawn", "Spawn Actor Deferred (Async)", "beginDeferredSpawnActorAsync", false),
  spawnNode("actor.deferredSpawnBlocking", "Spawn Actor Deferred (Blocking)", "beginDeferredSpawnActorAsync", true),
  {
    id: "actor.finishDeferredSpawn",
    title: "Finish Deferred Spawn Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("actor", "Actor", "in", objectRef("Actor"))),
      pin("out", "out", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("out")} = ctx.finishDeferredSpawnActor(${ctx.input("actor")});`);
    },
  },
  {
    id: "actor.getAllOfClass",
    title: "Get All Actors Of Class",
    category: "actor",
    pure: true,
    pins: () => [
      pin("classId", "Class", "in", classRef("Actor")),
      pin("out", "Out", "out", arrayOf(objectRef("Actor"))),
    ],
    codegen: (ctx) => ({
      out: `ctx.getAllActorsOfClass(${ctx.input("classId")})`,
    }),
  },
  {
    id: "actor.getOfClass",
    title: "Get Actor Of Class",
    category: "actor",
    pure: true,
    pins: () => [
      pin("classId", "Class", "in", classRef("Actor")),
      pin("out", "Out", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => ({
      out: `ctx.getActorOfClass(${ctx.input("classId")})`,
    }),
  },
  {
    id: "actor.attach",
    title: "Attach Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
      pin("parent", "Parent", "in", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.attachActor(${ctx.input("target")}, ${ctx.input("parent")});`,
      );
    },
  },
  {
    id: "actor.attachToBone",
    title: "Attach To Bone",
    category: "actor",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      selfActorPin("actor", "Actor"),
      subject(pin("target", "Target", "in", objectRef("Actor"))),
      pin("boneName", "Bone Name", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.attachToBone(${ctx.input("actor")}, ${ctx.input("target")}, ${ctx.input("boneName")});`);
    },
  },
  {
    id: "actor.detach",
    title: "Detach Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.detachActor(${ctx.input("target")});`);
    },
  },
  {
    id: "actor.getParent",
    title: "Get Parent",
    category: "actor",
    pure: true,
    pins: () => [
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => ({
      out: `ctx.getParent(${ctx.input("target")})`,
    }),
  },
  {
    id: "actor.setOwner",
    title: "Set Owner",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
      pin("owner", "Owner", "in", objectRef("Actor")),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setOwner(${ctx.input("target")}, ${ctx.input("owner")});`,
      );
    },
  },
  {
    id: "actor.getOwner",
    title: "Get Owner",
    category: "actor",
    pure: true,
    pins: () => [
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", objectRef("Actor")),
    ],
    codegen: (ctx) => ({
      out: `ctx.getOwner(${ctx.input("target")})`,
    }),
  },
];
