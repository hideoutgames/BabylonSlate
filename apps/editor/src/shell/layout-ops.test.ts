import { describe, expect, it, vi } from "vitest";
import { defaultEngineSettings } from "@babylonslate/vfs";
import {
  applyFocusLayout,
  canFocusLayout,
  focusKeepCandidates,
  focusKeepPanelIds,
  resolveFocusKeepPanelIds,
} from "./layout-ops";
import { listDockWindows } from "./window-catalog";

function fakeApi(ids: string[]) {
  const panelMap = new Map(
    ids.map((id) => [
      id,
      {
        id,
        api: {
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

  it("is disabled on Content Browser and tabs without DockView windows", () => {
    expect(canFocusLayout("content-browser")).toBe(false);
    expect(canFocusLayout(undefined)).toBe(false);
  });

  it("is enabled on Font and Blackboard documents, which have DockView windows", () => {
    expect(canFocusLayout("font")).toBe(true);
    expect(canFocusLayout("blackboard")).toBe(true);
  });
});

describe("focusKeepPanelIds", () => {
  it("returns the Animation Object keep list when Animation Object mode is active", () => {
    expect(
      focusKeepPanelIds(defaultEngineSettings(), "anim-graph", {
        animEditorMode: "animationObject",
      }),
    ).toEqual(["anim-object-graph"]);
  });
});

describe("focusKeepCandidates", () => {
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
    expect(resolveFocusKeepPanelIds("particle-graph", [])).toEqual([
      "particle-graph-canvas",
    ]);
    expect(resolveFocusKeepPanelIds("model", [])).toEqual(["model-preview"]);
    expect(resolveFocusKeepPanelIds("skeleton", [])).toEqual(["skeleton-preview"]);
    expect(resolveFocusKeepPanelIds("animation", [])).toEqual([
      "animation-preview",
    ]);
    expect(resolveFocusKeepPanelIds("skybox-creator", [])).toEqual([
      "skybox-creator-preview",
    ]);
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
    expect(api.getPanel("scene-outliner")!.api.close).not.toHaveBeenCalled();
    expect(api.getPanel("scene-details")!.api.close).toHaveBeenCalled();
    expect(api.getPanel("output-log")!.api.close).toHaveBeenCalled();
  });

  it("never empties the dock when no keep-listed panel is open", () => {
    // The keep-listed Inspector is closed.
    const withPrimary = fakeApi(["prefab-viewport", "actor-prefab"]);
    applyFocusLayout("prefab", withPrimary, ["inspector"]);
    expect(withPrimary.getPanel("prefab-viewport")!.api.close).not.toHaveBeenCalled();
    expect(withPrimary.getPanel("actor-prefab")!.api.close).toHaveBeenCalled();

    const withoutPrimary = {
      ...fakeApi(["water-details", "locks"]),
      activePanel: { id: "locks" },
    };
    applyFocusLayout("water", withoutPrimary, undefined);
    expect(withoutPrimary.getPanel("locks")!.api.close).not.toHaveBeenCalled();
    expect(withoutPrimary.getPanel("water-details")!.api.close).toHaveBeenCalled();
  });
});
