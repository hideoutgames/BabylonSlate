import { describe, expect, it, vi } from "vitest";
import { defaultEngineSettings } from "@babylonslate/vfs";
import {
  applyFocusLayout,
  canFocusLayout,
  FOCUS_PRIMARY_PANEL,
  focusKeepCandidates,
  focusKeepPanelIds,
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

describe("canFocusLayout", () => {
  it("is enabled for DockView document kinds including Material", () => {
    expect(canFocusLayout("scene")).toBe(true);
    expect(canFocusLayout("graph")).toBe(true);
    expect(canFocusLayout("material")).toBe(true);
    expect(canFocusLayout("material-function")).toBe(true);
    expect(canFocusLayout("script-interface")).toBe(true);
    expect(canFocusLayout("enum")).toBe(true);
    expect(canFocusLayout("sprite")).toBe(true);
    expect(canFocusLayout("audio")).toBe(true);
    expect(canFocusLayout("sprite-animation")).toBe(true);
    expect(canFocusLayout("anim-graph")).toBe(true);
    expect(canFocusLayout("behaviour-tree")).toBe(true);
    expect(canFocusLayout("model")).toBe(true);
    expect(canFocusLayout("skeleton")).toBe(true);
    expect(canFocusLayout("animation")).toBe(true);
  });

  it("is disabled on Content Browser and compact asset tabs", () => {
    expect(canFocusLayout("content-browser")).toBe(false);
    expect(canFocusLayout("font")).toBe(false);
    expect(canFocusLayout("blackboard")).toBe(false);
    expect(canFocusLayout("asset-settings")).toBe(false);
    expect(canFocusLayout(undefined)).toBe(false);
  });
});

describe("focusKeepPanelIds", () => {
  it("returns the scene keep list from settings", () => {
    expect(focusKeepPanelIds(defaultEngineSettings(), "scene")).toEqual([
      "viewport",
    ]);
  });

  it("returns the material keep list from settings", () => {
    expect(focusKeepPanelIds(defaultEngineSettings(), "material")).toEqual([
      "material-graph",
    ]);
  });

  it("returns the Animation Object keep list when Animation Object mode is active", () => {
    expect(
      focusKeepPanelIds(defaultEngineSettings(), "anim-graph", {
        animEditorMode: "animationObject",
      }),
    ).toEqual(["anim-object-graph"]);
  });
});

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

  it("lists Animation Graph docks depending on editor mode", () => {
    expect(
      focusKeepCandidates("anim-graph").map((panel) => panel.id),
    ).toEqual(listDockWindows("anim-graph").map((entry) => entry.id));
    expect(
      focusKeepCandidates("anim-graph", { animEditorMode: "animationObject" }).map(
        (panel) => panel.id,
      ),
    ).toEqual(
      listDockWindows("anim-graph", { animEditorMode: "animationObject" }).map(
        (entry) => entry.id,
      ),
    );
  });
});

describe("resolveFocusKeepPanelIds", () => {
  it("uses the primary surface when the keep list is empty", () => {
    expect(resolveFocusKeepPanelIds("scene", [])).toEqual(["viewport"]);
    expect(resolveFocusKeepPanelIds("scene-layer", [])).toEqual(["viewport"]);
    expect(FOCUS_PRIMARY_PANEL["scene-layer"]).toBe("viewport");
    expect(resolveFocusKeepPanelIds("graph", undefined)).toEqual(["graph"]);
    expect(resolveFocusKeepPanelIds("enum", [])).toEqual(["enum-members"]);
    expect(resolveFocusKeepPanelIds("script-interface", undefined)).toEqual([
      "script-interface-preview",
    ]);
    expect(resolveFocusKeepPanelIds("sprite", [])).toEqual(["sprite-preview"]);
    expect(resolveFocusKeepPanelIds("sprite-animation", [])).toEqual([
      "sprite-animation-preview",
    ]);
    expect(resolveFocusKeepPanelIds("tileset", [])).toEqual(["tileset-preview"]);
    expect(resolveFocusKeepPanelIds("tilemap", [])).toEqual(["tilemap-paint"]);
    expect(FOCUS_PRIMARY_PANEL["anim-graph"]).toBe("anim-graph-graph");
    expect(FOCUS_PRIMARY_PANEL["behaviour-tree"]).toBe("behaviour-tree-graph");
    expect(resolveFocusKeepPanelIds("plugin-settings", [])).toEqual([
      "plugin-settings-details",
    ]);
    expect(resolveFocusKeepPanelIds("anim-graph", [])).toEqual([
      "anim-graph-graph",
    ]);
    expect(
      resolveFocusKeepPanelIds("anim-graph", [], {
        animEditorMode: "animationObject",
      }),
    ).toEqual(["anim-object-graph"]);
    expect(resolveFocusKeepPanelIds("behaviour-tree", [])).toEqual([
      "behaviour-tree-graph",
    ]);
    expect(resolveFocusKeepPanelIds("audio", [])).toEqual(["audio-preview"]);
    expect(FOCUS_PRIMARY_PANEL.audio).toBe("audio-preview");
    expect(resolveFocusKeepPanelIds("audio-mixer", [])).toEqual([
      "audio-mixer-details",
    ]);
    expect(resolveFocusKeepPanelIds("audio-channel", [])).toEqual([
      "audio-channel-details",
    ]);
    expect(resolveFocusKeepPanelIds("sound-attenuation", [])).toEqual([
      "sound-attenuation-details",
    ]);
    expect(resolveFocusKeepPanelIds("particle-emitter", [])).toEqual([
      "particle-emitter-preview",
    ]);
    expect(resolveFocusKeepPanelIds("particle-system", [])).toEqual([
      "particle-system-preview",
    ]);
    expect(FOCUS_PRIMARY_PANEL["particle-emitter"]).toBe(
      "particle-emitter-preview",
    );
    expect(resolveFocusKeepPanelIds("model", [])).toEqual(["model-preview"]);
    expect(FOCUS_PRIMARY_PANEL.model).toBe("model-preview");
    expect(resolveFocusKeepPanelIds("skeleton", [])).toEqual(["skeleton-preview"]);
    expect(FOCUS_PRIMARY_PANEL.skeleton).toBe("skeleton-preview");
    expect(resolveFocusKeepPanelIds("animation", [])).toEqual([
      "animation-preview",
    ]);
    expect(FOCUS_PRIMARY_PANEL.animation).toBe("animation-preview");
    expect(resolveFocusKeepPanelIds("skybox-creator", [])).toEqual([
      "skybox-creator-preview",
    ]);
    expect(FOCUS_PRIMARY_PANEL["skybox-creator"]).toBe(
      "skybox-creator-preview",
    );
  });

  it("keeps an explicit list as-is", () => {
    expect(
      resolveFocusKeepPanelIds("graph", ["graph", "inspector"]),
    ).toEqual(["graph", "inspector"]);
  });
});

describe("applyFocusLayout", () => {
  it("closes Material Preview and Details, keeping Graph", () => {
    const api = fakeApi([
      "material-graph",
      "material-preview",
      "material-details",
      "material-compiler-results",
    ]);
    applyFocusLayout("material", api, ["material-graph"]);
    expect(api.getPanel("material-graph")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("material-preview")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("material-details")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("material-compiler-results")!.api.close).toHaveBeenCalled();
  });

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
