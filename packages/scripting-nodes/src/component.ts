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
    id: "component.getNamed",
    title: "Get Component Ref",
    category: "component",
    pure: true,
    pins: (properties) => {
      const classId =
        typeof properties.componentClassId === "string" &&
        properties.componentClassId.trim()
          ? properties.componentClassId.trim()
          : "ActorComponent";
      const targetPin =
        properties.implicitSelf === true
          ? []
          : [pin("actor", "actor", "in", actorRef("Actor"))];
      return [
        ...targetPin,
        pin("out", "out", "out", objectRef(classId)),
      ];
    },
    codegen: (ctx) => {
      const classId =
        typeof ctx.node.properties.componentClassId === "string" &&
        ctx.node.properties.componentClassId.trim()
          ? ctx.node.properties.componentClassId.trim()
          : "ActorComponent";
      const targetPin = ctx.node.pins.find(
        (entry) => entry.name === "actor" && entry.direction === "in",
      );
      const targetConnected =
        !!targetPin &&
        ctx.graph.edges.some(
          (edge) =>
            edge.targetNodeId === ctx.node.id &&
            edge.targetPinId === targetPin.id,
        );
      const actorExpr =
        !targetPin ||
        (!targetConnected && ctx.node.properties.implicitSelf === true)
          ? "ctx.self"
          : ctx.input("actor");
      return {
        out: `ctx.getComponent(${actorExpr}, ${JSON.stringify(classId)})`,
      };
    },
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
