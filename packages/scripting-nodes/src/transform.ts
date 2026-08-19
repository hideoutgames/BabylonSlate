import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  TRANSFORM,
  ROTATOR,
  actorRef,
} from "@babylonslate/scripting";

export const transformNodes: NodeDefinition[] = [
  {
    id: "transform.getLocation",
    title: "Get Actor Location",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("target")}?.transform?.position ?? { x: 0, y: 0, z: 0 })`,
    }),
  },
  {
    id: "transform.setLocation",
    title: "Set Actor Location",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "Target", "in", actorRef("Actor")),
      pin("location", "Location", "in", VEC3),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setActorLocation(${ctx.input("target")}, ${ctx.input("location")});`,
      );
    },
  },
  {
    id: "transform.getRotation",
    title: "Get Actor Rotation",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.quatToRotator(${ctx.input("target")}?.transform?.rotation)`,
    }),
  },
  {
    id: "transform.setRotation",
    title: "Set Actor Rotation",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "Target", "in", actorRef("Actor")),
      pin("rotation", "Rotation", "in", ROTATOR),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setActorRotation(${ctx.input("target")}, ${ctx.input("rotation")});`,
      );
    },
  },
  {
    id: "transform.getScale",
    title: "Get Actor Scale",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("target")}?.transform?.scale ?? { x: 1, y: 1, z: 1 })`,
    }),
  },
  {
    id: "transform.setScale",
    title: "Set Actor Scale",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "Target", "in", actorRef("Actor")),
      pin("scale", "Scale", "in", VEC3),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setActorScale(${ctx.input("target")}, ${ctx.input("scale")});`,
      );
    },
  },
  {
    id: "transform.get",
    title: "Get Actor Transform",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", TRANSFORM),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("target")}?.transform ?? null)`,
    }),
  },
  {
    id: "transform.set",
    title: "Set Actor Transform",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "Target", "in", actorRef("Actor")),
      pin("transform", "Transform", "in", TRANSFORM),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setActorTransform(${ctx.input("target")}, ${ctx.input("transform")});`,
      );
    },
  },
  {
    id: "transform.forward",
    title: "Get Actor Forward Vector",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorForward(ctx.quatToRotator(${ctx.input("target")}?.transform?.rotation))`,
    }),
  },
  {
    id: "transform.right",
    title: "Get Actor Right Vector",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorRight(ctx.quatToRotator(${ctx.input("target")}?.transform?.rotation))`,
    }),
  },
  {
    id: "transform.up",
    title: "Get Actor Up Vector",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "Target", "in", actorRef("Actor")),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorUp(ctx.quatToRotator(${ctx.input("target")}?.transform?.rotation))`,
    }),
  },
  {
    id: "transform.addWorldOffset",
    title: "Add World Offset",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "Target", "in", actorRef("Actor")),
      pin("offset", "Offset", "in", VEC3),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.addActorWorldOffset(${ctx.input("target")}, ${ctx.input("offset")});`,
      );
    },
  },
];
