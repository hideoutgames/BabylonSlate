import { describe, expect, it } from "vitest";
import {
  editorUtilityAssetsFromIndexed,
  editorUtilityGuidFromWindowId,
  editorUtilityWindowId,
  findDockOrUtilityWindow,
  listEditorUtilityWindows,
} from "./editor-utility-windows";

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
    {
      guid: "eui-default",
      name: "LegacyTools",
      type: "EditorUtilityInterface",
      payload: {},
    },
  ];

  it("lists scene EditorUtilityInterface assets for a Scene document", () => {
    const windows = listEditorUtilityWindows({ kind: "scene", assets });
    expect(windows.map((entry) => entry.id)).toEqual([
      "eui-eui-scene",
      "eui-eui-default",
    ]);
    expect(windows[0]?.title).toBe("SceneTools");
    expect(windows[0]?.component).toBe("editor-utility");
  });

  it("treats a missing dockKind as scene", () => {
    const windows = listEditorUtilityWindows({ kind: "scene", assets });
    expect(windows.some((entry) => entry.title === "LegacyTools")).toBe(true);
    expect(
      listEditorUtilityWindows({ kind: "graph", assets }).map((entry) => entry.title),
    ).toEqual(["ClassTools"]);
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

  it("docks scene utilities to the right of Viewport by default", () => {
    const [window] = listEditorUtilityWindows({ kind: "scene", assets });
    expect(window?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "right",
      initialWidth: 320,
    });
  });

  it("round-trips a window id to the EditorUtilityInterface guid", () => {
    expect(editorUtilityGuidFromWindowId(editorUtilityWindowId("guid-1"))).toBe(
      "guid-1",
    );
    expect(editorUtilityGuidFromWindowId("viewport")).toBeNull();
  });

  it("maps registry headers to listing refs without loading document chunks", () => {
    expect(
      editorUtilityAssetsFromIndexed([
        {
          header: {
            guid: "eui-scene",
            name: "SceneTools",
            type: "EditorUtilityInterface",
            payload: { dockKind: "scene" },
          },
        },
      ]),
    ).toEqual([
      {
        guid: "eui-scene",
        name: "SceneTools",
        type: "EditorUtilityInterface",
        payload: { dockKind: "scene" },
      },
    ]);
  });

  it("finds an EditorUtilityInterface window by id for toggle and Focus", () => {
    const found = findDockOrUtilityWindow("scene", "eui-eui-scene", {
      assets,
    });
    expect(found?.component).toBe("editor-utility");
    expect(found?.title).toBe("SceneTools");
    expect(findDockOrUtilityWindow("scene", "viewport")?.component).toBe(
      "viewport",
    );
  });
});
