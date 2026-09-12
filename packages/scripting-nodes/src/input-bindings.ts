import {
  BOOL,
  arrayOf,
  enumRef,
  structRef,
  EXEC,
  STRING,
  pin,
  type NodeDefinition,
} from "@babylonslate/scripting";

const execPins = () => [
  pin("execIn", "Exec", "in", EXEC),
  pin("execOut", "Then", "out", EXEC),
];
const INPUT_TYPE = structRef("engine:InputType");
const INPUT_BINDING = structRef("engine:InputBinding");
const KEY = enumRef("engine:Key");

const typedBindingNodes: NodeDefinition[] = (
  ["Action", "Axis"] as const
).flatMap<NodeDefinition>((kind) => [
  {
    id: `input.add${kind}Binding`,
    title: `Add Input ${kind} Binding`,
    category: "input",
    pins: () => [
      ...execPins(),
      pin("input", `Input ${kind}`, "in", INPUT_TYPE),
      pin("key", "Key", "in", KEY),
      pin("binding", "Binding Options", "in", INPUT_BINDING, "data", true),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.addInput${kind}Binding?.(${ctx.input("input")}, ${ctx.input("key")}, ${ctx.input("binding")}) ?? false;`,
      );
    },
  },
  {
    id: `input.set${kind}Binding`,
    title: `Set Input ${kind} Binding`,
    category: "input",
    pins: () => [
      ...execPins(),
      pin("binding", "Input Binding", "in", INPUT_BINDING),
      pin("key", "Key", "in", KEY),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.setInput${kind}Binding?.(${ctx.input("binding")}, ${ctx.input("key")}) ?? false;`,
      );
    },
  },
  {
    id: `input.remove${kind}Binding`,
    title: `Remove Input ${kind} Binding`,
    category: "input",
    pins: () => [
      ...execPins(),
      pin("input", `Input ${kind}`, "in", INPUT_TYPE),
      pin("key", "Key", "in", KEY),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.removeInput${kind}Binding?.(${ctx.input("input")}, ${ctx.input("key")}) ?? false;`,
      );
    },
  },
]);

/** Player-owned overrides; these nodes never alter authored project defaults. */
export const inputBindingNodes: NodeDefinition[] = [
  ...typedBindingNodes,
  {
    id: "input.bindings",
    title: "Get Input Bindings",
    category: "input",
    pure: true,
    pins: () => [
      pin("input", "Input", "in", structRef("engine:InputType")),
      pin(
        "bindings",
        "Bindings",
        "out",
        arrayOf(structRef("engine:InputBinding")),
      ),
    ],
    codegen: (ctx) => ({
      bindings: `(ctx.inputBindings?.getInputBindings?.(${ctx.input("input")}) ?? [])`,
    }),
  },
  {
    id: "input.resetInput",
    title: "Reset Input Bindings",
    category: "input",
    pins: () => [
      ...execPins(),
      pin("input", "Input", "in", structRef("engine:InputType")),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.resetInputBindings?.(${ctx.input("input")}) ?? false;`,
      );
    },
  },
  {
    id: "input.resetAllBindings",
    title: "Reset All Input Bindings",
    category: "input",
    pins: execPins,
    codegen: (ctx) => {
      ctx.emit("ctx.inputBindings?.resetBindings();");
    },
  },
  {
    id: "input.exportBindings",
    title: "Export Input Bindings",
    category: "input",
    pure: true,
    pins: () => [pin("data", "Data", "out", STRING)],
    codegen: () => ({ data: '(ctx.inputBindings?.exportBindings() ?? "")' }),
  },
  {
    id: "input.importBindings",
    title: "Import Input Bindings",
    category: "input",
    pins: () => [
      ...execPins(),
      pin("data", "Data", "in", STRING),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${ctx.output("success")} = ctx.inputBindings?.importBindings(${ctx.input("data")}) ?? false;`,
      );
    },
  },
];
