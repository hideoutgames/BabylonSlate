import { describe, expect, it } from "vitest";
import { applyInspectSelectionToConsoleLine } from "./console-inspect";

describe("applyInspectSelectionToConsoleLine", () => {
  it("appends overlay selection only for bare inspect", () => {
    expect(applyInspectSelectionToConsoleLine("inspect", "cube")).toBe(
      "inspect cube",
    );
    expect(applyInspectSelectionToConsoleLine("inspect Cube", "cube")).toBe(
      "inspect Cube",
    );
    expect(applyInspectSelectionToConsoleLine("inspect", null)).toBe("inspect");
  });
});
