import {
  pin,
  type NodeDefinition,
  EXEC,
  arrayOf,
  classRef,
  objectRef,
  BOOL,
  TRANSFORM,
} from "@haptic/scripting";
import { selfActorPin, selfPin, subject } from "./self-pin";

export const componentNodes: NodeDefinition[] = [
  {
    id: "component.getFirstOfType",
    title: "Get First Component Of Type",
    category: "component",
    pure: true,
    pins: () => [
      pin("classId", "Class", "in", classRef("ActorComponent")),
      pin("out", "Out", "out", objectRef("ActorComponent")),
    ],
    codegen: (ctx) => ({
      out: `ctx.getFirstComponentOfType(${ctx.input("classId")})`,
    }),
  },
  {
    id: "component.getAllOfType",
    title: "Get All Components Of Type",
    category: "component",
    pure: true,
    pins: () => [
      pin("classId", "Class", "in", classRef("ActorComponent")),
      pin("out", "Out", "out", arrayOf(objectRef("ActorComponent"))),
    ],
    codegen: (ctx) => ({
      out: `ctx.getAllComponentsOfType(${ctx.input("classId")})`,
    }),
  },
  {
    id: "component.get",
    title: "Get Component",
    category: "component",
    pure: true,
    pins: () => [
      selfActorPin("actor"),
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
      return [
        properties.implicitSelf === true
          ? selfPin("actor", "Target", objectRef("Actor"))
          : subject(pin("actor", "Target", "in", objectRef("Actor"))),
        pin("out", "out", "out", objectRef(classId)),
      ];
    },
    codegen: (ctx) => {
      const classId =
        typeof ctx.node.properties.componentClassId === "string" &&
        ctx.node.properties.componentClassId.trim()
          ? ctx.node.properties.componentClassId.trim()
          : "ActorComponent";
      return {
        out: `ctx.getComponent(${ctx.input("actor")}, ${JSON.stringify(classId)})`,
      };
    },
  },
  {
    id: "component.has",
    title: "Has Component",
    category: "component",
    pure: true,
    pins: () => [
      selfActorPin("actor"),
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
      selfActorPin("actor"),
      pin("classId", "classId", "in", classRef("ActorComponent")),
      pin("transform", "Transform", "in", TRANSFORM, "data", true),
      pin("out", "out", "out", objectRef("ActorComponent")),
    ],
    codegen: (ctx) => {
      const out = ctx.output("out");
      ctx.emit(
        `${out} = ctx.addComponent(${ctx.input("actor")}, ${ctx.input("classId")}, ${ctx.input("transform")});`,
      );
    },
  },
];
