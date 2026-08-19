import { describe, expect, it } from "vitest";
import {
  FLOW_SWITCH_CASE_PREFIX,
  flowSwitchCasePinId,
  flowSwitchCaseValueFromPinId,
  normalizeIntSwitchCases,
  normalizeStringSwitchCases,
} from "./flow-switch-pins";

describe("flow switch case pin ids", () => {
  it("encodes case values into stable case: pin ids", () => {
    expect(FLOW_SWITCH_CASE_PREFIX).toBe("case:");
    expect(flowSwitchCasePinId("0")).toBe("case:0");
    expect(flowSwitchCasePinId("hello")).toBe("case:hello");
    expect(flowSwitchCasePinId("a/b")).toBe("case:a%2Fb");
    expect(flowSwitchCasePinId("red team")).toBe("case:red%20team");
  });

  it("decodes encoded case pin ids back to the authored value", () => {
    expect(flowSwitchCaseValueFromPinId("case:0")).toBe("0");
    expect(flowSwitchCaseValueFromPinId("case:hello")).toBe("hello");
    expect(flowSwitchCaseValueFromPinId("case:a%2Fb")).toBe("a/b");
    expect(flowSwitchCaseValueFromPinId("case:red%20team")).toBe("red team");
    expect(flowSwitchCaseValueFromPinId("default")).toBeUndefined();
    expect(flowSwitchCaseValueFromPinId("then")).toBeUndefined();
  });
});

describe("normalizeIntSwitchCases", () => {
  it("keeps finite integers in order and floors floats", () => {
    expect(normalizeIntSwitchCases([1, 2.9, -3])).toEqual({
      cases: [1, 2, -3],
      warnings: [],
    });
  });

  it("accepts numeric strings from NamedListEditor rows", () => {
    expect(normalizeIntSwitchCases(["0", " 4 ", "9"])).toEqual({
      cases: [0, 4, 9],
      warnings: [],
    });
  });

  it("drops empty rows and diagnoses them", () => {
    const result = normalizeIntSwitchCases(["1", "", "  ", "2"]);
    expect(result.cases).toEqual([1, 2]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "flow.switch.empty_case" }),
      expect.objectContaining({ code: "flow.switch.empty_case" }),
    ]);
  });

  it("drops duplicates keeping the first and diagnoses them", () => {
    const result = normalizeIntSwitchCases([1, 2, 1, "2"]);
    expect(result.cases).toEqual([1, 2]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "flow.switch.duplicate_case",
        value: "1",
      }),
      expect.objectContaining({
        code: "flow.switch.duplicate_case",
        value: "2",
      }),
    ]);
  });

  it("drops non-integer values and diagnoses them", () => {
    const result = normalizeIntSwitchCases(["1", "nope", Number.NaN, Infinity]);
    expect(result.cases).toEqual([1]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "flow.switch.invalid_int",
        value: "nope",
      }),
      expect.objectContaining({ code: "flow.switch.invalid_int" }),
      expect.objectContaining({ code: "flow.switch.invalid_int" }),
    ]);
  });
});

describe("normalizeStringSwitchCases", () => {
  it("keeps nonempty strings in order", () => {
    expect(normalizeStringSwitchCases(["idle", "run", "jump"])).toEqual({
      cases: ["idle", "run", "jump"],
      warnings: [],
    });
  });

  it("drops empty rows and diagnoses them", () => {
    const result = normalizeStringSwitchCases(["a", "", "b", "  "]);
    expect(result.cases).toEqual(["a", "b"]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "flow.switch.empty_case" }),
      expect.objectContaining({ code: "flow.switch.empty_case" }),
    ]);
  });

  it("drops duplicates keeping the first and diagnoses them", () => {
    const result = normalizeStringSwitchCases(["red", "blue", "red"]);
    expect(result.cases).toEqual(["red", "blue"]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "flow.switch.duplicate_case",
        value: "red",
      }),
    ]);
  });

  it("preserves internal whitespace and special characters", () => {
    expect(normalizeStringSwitchCases(["a/b", "red team"])).toEqual({
      cases: ["a/b", "red team"],
      warnings: [],
    });
  });
});
