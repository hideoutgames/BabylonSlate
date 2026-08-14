import { describe, expect, it } from "vitest";
import { editorUtilityObjectClassEntries } from "./editor-utility-classes";

describe("editorUtilityObjectClassEntries", () => {
  it("lists the engine class and project classes in the EditorUtilityObject lineage", () => {
    const entries = editorUtilityObjectClassEntries([
      {
        header: {
          type: "Class",
          name: "Tools",
          parentClass: "EditorUtilityObject",
        },
      },
      {
        header: {
          type: "Class",
          name: "Hero",
          parentClass: "Actor",
        },
      },
      {
        header: {
          type: "EditorUtilityInterface",
          name: "SceneTools",
          parentClass: null,
        },
      },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual([
      "EditorUtilityObject",
      "Tools",
    ]);
  });
});
