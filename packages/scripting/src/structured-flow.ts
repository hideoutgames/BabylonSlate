/**
 * Structured control-flow metadata for graph nodes.
 * Compiler prefers these discriminators over scattered typeId checks for new
 * flow nodes. Branch / Sequence / Enum Switch keep their existing emission
 * paths for source stability.
 *
 * Owns Switch on Int / String and loop / stateful kinds (forLoop, Do Once,
 * Gate, …). Compiler emits loops and stateful flow from these discriminators
 * while preserving Branch / Sequence / Enum Switch source behavior.
 */

export type StructuredFlowKind =
  | "branch"
  | "sequence"
  | "forLoop"
  | "forLoopWithBreak"
  | "forEach"
  | "forEachWithBreak"
  | "forEachMap"
  | "forEachMapWithBreak"
  | "whileLoop"
  | "break"
  | "doOnce"
  | "doN"
  | "flipFlop"
  | "gate"
  | "switchOnInt"
  | "switchOnString";

export type StructuredFlowMeta =
  | {
      kind: "branch";
      conditionPin: string;
      truePin: string;
      falsePin: string;
    }
  | { kind: "sequence" }
  | {
      kind: "forLoop" | "forLoopWithBreak";
      firstIndexPin: string;
      lastIndexPin: string;
      loopBodyPin: string;
      completedPin: string;
      indexPin: string;
    }
  | {
      kind: "forEach" | "forEachWithBreak";
      arrayPin: string;
      loopBodyPin: string;
      completedPin: string;
      elementPin: string;
      indexPin: string;
    }
  | {
      kind: "forEachMap" | "forEachMapWithBreak";
      mapPin: string;
      loopBodyPin: string;
      completedPin: string;
      keyPin: string;
      valuePin: string;
      indexPin: string;
    }
  | {
      kind: "whileLoop";
      conditionPin: string;
      loopBodyPin: string;
      completedPin: string;
    }
  | { kind: "break" }
  | {
      kind: "doOnce";
      execPin: string;
      resetPin: string;
      thenPin: string;
    }
  | {
      kind: "doN";
      execPin: string;
      nPin: string;
      resetPin: string;
      thenPin: string;
      counterPin: string;
    }
  | {
      kind: "flipFlop";
      execPin: string;
      aPin: string;
      bPin: string;
      isAPin: string;
    }
  | {
      kind: "gate";
      enterPin: string;
      openPin: string;
      closePin: string;
      togglePin: string;
      exitPin: string;
      startClosed?: boolean;
    }
  | {
      kind: "switchOnInt" | "switchOnString";
      valuePin: string;
      defaultPin: string;
    };

export function isFlowSwitchKind(
  kind: StructuredFlowKind | undefined,
): boolean {
  return kind === "switchOnInt" || kind === "switchOnString";
}

export function isFlowSwitchMeta(
  meta: StructuredFlowMeta,
): meta is Extract<
  StructuredFlowMeta,
  { kind: "switchOnInt" | "switchOnString" }
> {
  return meta.kind === "switchOnInt" || meta.kind === "switchOnString";
}

export function isBreakableLoopKind(
  kind: StructuredFlowKind | undefined,
): boolean {
  return (
    kind === "forLoopWithBreak" ||
    kind === "forEachWithBreak" ||
    kind === "forEachMapWithBreak"
  );
}

export type LoopStructuredFlowMeta = Extract<
  StructuredFlowMeta,
  {
    kind:
      | "forLoop"
      | "forLoopWithBreak"
      | "forEach"
      | "forEachWithBreak"
      | "forEachMap"
      | "forEachMapWithBreak";
  }
>;

export function isLoopKind(kind: StructuredFlowKind | undefined): boolean {
  return (
    kind === "forLoop" ||
    kind === "forLoopWithBreak" ||
    kind === "forEach" ||
    kind === "forEachWithBreak" ||
    kind === "forEachMap" ||
    kind === "forEachMapWithBreak"
  );
}

export function isLoopMeta(
  meta: StructuredFlowMeta,
): meta is LoopStructuredFlowMeta {
  return isLoopKind(meta.kind);
}
