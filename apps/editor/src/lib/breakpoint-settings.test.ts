import { describe, expect, it } from "vitest";
import type { SerializedPin } from "@haptic/graph-ui";
import { conditionPins, describeBreakpointSettings } from "./breakpoint-settings";

const pin = (id: string, direction: "in" | "out", kind: string, extra: Partial<SerializedPin> = {}): SerializedPin =>
  ({ id, name: id, kind: kind === "exec" ? "exec" : "data", direction, type: { kind }, ...extra });

describe("conditionPins", () => {
  it("offers outputs and wired inputs a comparison can read, named as the node shows them", () => {
    const pins = [
      pin("execIn", "in", "exec"),
      pin("lastIndex", "in", "int"),
      pin("firstIndex", "in", "int"),
      pin("target", "in", "objectRef"),
      pin("location", "in", "vec3"),
      pin("index", "out", "int"),
      pin("hit", "out", "bool"),
      pin("label", "out", "string"),
    ];
    const wired = new Set(["lastIndex", "target", "location"]);
    expect(conditionPins(pins, (pinId) => wired.has(pinId))).toEqual([
      { id: "lastIndex", direction: "in", name: "Last Index", kind: "number" },
      { id: "target", direction: "in", name: "Target", kind: "object" },
      { id: "index", direction: "out", name: "Index", kind: "number" },
      { id: "hit", direction: "out", name: "Hit", kind: "boolean" },
      { id: "label", direction: "out", name: "Label", kind: "string" },
    ]);
  });
});

describe("describeBreakpointSettings", () => {
  it("names the pin, the comparison and the hit", () => {
    expect(describeBreakpointSettings({
      condition: { pinId: "lastIndex", direction: "in", op: "<=", value: 0 }, hitCount: 3,
    }, "Last Index")).toBe("Last Index ≤ 0 · Hit 3");
    expect(describeBreakpointSettings({ condition: { pinId: "label", direction: "out", op: "!=", value: "Idle" } }, "Label"))
      .toBe("Label ≠ \"Idle\"");
    expect(describeBreakpointSettings({ condition: { pinId: "target", direction: "in", op: "isNotValid" } }, "Target"))
      .toBe("Target Is Not Valid");
    expect(describeBreakpointSettings({ condition: { pinId: "hit", direction: "out", op: "==", value: true } }, undefined))
      .toBe("hit = True");
    expect(describeBreakpointSettings({ hitCount: 1 }, undefined)).toBe("Hit 1");
    expect(describeBreakpointSettings({}, undefined)).toBeNull();
  });
});
