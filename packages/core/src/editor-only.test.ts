import { describe, expect, it } from "vitest";
import {
  isEditorOnlyAsset,
  isEditorOnlyAssetType,
  isEditorUtilityObjectClass,
  normalizeEditorUtilityDockKind,
} from "./editor-only";

describe("editor-only assets", () => {
  const parentOf = (id: string) => {
    if (id === "LevelTools") return "EditorUtilityObject";
    if (id === "EditorUtilityObject") return "BObject";
    if (id === "Hero") return "Actor";
    return null;
  };

  it("treats EditorUtilityInterface as editor-only", () => {
    expect(isEditorOnlyAssetType("EditorUtilityInterface")).toBe(true);
    expect(isEditorOnlyAssetType("UserInterface")).toBe(false);
    expect(
      isEditorOnlyAsset(
        { type: "EditorUtilityInterface", parentClass: null },
        parentOf,
      ),
    ).toBe(true);
  });

  it("walks the EditorUtilityObject parent chain on Class assets", () => {
    expect(isEditorUtilityObjectClass("LevelTools", parentOf)).toBe(true);
    expect(isEditorUtilityObjectClass("Hero", parentOf)).toBe(false);
    expect(
      isEditorOnlyAsset(
        { type: "Class", parentClass: "LevelTools" },
        parentOf,
      ),
    ).toBe(true);
    expect(
      isEditorOnlyAsset({ type: "Class", parentClass: "Actor" }, parentOf),
    ).toBe(false);
  });

  it("normalizes EditorUtilityInterface dockKind to scene or class", () => {
    expect(normalizeEditorUtilityDockKind("class")).toBe("class");
    expect(normalizeEditorUtilityDockKind("scene")).toBe("scene");
    expect(normalizeEditorUtilityDockKind(undefined)).toBe("scene");
    expect(normalizeEditorUtilityDockKind("viewport")).toBe("scene");
  });
});
