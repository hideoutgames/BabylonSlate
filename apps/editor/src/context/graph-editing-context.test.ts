import { describe, expect, it } from "vitest";
import { resolveInspectorNodeId } from "./graph-editing-context";

describe("resolveInspectorNodeId", () => {
  it("prefers the first canvas-selected node over diagnostic and play focus", () => {
    expect(
      resolveInspectorNodeId(["canvas-a", "canvas-b"], "diag-1", "play-1"),
    ).toBe("canvas-a");
  });

  it("falls back to the diagnostic node then play focus when nothing is selected", () => {
    expect(resolveInspectorNodeId([], "diag-1", "play-1")).toBe("diag-1");
    expect(resolveInspectorNodeId([], undefined, "play-1")).toBe("play-1");
  });

  it("returns undefined when there is no selection or focus", () => {
    expect(resolveInspectorNodeId([], undefined, null)).toBeUndefined();
  });
});
