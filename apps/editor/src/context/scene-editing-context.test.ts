import { describe, expect, it } from "vitest";
import {
  resolveDocumentViewportMode,
  selectionAfterLockChange,
} from "./scene-editing-context";

describe("resolveDocumentViewportMode", () => {
  it("maps 2d and everything else to a ViewportMode", () => {
    expect(resolveDocumentViewportMode("2d")).toBe("2d");
    expect(resolveDocumentViewportMode("3d")).toBe("3d");
    expect(resolveDocumentViewportMode(null)).toBe("3d");
    expect(resolveDocumentViewportMode(undefined)).toBe("3d");
  });
});

describe("selectionAfterLockChange", () => {
  it("drops a newly locked actor from the selection", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", true)).toEqual([]);
    expect(
      selectionAfterLockChange(["a", "b", "c"], "b", true),
    ).toEqual(["a", "c"]);
  });

  it("does not change selection when unlocking", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", false)).toEqual([
      "actor-1",
    ]);
    expect(selectionAfterLockChange(["a", "b"], "c", true)).toEqual(["a", "b"]);
  });
});
