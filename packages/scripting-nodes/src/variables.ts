import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
  BOXED_WILDCARD,
} from "@babylonslate/scripting";

export const variableNodes: NodeDefinition[] = [
  {
    id: "variables.get",
    title: "Get Variable",
    category: "variables",
    pure: true,
    pins: () => [
      pin("name", "name", "in", STRING),
      pin("out", "out", "out", BOXED_WILDCARD),
    ],
    codegen: (ctx) => ({
      out: `ctx.getVariable(${ctx.input("name")})`,
    }),
  },
  {
    id: "variables.set",
    title: "Set Variable",
    category: "variables",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("name", "name", "in", STRING),
      pin("value", "value", "in", BOXED_WILDCARD),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setVariable(${ctx.input("name")}, ${ctx.input("value")});`,
      );
    },
  },
];
