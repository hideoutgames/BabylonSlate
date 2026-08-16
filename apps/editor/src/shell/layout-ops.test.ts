import { describe, expect, it, vi } from "vitest";
import {
  applyFocusLayout,
  focusKeepCandidates,
  migrateRestoredLayout,
  resolveFocusKeepPanelIds,
  restoreDockviewLayout,
} from "./layout-ops";
import { listDockWindows } from "./window-catalog";

function fakeApi(ids: string[]) {
  const panelMap = new Map(
    ids.map((id) => [
      id,
      {
        id,
        api: {
          maximize: vi.fn(),
          close: vi.fn(),
          addPanel: vi.fn(),
        },
      },
    ]),
  );
  return {
    getPanel: (id: string) => panelMap.get(id),
    panels: ids.map((id) => panelMap.get(id)!),
    addPanel: vi.fn(),
  };
}

describe("focusKeepCandidates", () => {
  it("lists scene dock tabs that Focus can keep", () => {
    expect(focusKeepCandidates("scene").map((panel) => panel.id)).toEqual(
      listDockWindows("scene").map((entry) => entry.id),
    );
  });

  it("lists class dock tabs that Focus can keep", () => {
    expect(focusKeepCandidates("graph").map((panel) => panel.id)).toEqual(
      listDockWindows("graph").map((entry) => entry.id),
    );
  });

  it("omits Prefab and Components from Focus keep lists for non-Actor classes", () => {
    expect(
      focusKeepCandidates("graph", { actorPrefab: false }).map((panel) => panel.id),
    ).toEqual(
      listDockWindows("graph", { actorPrefab: false }).map((entry) => entry.id),
    );
  });

  it("lists Designer or Logic UI docks depending on editor mode", () => {
    expect(
      focusKeepCandidates("ui").map((panel) => panel.id),
    ).toEqual(listDockWindows("ui").map((entry) => entry.id));
    expect(
      focusKeepCandidates("ui", { uiEditorMode: "logic" }).map(
        (panel) => panel.id,
      ),
    ).toEqual(
      listDockWindows("ui", { uiEditorMode: "logic" }).map((entry) => entry.id),
    );
  });

  it("merges EditorUtilityInterface windows into Focus keep candidates", () => {
    const utilities = [{ id: "eui-scene-tools", title: "SceneTools" }];
    expect(
      focusKeepCandidates("scene", { editorUtilities: utilities }).map(
        (panel) => panel.id,
      ),
    ).toEqual([
      ...listDockWindows("scene").map((entry) => entry.id),
      "eui-scene-tools",
    ]);
  });
});

describe("resolveFocusKeepPanelIds", () => {
  it("uses the primary surface when the keep list is empty", () => {
    expect(resolveFocusKeepPanelIds("scene", [])).toEqual(["viewport"]);
    expect(resolveFocusKeepPanelIds("graph", undefined)).toEqual(["graph"]);
    expect(resolveFocusKeepPanelIds("enum", [])).toEqual(["enum-members"]);
    expect(resolveFocusKeepPanelIds("script-interface", undefined)).toEqual([
      "script-interface-preview",
    ]);
    expect(resolveFocusKeepPanelIds("sprite", [])).toEqual(["sprite-preview"]);
    expect(resolveFocusKeepPanelIds("tileset", [])).toEqual(["tileset-preview"]);
    expect(resolveFocusKeepPanelIds("tilemap", [])).toEqual(["tilemap-paint"]);
    expect(resolveFocusKeepPanelIds("ui", [])).toEqual(["ui-design"]);
    expect(
      resolveFocusKeepPanelIds("ui", [], { uiEditorMode: "logic" }),
    ).toEqual(["graph"]);
    expect(resolveFocusKeepPanelIds("plugin-settings", [])).toEqual([
      "plugin-settings-details",
    ]);
  });

  it("keeps an explicit list as-is", () => {
    expect(
      resolveFocusKeepPanelIds("graph", ["graph", "inspector"]),
    ).toEqual(["graph", "inspector"]);
  });
});

describe("applyFocusLayout", () => {
  it("closes every open class panel except Graph when keep is graph only", () => {
    const api = fakeApi([
      "graph",
      "inspector",
      "my-class",
      "actor-prefab",
      "prefab-viewport",
      "compiler-results",
    ]);
    applyFocusLayout("graph", api, ["graph"]);
    expect(api.getPanel("graph")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("inspector")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("my-class")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("actor-prefab")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("prefab-viewport")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("compiler-results")!.api.close).toHaveBeenCalled();
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it("does not open a keep-listed panel that is not already in the dock", () => {
    const api = fakeApi(["graph", "my-class"]);
    applyFocusLayout("graph", api, ["graph", "inspector"]);
    expect(api.getPanel("graph")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("my-class")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("inspector")).toBeUndefined();
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it("keeps already-open scene panels that are on the keep list", () => {
    const api = fakeApi([
      "viewport",
      "scene-outliner",
      "scene-details",
      "output-log",
    ]);
    applyFocusLayout("scene", api, ["viewport", "scene-outliner"]);
    expect(api.getPanel("viewport")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("viewport")!.api.maximize).not.toHaveBeenCalled();
    expect(api.getPanel("scene-outliner")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("scene-details")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("output-log")!.api.close).toHaveBeenCalled();
  });
});

describe("migrateRestoredLayout", () => {
  it("closes the retired Assets dock", () => {
    const api = fakeApi(["viewport", "mini-asset-browser", "scene-details"]);
    migrateRestoredLayout(api);
    expect(api.getPanel("mini-asset-browser")!.api.close).toHaveBeenCalled();
  });

  it("closes the retired UI Logic dock when restoring a Designer layout", () => {
    const api = fakeApi(["ui-design", "ui-logic", "ui-details"]);
    migrateRestoredLayout(api);
    expect(api.getPanel("ui-logic")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("ui-design")!.api.close).not.toHaveBeenCalled();
  });

  it("moves Class below Components when they share a group", () => {
    const group = { id: "left" };
    const myClass = {
      api: { close: vi.fn(), moveTo: vi.fn() },
      group,
    };
    const components = {
      api: { close: vi.fn(), moveTo: vi.fn() },
      group,
    };
    const api = {
      getPanel: (id: string) => {
        if (id === "my-class") return myClass;
        if (id === "actor-prefab") return components;
        return undefined;
      },
    };
    migrateRestoredLayout(api);
    expect(myClass.api.moveTo).toHaveBeenCalledWith({
      position: "bottom",
      group,
    });
  });
});

describe("restoreDockviewLayout", () => {
  it("falls back to the default layout when fromJSON throws", () => {
    const fromJSON = vi.fn(() => {
      throw new Error("stale catalog");
    });
    const createDefault = vi.fn();
    restoreDockviewLayout({ fromJSON }, { panels: [] }, createDefault);
    expect(fromJSON).toHaveBeenCalledWith({ panels: [] });
    expect(createDefault).toHaveBeenCalledTimes(1);
  });

  it("keeps a restored snapshot when fromJSON succeeds", () => {
    const fromJSON = vi.fn();
    const createDefault = vi.fn();
    restoreDockviewLayout({ fromJSON }, { panels: ["viewport"] }, createDefault);
    expect(fromJSON).toHaveBeenCalledWith({ panels: ["viewport"] });
    expect(createDefault).not.toHaveBeenCalled();
  });

  it("uses the default layout when no snapshot exists", () => {
    const fromJSON = vi.fn();
    const createDefault = vi.fn();
    restoreDockviewLayout({ fromJSON }, null, createDefault);
    expect(fromJSON).not.toHaveBeenCalled();
    expect(createDefault).toHaveBeenCalledTimes(1);
  });
});
