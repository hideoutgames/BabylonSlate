import {
  pin,
  type NodeDefinition,
  BOOL,
  COLOR,
  FLOAT,
} from "@haptic/scripting";
import { hoistedCall } from "./hoisted-helper";

/**
 * Color channels. Each node binds its color inputs once, so an impure color
 * is read once and every channel comes from the same value.
 */
const CHANNELS = ["x", "y", "z", "w"] as const;

export const colorNodes: NodeDefinition[] = [
  {
    id: "color.lerp",
    searchAliases: ["mix","mix(a,b,t)","lerp(a,b,t)"],
    title: "Lerp Color",
    category: "color",
    pure: true,
    pins: () => [
      pin("a", "A", "in", COLOR),
      pin("b", "B", "in", COLOR),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", COLOR),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(
        ctx,
        "__color_lerp",
        "a, b, t",
        `({ ${CHANNELS.map((c) => `${c}: a.${c} + (b.${c} - a.${c}) * t`).join(", ")} })`,
        [ctx.input("a"), ctx.input("b"), ctx.input("alpha")],
      ),
    }),
  },
  {
    id: "color.multiply",
    searchAliases: ["*","×","a * b"],
    title: "Multiply Color",
    category: "color",
    pure: true,
    pins: () => [
      pin("a", "A", "in", COLOR),
      pin("b", "B", "in", COLOR),
      pin("out", "Out", "out", COLOR),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(
        ctx,
        "__color_multiply",
        "a, b",
        `({ ${CHANNELS.map((c) => `${c}: a.${c} * b.${c}`).join(", ")} })`,
        [ctx.input("a"), ctx.input("b")],
      ),
    }),
  },
  {
    id: "color.nearlyEqual",
    searchAliases: ["≈","~="],
    title: "Color Nearly Equal",
    category: "color",
    pure: true,
    pins: () => [
      pin("a", "A", "in", COLOR),
      pin("b", "B", "in", COLOR),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: hoistedCall(
        ctx,
        "__color_nearlyEqual",
        "a, b",
        CHANNELS.map((c) => `Math.abs(a.${c} - b.${c}) < 1e-6`).join(" && "),
        [ctx.input("a"), ctx.input("b")],
      ),
    }),
  },
];
