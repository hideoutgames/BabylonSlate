import {
  pin,
  type NodeDefinition,
  EXEC,
  BOOL,
  FLOAT,
  INT,
  STRING,
  BOXED_WILDCARD,
  ENGINE_ANIMATION_TICK_MODE_ENUM_ID,
  enumRef,
  objectRef,
  assetRef,
} from "@haptic/scripting";
import { subject } from "./self-pin";

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
    // One per Animation Event name (`eventName`), in the Animation Object only. It runs when this graph fires the
    // event: a single event through Then, a window (`window`) through Begin and End.
    id: "anim.event.notify",
    title: "Animation Event",
    category: "animation",
    pure: true,
    pins: (properties) =>
      properties.window === true
        ? [pin("begin", "Begin", "out", EXEC), pin("end", "End", "out", EXEC)]
        : [pin("execOut", "then", "out", EXEC)],
    codegen: () => {
      /* gated entry compiled by emitInputEventEntry */
    },
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
  floatFact("anim.state.elapsedSeconds", "Get Elapsed Seconds", "elapsedSeconds"),
  floatFact("anim.state.durationSeconds", "Get Duration Seconds", "durationSeconds"),
  floatFact("anim.state.normalisedTime", "Get Normalized Time", "normalisedTime"),
  floatFact(
    "anim.state.remainingSeconds",
    "Get Remaining Seconds",
    "remainingSeconds",
  ),
  floatFact("anim.state.remainingRatio", "Get Remaining Ratio", "remainingRatio"),
  boolFact("anim.state.looping", "Is Looping", "looping"),
  intFact("anim.state.loopCount", "Get Loop Count", "loopCount"),
  boolFact("anim.state.justLooped", "Just Looped", "justLooped"),
  boolFact("anim.state.justFinished", "Just Finished", "justFinished"),
  {
    // Crossing test lives in @haptic/anim-graph (`animExitTimeReached`);
    // the host binds it to this tick's facts.
    id: "anim.state.exitTimeReached",
    title: "Exit Time Reached",
    category: "animation",
    pure: true,
    pins: () => [
      pin("exitTime", "exitTime", "in", FLOAT, "data", false, 1),
      pin("value", "value", "out", BOOL),
    ],
    codegen: (ctx) => ({
      value: `(ctx.animExitTimeReached?.(${ctx.input("exitTime")}) ?? false)`,
    }),
  },
  {
    id: "anim.actor.getVariable",
    title: "Get Anim Graph Variable",
    category: "animation",
    pure: true,
    pins: () => [
      subject(pin("target", "target", "in", objectRef("AnimationGraphComponent"))),
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
      subject(pin("target", "target", "in", objectRef("AnimationGraphComponent"))),
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
      subject(pin("target", "target", "in", objectRef("AnimationGraphComponent"))),
      pin("name", "name", "out", STRING),
      pin("id", "id", "out", STRING),
    ],
    codegen: (ctx) => ({
      name: `(ctx.getAnimGraphCurrentState(${ctx.input("target")})?.name ?? "")`,
      id: `(ctx.getAnimGraphCurrentState(${ctx.input("target")})?.id ?? "")`,
    }),
  },
  {
    id: "anim.actor.jumpToState",
    title: "Jump To State",
    category: "animation",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", objectRef("AnimationGraphComponent"))),
      pin("state", "state", "in", STRING),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.jumpAnimGraphState(${ctx.input("target")}, ${ctx.input("state")});`,
      );
    },
  },
  {
    id: "anim.actor.playSlotAnimation",
    title: "Play Slot Animation",
    category: "animation",
    latent: true,
    description: "Plays an Animation (3D) or Sprite Animation (2D) once on a slot of the graph, over what the slot shows. On Blend Out runs as it starts blending out, On Completed once it has played through.",
    searchAliases: ["montage", "one shot", "play animation"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("onBlendOut", "On Blend Out", "out", EXEC),
      pin("onCompleted", "On Completed", "out", EXEC),
      subject(pin("target", "Target", "in", objectRef("AnimationGraphComponent"))),
      pin("animation", "Animation", "in", assetRef("Animation")),
      pin("slotName", "Slot Name", "in", STRING, "data", true, "DefaultSlot"),
      pin("blendInTime", "Blend In Time", "in", FLOAT, "data", true, 0.25),
      pin("blendOutTime", "Blend Out Time", "in", FLOAT, "data", true, 0.25),
      pin("playRate", "Play Rate", "in", FLOAT, "data", true, 1),
      pin("loopCount", "Loop Count", "in", INT, "data", true, 1),
      pin("startTime", "Start Time", "in", FLOAT, "data", true, 0),
    ],
    codegen: (ctx) => {
      const handle = `__slotPlay_${ctx.node.id.replace(/[^A-Za-z0-9_$]/g, "_")}`;
      const args = ["target", "animation", "slotName", "blendInTime", "blendOutTime", "playRate", "loopCount", "startTime"]
        .map((name) => ctx.input(name)).join(", ");
      ctx.emit(`const ${handle} = ctx.playSlotAnimation(${args});`);
      // Each output runs as the play reaches it: its blend out, then its end (only when it played through).
      ctx.runOutputIf?.(`(yield ctx.waitSlotAnimation(${handle}, "blendOut"))`, "onBlendOut");
      ctx.runOutputIf?.(`(yield ctx.waitSlotAnimation(${handle}, "completed"))`, "onCompleted");
    },
  },
  {
    id: "anim.actor.stopSlotAnimation",
    title: "Stop Slot Animation",
    category: "animation",
    description: "Blends a slot's Animation out over Blend Out Time; its Play Slot Animation runs On Blend Out but not On Completed.",
    searchAliases: ["stop montage"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "Target", "in", objectRef("AnimationGraphComponent"))),
      pin("slotName", "Slot Name", "in", STRING, "data", true, "DefaultSlot"),
      pin("blendOutTime", "Blend Out Time", "in", FLOAT, "data", true, 0.25),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.stopSlotAnimation(${ctx.input("target")}, ${ctx.input("slotName")}, ${ctx.input("blendOutTime")});`);
    },
  },
  {
    id: "anim.actor.isSlotActive",
    title: "Is Slot Active",
    category: "animation",
    description: "Whether a slot is playing an Animation, blending out included.",
    pure: true,
    searchAliases: ["is playing slot animation", "montage is playing"],
    pins: () => [
      subject(pin("target", "Target", "in", objectRef("AnimationGraphComponent"))),
      pin("slotName", "Slot Name", "in", STRING, "data", true, "DefaultSlot"),
      pin("value", "value", "out", BOOL),
    ],
    codegen: (ctx) => ({
      value: `ctx.isSlotActive(${ctx.input("target")}, ${ctx.input("slotName")})`,
    }),
  },
  {
    id: "anim.actor.getTickMode",
    title: "Get Animation Tick Mode",
    category: "animation",
    pure: true,
    searchAliases: ["visibility based tick", "update when visible", "pause animation"],
    pins: () => [
      subject(pin("target", "Target", "in", objectRef("AnimationGraphComponent"))),
      pin("tickMode", "Tick Mode", "out", enumRef(ENGINE_ANIMATION_TICK_MODE_ENUM_ID)),
    ],
    codegen: (ctx) => ({
      tickMode: `ctx.getAnimGraphTickMode(${ctx.input("target")})`,
    }),
  },
  {
    id: "anim.actor.setTickMode",
    title: "Set Animation Tick Mode",
    category: "animation",
    searchAliases: ["visibility based tick", "update when visible", "pause animation", "stop animation"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "Target", "in", objectRef("AnimationGraphComponent"))),
      pin("tickMode", "Tick Mode", "in", enumRef(ENGINE_ANIMATION_TICK_MODE_ENUM_ID), "data", true, "Always"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setAnimGraphTickMode(${ctx.input("target")}, ${ctx.input("tickMode")});`);
    },
  },
];
