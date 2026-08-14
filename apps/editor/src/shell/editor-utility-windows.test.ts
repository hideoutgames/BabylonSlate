import { describe, expect, it } from "vitest";
import { listEditorUtilityWindows } from "./editor-utility-windows";

describe("listEditorUtilityWindows", () => {
  const assets = [
    {
      guid: "eui-scene",
      name: "SceneTools",
      type: "EditorUtilityInterface",
      payload: { dockKind: "scene" },
    },
    {
      guid: "eui-class",
      name: "ClassTools",
      type: "EditorUtilityInterface",
      payload: { dockKind: "class" },
    },
    {
      guid: "hud",
      name: "HUD",
      type: "UserInterface",
      payload: {},
    },
  ];

  it("lists scene EditorUtilityInterface assets for a Scene document", () => {
    const windows = listEditorUtilityWindows({ kind: "scene", assets });
    expect(windows.map((entry) => entry.id)).toEqual(["eui-eui-scene"]);
    expect(windows[0]?.title).toBe("SceneTools");
    expect(windows[0]?.component).toBe("editor-utility");
  });

  it("lists class EditorUtilityInterface assets for a Class document", () => {
    const windows = listEditorUtilityWindows({ kind: "graph", assets });
    expect(windows.map((entry) => entry.id)).toEqual(["eui-eui-class"]);
    expect(windows[0]?.title).toBe("ClassTools");
  });

  it("returns an empty list when no matching utilities exist", () => {
    expect(listEditorUtilityWindows({ kind: "sprite", assets })).toEqual([]);
    expect(listEditorUtilityWindows()).toEqual([]);
  });
});
