import { pin, type NodeDefinition, EXEC, BOOL } from "@babylonslate/scripting";

/** Behaviour-tree task / decorator / service event entries and Finish Execute. */
export const behaviourTreeNodes: NodeDefinition[] = [
  {
    id: "bt.event.activate",
    title: "On Activate",
    category: "behaviour-tree",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "bt.event.tick",
    title: "On Tick",
    category: "behaviour-tree",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "bt.event.abort",
    title: "On Abort",
    category: "behaviour-tree",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "bt.event.evaluate",
    title: "On Evaluate",
    category: "behaviour-tree",
    pure: true,
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("result", "result", "out", BOOL),
    ],
    codegen: () => ({ result: "true" }),
  },
  {
    id: "bt.finish",
    title: "Finish Execute",
    category: "behaviour-tree",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("success", "success", "in", BOOL, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.btFinish(${ctx.input("success")} ? "success" : "failure");`,
      );
    },
  },
];
