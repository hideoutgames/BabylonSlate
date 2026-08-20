import {
  pin,
  type NodeDefinition,
  EXEC,
  BOOL,
  FLOAT,
  INT,
  STRING,
  BOXED_WILDCARD,
  objectRef,
} from "@babylonslate/scripting";

function factExpr(field: string, fallback: string): string {
  return `(ctx.animFacts?.${field} ?? ${fallback})`;
}

function floatFact(id: string, title: string, field: string): NodeDefinition {
  return {
    id,
    title,
    category: "animation",
    pure: true,
    pins: () => [pin("value", "value", "out", FLOAT)],
    codegen: () => ({ value: factExpr(field, "0") }),
  };
}

function boolFact(id: string, title: string, field: string): NodeDefinition {
  return {
    id,
    title,
    category: "animation",
    pure: true,
    pins: () => [pin("value", "value", "out", BOOL)],
    codegen: () => ({ value: factExpr(field, "false") }),
  };
}

function intFact(id: string, title: string, field: string): NodeDefinition {
  return {
    id,
    title,
    category: "animation",
    pure: true,
    pins: () => [pin("value", "value", "out", INT)],
    codegen: () => ({ value: factExpr(field, "0") }),
  };
}

export const ANIMATION_EXCLUSIVE_NODE_PREFIX = "anim.";

export const animationNodes: NodeDefinition[] = [
  {
    id: "anim.event.initialize",
    title: "Event Initialize Animation",
    category: "animation",
    pure: true,
    pins: () => [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* entry point emitted by the compiler */
    },
  },
  {
    id: "anim.event.update",
    title: "Event Update Animation",
    category: "animation",
    pure: true,
    pins: () => [
      pin("execOut", "then", "out", EXEC),
      pin("deltaSeconds", "deltaSeconds", "out", FLOAT),
    ],
    codegen: () => ({ deltaSeconds: "ctx.deltaSeconds" }),
  },
  {
    id: "anim.rule.enterState",
    title: "Enter State",
    category: "animation",
    pure: true,
    pins: () => [pin("value", "value", "in", BOOL, "data", true)],
    codegen: () => {
      /* sink compiled by compileTransitionRuleGraph */
    },
  },
  {
    id: "anim.rule.exitState",
    title: "Exit State",
    category: "animation",
    pure: true,
    pins: () => [pin("value", "value", "in", BOOL, "data", true)],
    codegen: () => {
      /* sink compiled by compileTransitionRuleGraph */
    },
  },
  floatFact("anim.state.elapsedSeconds", "Elapsed Seconds", "elapsedSeconds"),
  floatFact("anim.state.durationSeconds", "Duration Seconds", "durationSeconds"),
  floatFact("anim.state.normalisedTime", "Normalised Time", "normalisedTime"),
  floatFact(
    "anim.state.remainingSeconds",
    "Remaining Seconds",
    "remainingSeconds",
  ),
  floatFact("anim.state.remainingRatio", "Remaining Ratio", "remainingRatio"),
  boolFact("anim.state.looping", "Is Looping", "looping"),
  intFact("anim.state.loopCount", "Loop Count", "loopCount"),
  boolFact("anim.state.justLooped", "Just Looped", "justLooped"),
  boolFact("anim.state.justFinished", "Just Finished", "justFinished"),
  {
    id: "anim.actor.getVariable",
    title: "Get Anim Graph Variable",
    category: "animation",
    pure: true,
    pins: () => [
      pin("target", "target", "in", objectRef("AnimationGraphComponent")),
      pin("name", "name", "in", STRING),
      pin("value", "value", "out", BOXED_WILDCARD),
    ],
    codegen: (ctx) => ({
      value: `ctx.getAnimGraphVariable(${ctx.input("target")}, ${ctx.input("name")})`,
    }),
  },
  {
    id: "anim.actor.setVariable",
    title: "Set Anim Graph Variable",
    category: "animation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", objectRef("AnimationGraphComponent")),
      pin("name", "name", "in", STRING),
      pin("value", "value", "in", BOXED_WILDCARD),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setAnimGraphVariable(${ctx.input("target")}, ${ctx.input("name")}, ${ctx.input("value")});`,
      );
    },
  },
  {
    id: "anim.actor.getCurrentState",
    title: "Get Current State",
    category: "animation",
    pure: true,
    pins: () => [
      pin("name", "name", "out", STRING),
      pin("id", "id", "out", STRING),
    ],
    codegen: () => ({
      name: `(ctx.getAnimGraphCurrentState()?.name ?? "")`,
      id: `(ctx.getAnimGraphCurrentState()?.id ?? "")`,
    }),
  },
  {
    id: "anim.actor.jumpToState",
    title: "Jump To State",
    category: "animation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("state", "state", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.jumpAnimGraphState(${ctx.input("state")});`);
    },
  },
];

export function isAnimationExclusiveNode(nodeId: string): boolean {
  return nodeId.startsWith(ANIMATION_EXCLUSIVE_NODE_PREFIX);
}

export function isAnimationRuleOnlyNode(nodeId: string): boolean {
  return (
    nodeId.startsWith("anim.rule.") || nodeId.startsWith("anim.state.")
  );
}

export function isAnimationObjectEventNode(nodeId: string): boolean {
  return (
    nodeId === "anim.event.initialize" || nodeId === "anim.event.update"
  );
}
