import type { BreakpointCondition, BreakpointConditionOp } from "@haptic/bridge";
import { humanizePropertyLabel } from "@haptic/editor-kit";
import type { SerializedPin } from "@haptic/graph-ui";

/** What a condition compares a pin's value as. */
export type ConditionValueKind = "number" | "boolean" | "string" | "object";

/** A data pin a breakpoint condition can read, named as the node shows it. */
export type ConditionPin = { id: string; direction: "in" | "out"; name: string; kind: ConditionValueKind };

/** A breakpoint's condition and hit count, as the editor sets them. */
export type BreakpointSettings = { condition?: BreakpointCondition; hitCount?: number };

const VALUE_KIND: Partial<Record<string, ConditionValueKind>> = {
  int: "number",
  float: "number",
  bool: "boolean",
  string: "string",
  objectRef: "object",
};

/** The comparisons each kind of value offers, in menu order. */
export const CONDITION_OPS: Record<ConditionValueKind, readonly BreakpointConditionOp[]> = {
  number: ["==", "!=", "<", "<=", ">", ">="],
  boolean: ["==", "!="],
  string: ["==", "!="],
  object: ["isValid", "isNotValid"],
};

export const CONDITION_OP_LABEL: Record<BreakpointConditionOp, string> = {
  "==": "=",
  "!=": "≠",
  "<": "<",
  "<=": "≤",
  ">": ">",
  ">=": "≥",
  isValid: "Is Valid",
  isNotValid: "Is Not Valid",
};

/**
 * The pins a condition can read: data outputs, and data inputs the node reads through a wire (an unwired
 * input holds its literal, so a condition on it could never change). Vectors, structures, collections
 * and wildcards have no comparison.
 */
export function conditionPins(pins: readonly SerializedPin[], isWired: (pinId: string) => boolean): ConditionPin[] {
  const offered: ConditionPin[] = [];
  for (const pin of pins) {
    const kind = pin.kind === "data" ? VALUE_KIND[pin.type.kind] : undefined;
    if (!kind || (pin.direction === "in" && !isWired(pin.id))) continue;
    offered.push({ id: pin.id, direction: pin.direction, name: humanizePropertyLabel(pin.name), kind });
  }
  return offered;
}

function operandText(value: BreakpointCondition["value"]): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value ?? "");
}

/** One line for a breakpoint's settings (`Health ≤ 0 · Hit 3`), or null when it stops on every run. */
export function describeBreakpointSettings({ condition, hitCount }: BreakpointSettings, pinName: string | undefined): string | null {
  const parts: string[] = [];
  if (condition) {
    const name = pinName ?? condition.pinId;
    const op = CONDITION_OP_LABEL[condition.op];
    parts.push(condition.op === "isValid" || condition.op === "isNotValid"
      ? `${name} ${op}`
      : `${name} ${op} ${operandText(condition.value)}`);
  }
  if (hitCount !== undefined) parts.push(`Hit ${hitCount}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
