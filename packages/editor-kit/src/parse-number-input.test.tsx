import { describe, expect, it } from "vitest";
import { parseNumberInput } from "./parse-number-input";

describe("parseNumberInput", () => {
  it("returns undefined for empty, whitespace, and incomplete drafts", () => {
    expect(parseNumberInput("")).toBeUndefined();
    expect(parseNumberInput("   ")).toBeUndefined();
    expect(parseNumberInput("-")).toBeUndefined();
    expect(parseNumberInput(".")).toBeUndefined();
    expect(parseNumberInput("-.")).toBeUndefined();
  });

  it("parses finite numbers including zero", () => {
    expect(parseNumberInput("30")).toBe(30);
    expect(parseNumberInput("0")).toBe(0);
    expect(parseNumberInput("0.5")).toBe(0.5);
    expect(parseNumberInput("-2")).toBe(-2);
  });

  it("returns undefined for non-numeric text", () => {
    expect(parseNumberInput("abc")).toBeUndefined();
  });
});
