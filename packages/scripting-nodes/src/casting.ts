import {
  pin,
  type NodeDefinition,
  FLOAT,
  INT,
  BOOL,
  objectRef,
  actorRef,
  createWildcardNodes,
} from "@babylonslate/scripting";

export const castingNodes: NodeDefinition[] = [
  {
    id: "casting.intToFloat",
    title: "Int To Float",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", INT),
      pin("out", "out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("in")})` }),
  },
  {
    id: "casting.floatToInt",
    title: "Float To Int",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", FLOAT),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("in")} | 0)` }),
  },
  {
    id: "casting.castActor",
    title: "Cast To Actor",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", objectRef("BObject")),
      pin("success", "success", "out", BOOL),
      pin("asActor", "asActor", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      // Pure multi-out via object — compiler expects map; use IIFE pair via side channel.
      // Represent as expressions referencing a shared temp is hard in pure mode;
      // emit as impure-style through codegen returning expressions that re-evaluate.
      const input = ctx.input("in");
      return {
        success: `(${input} != null && ${input}.classId)`,
        asActor: `(${input})`,
      };
    },
  },
  ...createWildcardNodes(),
];
