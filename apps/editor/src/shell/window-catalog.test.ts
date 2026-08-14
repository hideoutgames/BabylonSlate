import { describe, expect, it } from "vitest";
import {
  CLASS_PANEL_INITIAL_HEIGHT,
  CLASS_PANEL_TITLE,
  listDockWindows,
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
  });
});

describe("listEditorUtilityWindows", () => {
  it("returns no editor utility tabs when no assets are supplied", () => {
    expect(listEditorUtilityWindows()).toEqual([]);
  });
});
