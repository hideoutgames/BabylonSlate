import { describe, expect, it } from "vitest";
import { tryReparentUserClass } from "./reparent-class";

function classAsset(
  path: string,
  parentClass: string,
): {
  path: string;
  header: { type: string; name: string; parentClass: string };
} {
  return {
    path,
    header: { type: "Class", name: path, parentClass },
  };
}

describe("tryReparentUserClass", () => {
  const hero = classAsset("assets/Hero.class.babasset", "Actor");
  const pawn = classAsset("assets/Pawn.class.babasset", "Actor");
  const child = classAsset("assets/Child.class.babasset", "Hero");

  it("updates parentClass and leaves callers to keep graph payload", () => {
    const result = tryReparentUserClass({
      classId: "Child",
      newParentId: "Pawn",
      assets: [hero, pawn, child],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newParentId).toBe("Pawn");
      expect(result.value.previousParentId).toBe("Hero");
    }
  });

  it("rejects a cycle and does not invent a write", () => {
    const result = tryReparentUserClass({
      classId: "Hero",
      newParentId: "Child",
      assets: [hero, child],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects leaving Actor ancestry", () => {
    const result = tryReparentUserClass({
      classId: "Hero",
      newParentId: "BObject",
      assets: [hero],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown class", () => {
    const result = tryReparentUserClass({
      classId: "Missing",
      newParentId: "Actor",
      assets: [hero],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects reparenting a class onto itself", () => {
    const result = tryReparentUserClass({
      classId: "Hero",
      newParentId: "Hero",
      assets: [hero],
    });
    expect(result.ok).toBe(false);
  });
});
