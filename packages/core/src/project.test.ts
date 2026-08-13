import { describe, expect, it } from "vitest";
import {
  createDefaultGraph,
  createDefaultScene,
  createEmptyProject,
  DEFAULT_SORTING_LAYERS,
  MAIN_CLASS_FILE,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  normalizeGraphMembers,
  normalizeGraphComponents,
  normalizeProjectSettings,
} from "./project";

describe("project schema", () => {
  it("creates an empty project with expected paths", () => {
    const project = createEmptyProject("Demo");
    expect(project.metadata.name).toBe("Demo");
    expect(project.scenes).toContain(MAIN_SCENE_FILE);
    expect(project.graphs).toContain(MAIN_CLASS_FILE);
    expect(MAIN_GRAPH_FILE).toBe("assets/main.graph.babasset");
    expect(PROJECT_FILE).toBe("project.json");
    expect(project.settings.twoD.pixelsPerUnit).toBe(100);
    expect(project.settings.twoD.sortingLayers).toEqual([
      ...DEFAULT_SORTING_LAYERS,
    ]);
    expect(project.settings.input.actions.some((a) => a.name === "Jump")).toBe(
      true,
    );
    const jumpPad = project.settings.input.actions
      .find((a) => a.name === "Jump")
      ?.bindings.find((b) => b.device === "gamepadButton")?.code;
    const confirmPad = project.settings.input.actions
      .find((a) => a.name === "Confirm")
      ?.bindings.find((b) => b.device === "gamepadButton")?.code;
    expect(jumpPad).toBe("0:0");
    expect(confirmPad).toBe("0:1");
    expect(jumpPad).not.toBe(confirmPad);
    expect(
      project.settings.input.axes
        .find((axis) => axis.name === "Move")
        ?.bindings.some((binding) => binding.device === "touch"),
    ).toBe(true);
    expect(project.settings.fonts).toEqual({
      defaultFontGuid: null,
      globalFallback: "sans-serif",
    });
    expect(project.settings.playFrameCap).toBe(60);
    expect(project.settings.playPreview).toEqual({
      followSystem: true,
      aspectWidth: 16,
      aspectHeight: 9,
    });
  });

  it("creates default scene and graph structures", () => {
    expect(createDefaultScene().actors.length).toBeGreaterThan(0);
    expect(createDefaultGraph().nodes.length).toBeGreaterThan(0);
  });

  it("creates a 2D project without a cube and with pixel-perfect units", () => {
    const project = createEmptyProject("SideScroller", { kind: "2d" });
    expect(project.settings.twoD.pixelPerfect).toBe(true);
    expect(project.settings.twoD.integerZoomSteps).toBe(true);
    const scene = createDefaultScene("2d");
    expect(scene.viewportMode).toBe("2d");
    expect(scene.settings.physicsWorld).toBe("2d");
    expect(scene.actors).toEqual([]);
  });

  it("normalizes graph class members and drops invalid rows", () => {
    expect(normalizeGraphComponents(undefined)).toEqual([]);
    expect(
      normalizeGraphComponents([
        { id: "mesh-1", classId: "MeshComponent", properties: { meshKind: "box" } },
        { id: "", classId: "LightComponent", properties: {} },
        { id: "light-1", classId: "  ", properties: {} },
        { classId: "CameraComponent", properties: {} },
        { id: "sprite-1", classId: "SpriteComponent" },
      ]),
    ).toEqual([
      {
        id: "mesh-1",
        classId: "MeshComponent",
        properties: { meshKind: "box" },
      },
      { id: "sprite-1", classId: "SpriteComponent", properties: {} },
    ]);
    expect(normalizeGraphMembers(undefined)).toEqual([]);
    expect(
      normalizeGraphMembers([
        { id: "fn-1", kind: "function", name: " Jump " },
        { id: "", kind: "variable", name: "Health" },
        { kind: "event", name: "Tick" },
        { id: "bad", kind: "graphs", name: "Nope" },
        { id: "var-1", kind: "variable", name: "Health" },
      ]),
    ).toEqual([
      { id: "fn-1", kind: "function", name: "Jump" },
      { id: "var-1", kind: "variable", name: "Health" },
    ]);
  });

  it("normalizes missing 2D settings and drops duplicate sorting layers", () => {
    const settings = normalizeProjectSettings({
      touchMinTargetPx: 48,
      twoD: {
        pixelsPerUnit: 0,
        pixelPerfect: true,
        integerZoomSteps: true,
        sortingLayers: ["Default", " Default ", "", "UI", "Default"],
      },
    });
    expect(settings.touchMinTargetPx).toBe(48);
    expect(settings.twoD.pixelsPerUnit).toBe(100);
    expect(settings.twoD.pixelPerfect).toBe(true);
    expect(settings.twoD.sortingLayers).toEqual(["Default", "UI"]);
  });

  it("defaults playFrameCap to 60 and keeps a positive override", () => {
    expect(normalizeProjectSettings(undefined).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({}).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({ playFrameCap: 0 }).playFrameCap).toBe(60);
    expect(normalizeProjectSettings({ playFrameCap: 30 }).playFrameCap).toBe(30);
  });

  it("defaults playPreview to follow-system 16:9 and keeps a positive override", () => {
    expect(normalizeProjectSettings(undefined).playPreview).toEqual({
      followSystem: true,
      aspectWidth: 16,
      aspectHeight: 9,
    });
    expect(normalizeProjectSettings({}).playPreview.followSystem).toBe(true);
    expect(
      normalizeProjectSettings({
        playPreview: { followSystem: false, aspectWidth: 0, aspectHeight: 0 },
      }).playPreview,
    ).toEqual({
      followSystem: false,
      aspectWidth: 16,
      aspectHeight: 9,
    });
    expect(
      normalizeProjectSettings({
        playPreview: { followSystem: false, aspectWidth: 21, aspectHeight: 9 },
      }).playPreview,
    ).toEqual({
      followSystem: false,
      aspectWidth: 21,
      aspectHeight: 9,
    });
  });

  it("preserves aspect when a followSystem-only patch is merged", () => {
    const current = normalizeProjectSettings({
      playPreview: { followSystem: true, aspectWidth: 4, aspectHeight: 3 },
    });
    expect(
      normalizeProjectSettings({
        ...current,
        playPreview: { ...current.playPreview, followSystem: false },
      }).playPreview,
    ).toEqual({
      followSystem: false,
      aspectWidth: 4,
      aspectHeight: 3,
    });
  });

  it("defaults compile on save and a two-minute autosave interval", () => {
    const defaults = normalizeProjectSettings(undefined);
    expect(defaults.compileOnSave).toBe(true);
    expect(defaults.autoSaveIntervalMs).toBe(120_000);
    expect(
      normalizeProjectSettings({ compileOnSave: false, autoSaveIntervalMs: 5000 })
        .compileOnSave,
    ).toBe(false);
    expect(
      normalizeProjectSettings({ autoSaveIntervalMs: 0 }).autoSaveIntervalMs,
    ).toBe(120_000);
  });
});
