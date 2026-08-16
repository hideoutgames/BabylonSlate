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
    expect(isEditorOnlyAssetType("PluginSettings")).toBe(true);
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
    expect(isEditorUtilityObjectClass(null, parentOf)).toBe(false);
    expect(
      isEditorOnlyAsset(
        { type: "Class", parentClass: "LevelTools" },
        parentOf,
      ),
    ).toBe(true);
    expect(
      isEditorOnlyAsset({ type: "Class", parentClass: "Actor" }, parentOf),
    ).toBe(false);
    expect(
      isEditorOnlyAsset(
        { type: "Graph", parentClass: "LevelTools" },
        parentOf,
      ),
    ).toBe(true);
    expect(
      isEditorOnlyAsset({ type: "Scene", parentClass: "LevelTools" }, parentOf),
    ).toBe(false);
  });

  it("stops walking a cyclic parent chain without hanging", () => {
    const cyclic = (id: string) => {
      if (id === "A") return "B";
      if (id === "B") return "A";
      return null;
    };
    expect(isEditorUtilityObjectClass("A", cyclic)).toBe(false);
  });

  it("normalizes EditorUtilityInterface dockKind to scene or class", () => {
    expect(normalizeEditorUtilityDockKind("class")).toBe("class");
    expect(normalizeEditorUtilityDockKind("scene")).toBe("scene");
    expect(normalizeEditorUtilityDockKind(undefined)).toBe("scene");
    expect(normalizeEditorUtilityDockKind("viewport")).toBe("scene");
  });
});
