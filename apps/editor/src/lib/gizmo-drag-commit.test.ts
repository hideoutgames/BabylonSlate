import { describe, expect, it } from "vitest";
import { takeGizmoDragScene } from "./gizmo-drag-commit";

describe("takeGizmoDragScene", () => {
  it("returns the drag-start scene once and clears the ref", () => {
    const scene = { name: "Main" };
    const ref = { current: scene };
    expect(takeGizmoDragScene(ref)).toBe(scene);
    expect(ref.current).toBeNull();
  });

  it("returns null when no drag is in progress", () => {
    expect(takeGizmoDragScene({ current: null })).toBeNull();
  });
});
