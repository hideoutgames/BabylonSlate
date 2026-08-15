import {
  pin,
  type NodeDefinition,
  EXEC,
  actorRef,
  classRef,
  objectRef,
  BOOL,
} from "@babylonslate/scripting";

export const componentNodes: NodeDefinition[] = [
  {
    id: "component.get",
    title: "Get Component",
    category: "component",
    pure: true,
    pins: () => [
      pin("actor", "actor", "in", actorRef("Actor")),
      pin("classId", "classId", "in", classRef("ActorComponent")),
      pin("out", "out", "out", objectRef("ActorComponent")),
    ],
    codegen: (ctx) => ({
      out: `ctx.getComponent(${ctx.input("actor")}, ${ctx.input("classId")})`,
    }),
  },
  {
    id: "component.has",
    title: "Has Component",
    category: "component",
    pure: true,
    pins: () => [
      pin("actor", "actor", "in", actorRef("Actor")),
      pin("classId", "classId", "in", classRef("ActorComponent")),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(ctx.getComponent(${ctx.input("actor")}, ${ctx.input("classId")}) != null)`,
    }),
  },
  {
    id: "component.add",
    title: "Add Component",
    category: "component",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("actor", "actor", "in", actorRef("Actor")),
      pin("classId", "classId", "in", classRef("ActorComponent")),
      pin("out", "out", "out", objectRef("ActorComponent")),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = ctx.addComponent(${ctx.input("actor")}, ${ctx.input("classId")});`,
      );
    },
  },
];
