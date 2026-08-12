import {
  pin,
  type NodeDefinition,
  BOOL,
  FLOAT,
  VEC2,
  STRING,
} from "@babylonslate/scripting";

/** Stubs until P6 input mappings. */
export const inputNodes: NodeDefinition[] = [
  {
    id: "input.isActionHeld",
    title: "Is Action Held",
    category: "input",
    pure: true,
    pins: () => [
      pin("action", "action", "in", STRING),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `ctx.isActionHeld(${ctx.input("action")})`,
    }),
  },
  {
    id: "input.getAxis",
    title: "Get Axis",
    category: "input",
    pure: true,
    pins: () => [
      pin("axis", "axis", "in", STRING),
      pin("out", "out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `ctx.getAxis(${ctx.input("axis")})` }),
  },
  {
    id: "input.getAxis2D",
    title: "Get Axis 2D",
    category: "input",
    pure: true,
    pins: () => [
      pin("axis", "axis", "in", STRING),
      pin("out", "out", "out", VEC2),
    ],
    codegen: (ctx) => ({ out: `ctx.getAxis2D(${ctx.input("axis")})` }),
  },
];
