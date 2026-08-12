import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  TRANSFORM,
  actorRef,
} from "@babylonslate/scripting";

export const transformNodes: NodeDefinition[] = [
  {
    id: "transform.getLocation",
    title: "Get Actor Location",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "target", "in", actorRef("Actor")),
      pin("out", "out", "out", VEC3),
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
      pin("target", "target", "in", actorRef("Actor")),
      pin("location", "location", "in", VEC3),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setActorLocation(${ctx.input("target")}, ${ctx.input("location")});`,
      );
    },
  },
  {
    id: "transform.get",
    title: "Get Transform",
    category: "transform",
    pure: true,
    pins: () => [
      pin("target", "target", "in", actorRef("Actor")),
      pin("out", "out", "out", TRANSFORM),
    ],
    codegen: (ctx) => ({
      out: `(${ctx.input("target")}?.transform ?? null)`,
    }),
  },
];
