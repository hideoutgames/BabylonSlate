import {
  pin,
  type NodeDefinition,
  EXEC,
  actorRef,
  classRef,
  objectRef,
  BOOL,
  STRING,
} from "@babylonslate/scripting";

export const actorNodes: NodeDefinition[] = [
  {
    id: "actor.getSelf",
    title: "Get Self",
    category: "actor",
    pure: true,
    pins: () => [pin("out", "out", "out", actorRef("Actor"))],
    codegen: () => ({ out: `ctx.self` }),
  },
  {
    id: "actor.destroy",
    title: "Destroy Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", actorRef("Actor")),
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
      pin("target", "target", "in", actorRef("Actor")),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("target")}?.name ?? "")`,
    }),
  },
  {
    id: "actor.isValid",
    title: "Is Valid",
    category: "actor",
    pure: true,
    pins: () => [
      pin("target", "target", "in", objectRef("BObject")),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("target")} != null)` }),
  },
  {
    id: "actor.spawn",
    title: "Spawn Actor",
    category: "actor",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("classId", "classId", "in", classRef("Actor")),
      pin("out", "out", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(`${out} = ctx.spawnActor(${ctx.input("classId")});`);
    },
  },
];
