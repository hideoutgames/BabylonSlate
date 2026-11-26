import {
  pin,
  type NodeDefinition,
  type UnboxedVector,
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

const actorVectorUnboxed = (ctx: Ctx, field: "position" | "scale", fallback: number): Record<string, UnboxedVector> | undefined => {
  if (!ctx.allocTemp) return undefined;
  const v = ctx.allocTemp();
  const x = ctx.allocTemp();
  const y = ctx.allocTemp();
  const z = ctx.allocTemp();
  const setup = `(${v} = (${ctx.input("target")})?.transform?.${field}, ${x} = ${v} ? ${v}.x : ${fallback}, ${y} = ${v} ? ${v}.y : ${fallback}, ${z} = ${v} ? ${v}.z : ${fallback})`;
  return { out: { kind: "vec3", x, y, z, setup } };
};

const actorTransform = (ctx: Ctx): string =>
  hoistedCall(ctx, "__xf_transform", "a",
    "{ const t = a?.transform; return { position: { x: 0, y: 0, z: 0, ...t?.position }, rotation: { x: 0, y: 0, z: 0, w: 1, ...t?.rotation }, scale: { x: 1, y: 1, z: 1, ...t?.scale } }; }",
    [ctx.input("target")]);

/**
 * Inline quaternion basis formulas matching `quatRotateVector(q, axis)` bit-for-bit,
 * skipping `{ x, y, z }` input literal allocation and skipping `Math.sqrt` for unit quats.
 */
const QUAT_BASIS_HELPERS =
  "var __xf_axis_x=0,__xf_axis_y=0,__xf_axis_z=0," +
  "__xf_quatBasis=(a,axis)=>{const q=a?.transform?.rotation;" +
  "if(!q){__xf_axis_x=axis===0?1:0;__xf_axis_y=axis===1?1:0;__xf_axis_z=axis===2?1:0;return;}" +
  "let x=Number(q.x??0),y=Number(q.y??0),z=Number(q.z??0),w=Number(q.w??1);" +
  "const ls=x*x+y*y+z*z+w*w;" +
  "if(ls<=1e-16){x=0;y=0;z=0;w=1;}else if(Math.abs(ls-1)>1e-6){const inv=1/Math.sqrt(ls);x*=inv;y*=inv;z*=inv;w*=inv;}" +
  "if(axis===2){__xf_axis_x=2*(w*y+z*x);__xf_axis_y=2*(y*z-w*x);__xf_axis_z=1-2*(x*x+y*y);}" +
  "else if(axis===0){__xf_axis_x=1-2*(y*y+z*z);__xf_axis_y=2*(x*y+w*z);__xf_axis_z=2*(x*z-w*y);}" +
  "else{__xf_axis_x=2*(x*y-w*z);__xf_axis_y=1-2*(x*x+z*z);__xf_axis_z=2*(y*z+w*x);}}," +
  "__xf_forward=(a)=>{__xf_quatBasis(a,2);return{x:__xf_axis_x,y:__xf_axis_y,z:__xf_axis_z};}," +
  "__xf_right=(a)=>{__xf_quatBasis(a,0);return{x:__xf_axis_x,y:__xf_axis_y,z:__xf_axis_z};}," +
  "__xf_up=(a)=>{__xf_quatBasis(a,1);return{x:__xf_axis_x,y:__xf_axis_y,z:__xf_axis_z};};";

const actorAxis = (ctx: Ctx, helper: "__xf_forward" | "__xf_right" | "__xf_up"): string => {
  ctx.hoist(QUAT_BASIS_HELPERS);
  return `${helper}(${ctx.input("target")})`;
};

const actorAxisUnboxed = (ctx: Ctx, axisIndex: 0 | 1 | 2): Record<string, UnboxedVector> | undefined => {
  if (!ctx.allocTemp) return undefined;
  ctx.hoist(QUAT_BASIS_HELPERS);
  const x = ctx.allocTemp();
  const y = ctx.allocTemp();
  const z = ctx.allocTemp();
  const setup = `(__xf_quatBasis(${ctx.input("target")}, ${axisIndex}), ${x} = __xf_axis_x, ${y} = __xf_axis_y, ${z} = __xf_axis_z)`;
  return { out: { kind: "vec3", x, y, z, setup } };
};

function emitActorVec3Setter(
  ctx: Ctx,
  pinName: string,
  boxedMethod: "setActorLocation" | "addActorWorldOffset" | "setActorScale",
  xyzMethod: "setActorLocationXYZ" | "addActorWorldOffsetXYZ" | "setActorScaleXYZ",
): void {
  const target = ctx.input("target");
  if (ctx.isWired(pinName)) {
    const u = ctx.inputUnboxed?.(pinName);
    if (u && u.kind === "vec3") {
      if (u.setup) ctx.emit(`${u.setup};`);
      ctx.emit(`ctx.${xyzMethod}(${target}, ${u.x}, ${u.y}, ${u.z});`);
      return;
    }
  }
  ctx.emit(`ctx.${boxedMethod}(${target}, ${ctx.input(pinName)});`);
}

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
    codegenUnboxed: (ctx) => actorVectorUnboxed(ctx, "position", 0),
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
      emitActorVec3Setter(ctx, "location", "setActorLocation", "setActorLocationXYZ");
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
    codegenUnboxed: (ctx) => actorVectorUnboxed(ctx, "scale", 1),
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
      emitActorVec3Setter(ctx, "scale", "setActorScale", "setActorScaleXYZ");
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
      out: actorAxis(ctx, "__xf_forward"),
    }),
    codegenUnboxed: (ctx) => actorAxisUnboxed(ctx, 2),
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
      out: actorAxis(ctx, "__xf_right"),
    }),
    codegenUnboxed: (ctx) => actorAxisUnboxed(ctx, 0),
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
      out: actorAxis(ctx, "__xf_up"),
    }),
    codegenUnboxed: (ctx) => actorAxisUnboxed(ctx, 1),
  },
  {
    id: "transform.addWorldOffset",
    title: "Add Actor World Offset",
    category: "transform",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      selfActorPin("target", "Target"),
      pin("offset", "Offset", "in", VEC3),
    ],
    codegen: (ctx) => {
      emitActorVec3Setter(ctx, "offset", "addActorWorldOffset", "addActorWorldOffsetXYZ");
    },
  },
];
