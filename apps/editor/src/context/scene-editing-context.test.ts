import { describe, expect, it } from "vitest";
import {
  selectionAfterLockChange,
} from "./scene-editing-context";

describe("selectionAfterLockChange", () => {
  it("drops only a newly locked actor from the selection", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", true)).toEqual([]);
    expect(
      selectionAfterLockChange(["a", "b", "c"], "b", true),
    ).toEqual(["a", "c"]);
    expect(selectionAfterLockChange(["a", "b"], "c", true)).toEqual(["a", "b"]);
  });

  it("does not change selection when unlocking", () => {
    expect(selectionAfterLockChange(["actor-1"], "actor-1", false)).toEqual([
      "actor-1",
    ]);
  });
});
