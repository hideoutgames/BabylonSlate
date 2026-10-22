import {
  pin,
  type NodeDefinition,
  BOOL,
  FLOAT,
  ROTATOR,
  VEC3,
} from "@haptic/scripting";
import { hoistedCall } from "./hoisted-helper";

export const rotatorNodes: NodeDefinition[] = [
  {
    id: "rotator.combine",
    title: "Combine Rotators",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("a", "A", "in", ROTATOR),
      pin("b", "B", "in", ROTATOR),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.combineRotators(${ctx.input("a")}, ${ctx.input("b")})`,
    }),
  },
  {
    id: "rotator.delta",
    title: "Delta Rotator",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("from", "From", "in", ROTATOR),
      pin("to", "To", "in", ROTATOR),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.deltaRotator(${ctx.input("from")}, ${ctx.input("to")})`,
    }),
  },
  {
    id: "rotator.inverse",
    title: "Inverse Rotator",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("in", "In", "in", ROTATOR),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.inverseRotator(${ctx.input("in")})`,
    }),
  },
  {
    id: "rotator.lerp",
    searchAliases: ["lerp(a,b,t)"],
    title: "Lerp Rotator",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("a", "A", "in", ROTATOR),
      pin("b", "B", "in", ROTATOR),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.lerpRotator(${ctx.input("a")}, ${ctx.input("b")}, ${ctx.input("alpha")})`,
    }),
  },
  {
    id: "rotator.forward",
    title: "Get Forward Vector",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("in", "In", "in", ROTATOR),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorForward(${ctx.input("in")})`,
    }),
  },
  {
    id: "rotator.right",
    title: "Get Right Vector",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("in", "In", "in", ROTATOR),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorRight(${ctx.input("in")})`,
    }),
  },
  {
    id: "rotator.up",
    title: "Get Up Vector",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("in", "In", "in", ROTATOR),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorUp(${ctx.input("in")})`,
    }),
  },
  {
    id: "rotator.lookAt",
    title: "Find Look At Rotation",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("from", "From", "in", VEC3),
      pin("target", "Target", "in", VEC3),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.lookAtRotator(${ctx.input("from")}, ${ctx.input("target")})`,
    }),
  },
  {
    id: "rotator.nearlyEqual",
    searchAliases: ["≈","~="],
    title: "Rotator Nearly Equal",
    category: "rotator",
    pure: true,
    pins: () => [
      pin("a", "A", "in", ROTATOR),
      pin("b", "B", "in", ROTATOR),
      pin("out", "Out", "out", BOOL),
    ],
    // Each axis difference wraps to [-180, 180), so 0 and 360 are equal.
    codegen: (ctx) => {
      ctx.hoist("var __rot_axisDelta = (x) => Math.abs((((x % 360) + 540) % 360) - 180);");
      return {
        out: hoistedCall(
          ctx,
          "__rot_nearlyEqual",
          "a, b",
          "__rot_axisDelta(a?.pitch - b?.pitch) < 1e-3 && __rot_axisDelta(a?.yaw - b?.yaw) < 1e-3 && __rot_axisDelta(a?.roll - b?.roll) < 1e-3",
          [ctx.input("a"), ctx.input("b")],
        ),
      };
    },
  },
];
