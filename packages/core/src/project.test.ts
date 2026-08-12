import { describe, expect, it } from "vitest";
import {
  createDefaultGraph,
  createDefaultScene,
  createEmptyProject,
  DEFAULT_SORTING_LAYERS,
  MAIN_GRAPH_FILE,
  MAIN_SCENE_FILE,
  PROJECT_FILE,
  normalizeProjectSettings,
} from "./project";

describe("project schema", () => {
  it("creates an empty project with expected paths", () => {
    const project = createEmptyProject("Demo");
    expect(project.metadata.name).toBe("Demo");
    expect(project.scenes).toContain(MAIN_SCENE_FILE);
    expect(project.graphs).toContain(MAIN_GRAPH_FILE);
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
    expect(project.settings.playFrameCap).toBe(60);
  });

  it("creates default scene and graph structures", () => {
    expect(createDefaultScene().actors.length).toBeGreaterThan(0);
    expect(createDefaultGraph().nodes.length).toBeGreaterThan(0);
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
});
