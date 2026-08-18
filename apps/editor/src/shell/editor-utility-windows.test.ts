import { describe, expect, it, vi } from "vitest";
import {
  closeMismatchedEditorUtilityPanels,
  editorUtilityAssetsFromIndexed,
  editorUtilityEmptyLabel,
  editorUtilityGuidFromWindowId,
  editorUtilityHostDocumentKind,
  editorUtilityWindowId,
  findDockOrUtilityWindow,
  listEditorUtilityMenuWindows,
  listEditorUtilityWindows,
  mergeEditorUtilityListingPayload,
  resolveEditorUtilityLiveHost,
  editorUtilityLiveTarget,
} from "./editor-utility-windows";

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

describe("listEditorUtilityWindows", () => {
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

  it("lists every EditorUtilityInterface when the active document is a UI editor", () => {
    const windows = listEditorUtilityMenuWindows({ kind: "ui", assets });
    expect(windows.map((entry) => entry.title)).toEqual([
      "SceneTools",
      "ClassTools",
      "LegacyTools",
    ]);
    expect(windows[0]?.defaultPosition?.referencePanelId).toBe("viewport");
    expect(windows[1]?.defaultPosition?.referencePanelId).toBe("graph");
  });

  it("keeps Scene listing unchanged through the Windows menu helper", () => {
    expect(
      listEditorUtilityMenuWindows({ kind: "scene", assets }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["SceneTools", "LegacyTools"]);
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

describe("mergeEditorUtilityListingPayload", () => {
  it("prefers a dirty open document over the registry header", () => {
    expect(
      mergeEditorUtilityListingPayload({ dockKind: "scene" }, { dockKind: "class" }),
    ).toEqual({ dockKind: "class" });
    expect(mergeEditorUtilityListingPayload({ dockKind: "scene" }, null)).toEqual({
      dockKind: "scene",
    });
  });
});

describe("editorUtilityAssetsFromIndexed open payload", () => {
  it("uses open document payload when the EUI is dirty", () => {
    expect(
      editorUtilityAssetsFromIndexed(
        [
          {
            path: "assets/Tools.eui.babasset",
            header: {
              guid: "eui-1",
              name: "Tools",
              type: "EditorUtilityInterface",
              payload: { dockKind: "scene" },
            },
          },
        ],
        [
          {
            ref: { path: "assets/Tools.eui.babasset" },
            content: { dockKind: "class", name: "Tools" },
          },
        ],
      ),
    ).toEqual([
      {
        guid: "eui-1",
        name: "Tools",
        type: "EditorUtilityInterface",
        payload: { dockKind: "class", name: "Tools" },
      },
    ]);
  });
});

describe("closeMismatchedEditorUtilityPanels", () => {
  it("closes an open EUI tab whose dockKind no longer matches this dock", () => {
    const close = vi.fn();
    const api = {
      getPanel: (id: string) =>
        id === "eui-moved"
          ? { api: { close } }
          : id === "viewport"
            ? { api: { close: vi.fn() } }
            : undefined,
      panels: [{ id: "viewport" }, { id: "eui-moved" }],
    };
    const assets = [
      {
        guid: "stays",
        name: "Stay",
        type: "EditorUtilityInterface",
        payload: { dockKind: "scene" },
      },
    ];
    closeMismatchedEditorUtilityPanels(api, "scene", assets);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("editorUtilityHostDocumentKind", () => {
  it("maps dockKind class to the Class document and anything else to Scene", () => {
    expect(editorUtilityHostDocumentKind("class")).toBe("graph");
    expect(editorUtilityHostDocumentKind("scene")).toBe("scene");
    expect(editorUtilityHostDocumentKind(undefined)).toBe("scene");
  });
});

describe("editorUtilityEmptyLabel", () => {
  it("says the project has no Editor Utility Interfaces", () => {
    expect(editorUtilityEmptyLabel("scene", [])).toBe(
      "No Editor Utility Interfaces In This Project",
    );
    expect(
      editorUtilityEmptyLabel("scene", [
        { guid: "hud", name: "HUD", type: "UserInterface" },
      ]),
    ).toBe("No Editor Utility Interfaces In This Project");
  });

  it("says none match this document when EUIs exist for the other dock", () => {
    expect(
      editorUtilityEmptyLabel("graph", [
        {
          guid: "eui-scene",
          name: "SceneTools",
          type: "EditorUtilityInterface",
          payload: { dockKind: "scene" },
        },
      ]),
    ).toBe("None For This Document");
  });

  it("returns null when the menu has entries", () => {
    expect(
      editorUtilityEmptyLabel("scene", [
        {
          guid: "eui-scene",
          name: "SceneTools",
          type: "EditorUtilityInterface",
          payload: { dockKind: "scene" },
        },
      ]),
    ).toBeNull();
    expect(
      editorUtilityEmptyLabel("ui", [
        {
          guid: "eui-scene",
          name: "SceneTools",
          type: "EditorUtilityInterface",
          payload: { dockKind: "scene" },
        },
      ]),
    ).toBeNull();
  });
});

describe("resolveEditorUtilityLiveHost", () => {
  it("picks the first Scene or Class path for the widget dockKind", () => {
    expect(
      resolveEditorUtilityLiveHost({
        dockKind: "scene",
        scenes: ["assets/main.scene.babasset"],
        graphs: ["assets/main.class.babasset"],
      }),
    ).toEqual({ kind: "scene", path: "assets/main.scene.babasset" });
    expect(
      resolveEditorUtilityLiveHost({
        dockKind: "class",
        scenes: ["assets/main.scene.babasset"],
        graphs: ["assets/main.class.babasset"],
      }),
    ).toEqual({ kind: "graph", path: "assets/main.class.babasset" });
  });

  it("returns null when the project has no host document of that kind", () => {
    expect(
      resolveEditorUtilityLiveHost({
        dockKind: "class",
        scenes: ["assets/main.scene.babasset"],
        graphs: [],
      }),
    ).toBeNull();
  });
});

describe("editorUtilityLiveTarget", () => {
  const scenes = ["assets/main.scene.babasset"];
  const graphs = ["assets/main.class.babasset"];

  it("resolves the Scene host and panel id for a scene EditorUtilityInterface", () => {
    expect(
      editorUtilityLiveTarget({
        guid: "eui-scene",
        assets,
        scenes,
        graphs,
      }),
    ).toEqual({
      host: { kind: "scene", path: "assets/main.scene.babasset" },
      panelId: "eui-eui-scene",
    });
  });

  it("resolves the Class host for a class-dock EditorUtilityInterface", () => {
    expect(
      editorUtilityLiveTarget({
        guid: "eui-class",
        assets,
        scenes,
        graphs,
      }),
    ).toEqual({
      host: { kind: "graph", path: "assets/main.class.babasset" },
      panelId: "eui-eui-class",
    });
  });

  it("returns null when the guid is missing or the host document does not exist", () => {
    expect(
      editorUtilityLiveTarget({
        guid: "missing",
        assets,
        scenes,
        graphs,
      }),
    ).toBeNull();
    expect(
      editorUtilityLiveTarget({
        guid: "eui-class",
        assets,
        scenes,
        graphs: [],
      }),
    ).toBeNull();
  });
});
