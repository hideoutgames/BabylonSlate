import {
  pin,
  type NodeDefinition,
  EXEC,
  STRING,
  objectRef,
  BOXED_WILDCARD,
} from "@babylonslate/scripting";

export const interfaceNodes: NodeDefinition[] = [
  {
    id: "interface.call",
    title: "Call Interface",
    category: "interface",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", objectRef("BObject")),
      pin("interfaceGuid", "interfaceGuid", "in", STRING),
      pin("method", "method", "in", STRING),
      pin("result", "result", "out", BOXED_WILDCARD),
    ],
    codegen: (ctx) => {
      const result = ctx.output("result");
      ctx.emit(
        `${result} = ctx.callInterface(${ctx.input("target")}, ${ctx.input("interfaceGuid")}, ${ctx.input("method")});`,
      );
    },
  },
];
