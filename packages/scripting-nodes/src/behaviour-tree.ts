import {
  pin,
  type NodeDefinition,
  EXEC,
  BOOL,
  STRING,
  BOXED_WILDCARD,
} from "@babylonslate/scripting";

/** Behaviour-tree task / decorator / service event entries, Finish Execute, Return Condition, and blackboard. */
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
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler; return via bt.returnCondition */
    },
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
  {
    id: "bt.returnCondition",
    title: "Return Condition",
    category: "behaviour-tree",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("condition", "condition", "in", BOOL, "data", true),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.btEvaluate(${ctx.input("condition")});`);
    },
  },
  {
    id: "bt.blackboard.get",
    title: "Get Blackboard",
    category: "behaviour-tree",
    pure: true,
    pins: () => [
      pin("key", "key", "in", STRING),
      pin("out", "out", "out", BOXED_WILDCARD),
    ],
    codegen: (ctx) => ({
      out: `ctx.getBlackboard(${ctx.input("key")})`,
    }),
  },
  {
    id: "bt.blackboard.set",
    title: "Set Blackboard",
    category: "behaviour-tree",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("key", "key", "in", STRING),
      pin("value", "value", "in", BOXED_WILDCARD),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setBlackboard(${ctx.input("key")}, ${ctx.input("value")});`,
      );
    },
  },
];
