import {
  pin,
  type NodeDefinition,
  EXEC,
  VEC3,
  TRANSFORM,
  ROTATOR,
} from "@haptic/scripting";
import { hoistedCall } from "./hoisted-helper";
import { selfActorPin } from "./self-pin";

type Ctx = Parameters<NodeDefinition["codegen"]>[0];

/**
 * The actor getters return copies. The runtime moves an actor by writing into its transform's own
 * position, rotation and scale objects, so a value that aliased one would follow the actor: a
 * stored start location would always equal the current one.
 */
const actorVector = (ctx: Ctx, field: "position" | "scale", fallback: number): string =>
  hoistedCall(ctx, `__xf_${field}`, "a",
    `{ const v = a?.transform?.${field}; return v ? { x: v.x, y: v.y, z: v.z } : { x: ${fallback}, y: ${fallback}, z: ${fallback} }; }`,
    [ctx.input("target")]);

const actorTransform = (ctx: Ctx): string =>
  hoistedCall(ctx, "__xf_transform", "a",
    "{ const t = a?.transform; return { position: { x: 0, y: 0, z: 0, ...t?.position }, rotation: { x: 0, y: 0, z: 0, w: 1, ...t?.rotation }, scale: { x: 1, y: 1, z: 1, ...t?.scale } }; }",
    [ctx.input("target")]);

/** A local axis of the actor in world space, rotated by its quaternion without a detour through Euler angles. */
const actorAxis = (ctx: Ctx, axis: string): string =>
  `ctx.quatRotateVector(${ctx.input("target")}?.transform?.rotation, ${axis})`;

export const transformNodes: NodeDefinition[] = [
  {
    id: "transform.getLocation",
    title: "Get Actor Location",
    category: "transform",
    pure: true,
    pins: () => [
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({ out: actorVector(ctx, "position", 0) }),
  },
  {
    id: "transform.setLocation",
    title: "Set Actor Location",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
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
      selfActorPin("target", "Target"),
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
      selfActorPin("target", "Target"),
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
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({ out: actorVector(ctx, "scale", 1) }),
  },
  {
    id: "transform.setScale",
    title: "Set Actor Scale",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
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
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", TRANSFORM),
    ],
    codegen: (ctx) => ({ out: actorTransform(ctx) }),
  },
  {
    id: "transform.set",
    title: "Set Actor Transform",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
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
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: actorAxis(ctx, "{ x: 0, y: 0, z: 1 }"),
    }),
  },
  {
    id: "transform.right",
    title: "Get Actor Right Vector",
    category: "transform",
    pure: true,
    pins: () => [
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: actorAxis(ctx, "{ x: 1, y: 0, z: 0 }"),
    }),
  },
  {
    id: "transform.up",
    title: "Get Actor Up Vector",
    category: "transform",
    pure: true,
    pins: () => [
      selfActorPin("target", "Target"),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: actorAxis(ctx, "{ x: 0, y: 1, z: 0 }"),
    }),
  },
  {
    id: "transform.addWorldOffset",
    title: "Add World Offset",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
      pin("offset", "Offset", "in", VEC3),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.addActorWorldOffset(${ctx.input("target")}, ${ctx.input("offset")});`,
      );
    },
  },
];
