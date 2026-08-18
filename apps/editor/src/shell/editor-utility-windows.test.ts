import { describe, expect, it, vi } from "vitest";
import { EDITOR_UTILITY_DOCK_KINDS } from "@babylonslate/core";
import { isDockviewDocumentKind, primaryDockPanel } from "./window-catalog";
import {
  closeMismatchedEditorUtilityPanels,
  editorUtilityAssetsFromIndexed,
  editorUtilityEmptyLabel,
  editorUtilityGuidFromWindowId,
  editorUtilityHostDocumentKind,
  editorUtilityProjectPathsByKind,
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
    guid: "eui-sprite",
    name: "SpriteTools",
    type: "EditorUtilityInterface",
    payload: { dockKind: "sprite" },
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
    expect(listEditorUtilityWindows({ kind: "material", assets })).toEqual([]);
    expect(listEditorUtilityWindows()).toEqual([]);
  });

  it("lists sprite EditorUtilityInterface assets for a Sprite document", () => {
    const windows = listEditorUtilityWindows({ kind: "sprite", assets });
    expect(windows.map((entry) => entry.title)).toEqual(["SpriteTools"]);
    expect(windows[0]?.defaultPosition?.referencePanelId).toBe("sprite-preview");
  });

  it("lists every EditorUtilityInterface when the active document is a UI editor", () => {
    const windows = listEditorUtilityMenuWindows({ kind: "ui", assets });
    expect(windows.map((entry) => entry.title)).toEqual([
      "SceneTools",
      "ClassTools",
      "SpriteTools",
      "LegacyTools",
    ]);
    expect(windows[0]?.defaultPosition?.referencePanelId).toBe("viewport");
    expect(windows[1]?.defaultPosition?.referencePanelId).toBe("graph");
    expect(windows[2]?.defaultPosition?.referencePanelId).toBe("sprite-preview");
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

describe("editorUtilityProjectPathsByKind", () => {
  it("groups project assets by Windows-capable document kind", () => {
    expect(
      editorUtilityProjectPathsByKind([
        { path: "assets/main.scene.babasset", header: { type: "Scene" } },
        { path: "assets/Hero.sprite.babasset", header: { type: "Sprite" } },
        { path: "assets/Hero.class.babasset", header: { type: "Class" } },
        { path: "assets/HUD.ui.babasset", header: { type: "UserInterface" } },
        { path: "assets/Icon.font.babasset", header: { type: "Font" } },
      ]),
    ).toEqual({
      scene: ["assets/main.scene.babasset"],
      sprite: ["assets/Hero.sprite.babasset"],
      graph: ["assets/Hero.class.babasset"],
      ui: ["assets/HUD.ui.babasset"],
    });
  });
});

describe("EDITOR_UTILITY_DOCK_KINDS", () => {
  it("covers every Windows-capable Dockview document kind", () => {
    for (const kind of EDITOR_UTILITY_DOCK_KINDS) {
      expect(isDockviewDocumentKind(kind)).toBe(true);
      expect(primaryDockPanel(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("editorUtilityHostDocumentKind", () => {
  it("maps stored class to graph and identity-maps other Dockview kinds", () => {
    expect(editorUtilityHostDocumentKind("class")).toBe("graph");
    expect(editorUtilityHostDocumentKind("graph")).toBe("graph");
    expect(editorUtilityHostDocumentKind("scene")).toBe("scene");
    expect(editorUtilityHostDocumentKind("sprite")).toBe("sprite");
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
  it("prefers an open document of the widget dockKind", () => {
    expect(
      resolveEditorUtilityLiveHost({
        dockKind: "sprite",
        openDocuments: [
          { kind: "scene", path: "assets/main.scene.babasset" },
          { kind: "sprite", path: "assets/Hero.sprite.babasset" },
        ],
        projectPathsByKind: {
          scene: ["assets/main.scene.babasset"],
          sprite: ["assets/Hero.sprite.babasset"],
        },
      }),
    ).toEqual({ kind: "sprite", path: "assets/Hero.sprite.babasset" });
  });

  it("opens a project document of that kind when none is already open", () => {
    expect(
      resolveEditorUtilityLiveHost({
        dockKind: "class",
        openDocuments: [{ kind: "scene", path: "assets/main.scene.babasset" }],
        projectPathsByKind: {
          scene: ["assets/main.scene.babasset"],
          graph: ["assets/main.class.babasset"],
        },
      }),
    ).toEqual({ kind: "graph", path: "assets/main.class.babasset" });
  });

  it("returns null rather than docking on Scene when no host of that kind exists", () => {
    expect(
      resolveEditorUtilityLiveHost({
        dockKind: "sprite",
        openDocuments: [{ kind: "scene", path: "assets/main.scene.babasset" }],
        projectPathsByKind: {
          scene: ["assets/main.scene.babasset"],
        },
      }),
    ).toBeNull();
  });
});

describe("editorUtilityLiveTarget", () => {
  const openDocuments = [
    { kind: "scene", path: "assets/main.scene.babasset" },
    { kind: "graph", path: "assets/main.class.babasset" },
  ];
  const projectPathsByKind = {
    scene: ["assets/main.scene.babasset"],
    graph: ["assets/main.class.babasset"],
  };

  it("resolves the Scene host and panel id for a scene EditorUtilityInterface", () => {
    expect(
      editorUtilityLiveTarget({
        guid: "eui-scene",
        assets,
        openDocuments,
        projectPathsByKind,
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
        openDocuments,
        projectPathsByKind,
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
        openDocuments,
        projectPathsByKind,
      }),
    ).toBeNull();
    expect(
      editorUtilityLiveTarget({
        guid: "eui-class",
        assets,
        openDocuments: [{ kind: "scene", path: "assets/main.scene.babasset" }],
        projectPathsByKind: { scene: ["assets/main.scene.babasset"] },
      }),
    ).toBeNull();
  });
});
