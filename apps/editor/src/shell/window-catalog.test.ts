import { describe, expect, it } from "vitest";
import {
  CLASS_PANEL_INITIAL_HEIGHT,
  CLASS_PANEL_TITLE,
  listDockWindows,
  primaryDockPanel,
} from "./window-catalog";
import { listEditorUtilityWindows } from "./editor-utility-windows";

describe("listDockWindows", () => {
  it("lists scene dock tabs with default positions and omits the retired assets dock", () => {
    const windows = listDockWindows("scene");
    expect(windows.map((entry) => entry.id)).toEqual([
      "viewport",
      "scene-outliner",
      "scene-details",
      "output-log",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Viewport",
      "Outliner",
      "Details",
      "Output Log",
    ]);
    expect(windows.some((entry) => entry.id === "mini-asset-browser")).toBe(
      false,
    );

    const outliner = windows.find((entry) => entry.id === "scene-outliner");
    expect(outliner?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "left",
      initialWidth: 260,
    });
    const details = windows.find((entry) => entry.id === "scene-details");
    expect(details?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "right",
      initialWidth: 300,
    });
    const output = windows.find((entry) => entry.id === "output-log");
    expect(output?.defaultPosition).toEqual({
      referencePanelId: "viewport",
      direction: "below",
      initialHeight: 160,
    });
  });

  it("lists graph dock tabs including Class stacked under Components", () => {
    const windows = listDockWindows("graph");
    expect(windows.map((entry) => entry.id)).toEqual([
      "graph",
      "prefab-viewport",
      "actor-prefab",
      "my-class",
      "inspector",
      "compiler-results",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Graph",
      "Prefab",
      "Components",
      CLASS_PANEL_TITLE,
      "Inspector",
      "Compiler Results",
    ]);

    const classPanel = windows.find((entry) => entry.id === "my-class");
    expect(classPanel?.defaultPosition).toEqual({
      referencePanelId: "actor-prefab",
      direction: "below",
      initialHeight: CLASS_PANEL_INITIAL_HEIGHT,
    });
  });

  it("omits Prefab and Components for non-Actor class documents", () => {
    const windows = listDockWindows("graph", { actorPrefab: false });
    expect(windows.map((entry) => entry.id)).toEqual([
      "graph",
      "my-class",
      "inspector",
      "compiler-results",
    ]);
    const classPanel = windows.find((entry) => entry.id === "my-class");
    expect(classPanel?.defaultPosition).toEqual({
      referencePanelId: "graph",
      direction: "left",
      initialWidth: 260,
    });
  });

  it("lists Enum, Structure, and ScriptInterface dock catalogs", () => {
    expect(listDockWindows("enum").map((entry) => entry.id)).toEqual([
      "enum-members",
      "enum-details",
    ]);
    expect(listDockWindows("structure").map((entry) => entry.id)).toEqual([
      "structure-members",
      "structure-details",
    ]);
    expect(listDockWindows("script-interface").map((entry) => entry.id)).toEqual(
      [
        "script-interface-preview",
        "script-interface-methods",
        "script-interface-details",
      ],
    );
    expect(listDockWindows("sprite").map((entry) => entry.id)).toEqual([
      "sprite-preview",
      "sprite-details",
    ]);
    expect(listDockWindows("tileset").map((entry) => entry.id)).toEqual([
      "tileset-preview",
      "tileset-details",
    ]);
    expect(listDockWindows("tilemap").map((entry) => entry.id)).toEqual([
      "tilemap-paint",
      "tilemap-details",
    ]);
    expect(listDockWindows("ui").map((entry) => entry.id)).toEqual([
      "ui-design",
      "ui-hierarchy",
      "ui-details",
    ]);
    expect(
      listDockWindows("ui", { editorUtilityInterface: true }).map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "ui-design",
      "ui-hierarchy",
      "ui-details",
      "ui-settings",
    ]);
    expect(listDockWindows("plugin-settings").map((entry) => entry.id)).toEqual([
      "plugin-settings-details",
    ]);
    expect(listDockWindows("plugin-settings").map((entry) => entry.title)).toEqual([
      "Details",
    ]);
  });

  it("lists Designer docks without Logic for UserInterface authoring", () => {
    const windows = listDockWindows("ui", { uiEditorMode: "designer" });
    expect(windows.map((entry) => entry.id)).toEqual([
      "ui-design",
      "ui-hierarchy",
      "ui-details",
    ]);
    expect(windows.some((entry) => entry.id === "ui-logic")).toBe(false);
    expect(windows.some((entry) => entry.id === "graph")).toBe(false);
  });

  it("lists BObject Class docks when UserInterface Logic mode is active", () => {
    const windows = listDockWindows("ui", { uiEditorMode: "logic" });
    expect(windows.map((entry) => entry.id)).toEqual([
      "graph",
      "my-class",
      "inspector",
      "compiler-results",
    ]);
    expect(windows.map((entry) => entry.title)).toEqual([
      "Graph",
      CLASS_PANEL_TITLE,
      "Inspector",
      "Compiler Results",
    ]);
    expect(windows.some((entry) => entry.id === "ui-design")).toBe(false);
    expect(windows.some((entry) => entry.id === "prefab-viewport")).toBe(false);
  });

  it("uses Design as the Designer primary and Graph as the Logic primary", () => {
    expect(primaryDockPanel("ui")).toBe("ui-design");
    expect(primaryDockPanel("ui", { uiEditorMode: "designer" })).toBe("ui-design");
    expect(primaryDockPanel("ui", { uiEditorMode: "logic" })).toBe("graph");
  });

  it("keeps EUI Settings on Designer and omits it from Logic", () => {
    expect(
      listDockWindows("ui", {
        uiEditorMode: "designer",
        editorUtilityInterface: true,
      }).map((entry) => entry.id),
    ).toEqual(["ui-design", "ui-hierarchy", "ui-details", "ui-settings"]);
    expect(
      listDockWindows("ui", {
        uiEditorMode: "logic",
        editorUtilityInterface: true,
      }).map((entry) => entry.id),
    ).toEqual(["graph", "my-class", "inspector", "compiler-results"]);
  });

  it("anchors Locks to Graph when UI Logic mode is on", () => {
    expect(
      listDockWindows("ui", {
        uiEditorMode: "logic",
        sourceControl: true,
      }).find((entry) => entry.id === "locks")?.defaultPosition?.referencePanelId,
    ).toBe("graph");
    expect(
      listDockWindows("ui", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("ui-design");
  });

  it("omits the Locks window when source control is off", () => {
    for (const kind of [
      "scene",
      "graph",
      "enum",
      "structure",
      "script-interface",
      "sprite",
      "tileset",
      "tilemap",
      "ui",
      "plugin-settings",
    ] as const) {
      expect(listDockWindows(kind).some((entry) => entry.id === "locks")).toBe(
        false,
      );
    }
  });

  it("appends Locks below each kind's primary panel when source control is on", () => {
    const scene = listDockWindows("scene", { sourceControl: true });
    expect(scene.map((entry) => entry.id)).toContain("locks");
    expect(scene.find((entry) => entry.id === "locks")).toEqual({
      id: "locks",
      component: "locks",
      title: "Locks",
      defaultPosition: {
        referencePanelId: "viewport",
        direction: "below",
        initialHeight: 180,
      },
    });
    expect(
      listDockWindows("graph", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("graph");
    expect(
      listDockWindows("sprite", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("sprite-preview");
  });
});

describe("material dock catalog", () => {
  it("lists Graph, Preview, Details and Compiler Results for a Material", () => {
    const windows = listDockWindows("material");
    expect(windows.map((entry) => entry.id)).toEqual([
      "material-graph",
      "material-preview",
      "material-details",
      "material-compiler-results",
    ]);
  });

  it("anchors every Material dock to the graph", () => {
    for (const entry of listDockWindows("material")) {
      if (!entry.defaultPosition) continue;
      expect(entry.defaultPosition.referencePanelId).toBe("material-graph");
    }
  });

  it("titles Material docks in Title Case", () => {
    expect(listDockWindows("material").map((entry) => entry.title)).toEqual([
      "Graph",
      "Preview",
      "Details",
      "Compiler Results",
    ]);
  });

  it("swaps Preview for Interface on a Material Function", () => {
    const ids = listDockWindows("material-function").map((entry) => entry.id);
    expect(ids).toContain("material-function-interface");
    expect(ids).not.toContain("material-preview");
  });

  it("focuses the graph as the primary panel for both material kinds", () => {
    expect(primaryDockPanel("material")).toBe("material-graph");
    expect(primaryDockPanel("material-function")).toBe(
      "material-function-graph",
    );
  });

  it("anchors Locks under the material graph when source control is on", () => {
    expect(
      listDockWindows("material", { sourceControl: true }).find(
        (entry) => entry.id === "locks",
      )?.defaultPosition?.referencePanelId,
    ).toBe("material-graph");
  });
});

describe("listEditorUtilityWindows", () => {
  it("returns no editor utility tabs when no assets are supplied", () => {
    expect(listEditorUtilityWindows()).toEqual([]);
  });
});
