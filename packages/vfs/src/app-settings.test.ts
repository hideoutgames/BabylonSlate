import { describe, expect, it } from "vitest";
import {
  defaultEngineSettings,
  engineSettingsSchema,
} from "./app-settings";
import { MemoryAppSettingsStore } from "./memory-app-settings";
import { WebAppSettingsStore } from "./web-app-settings";

describe("app settings", () => {
  it("provides defaults including undo history length 50", () => {
    const settings = defaultEngineSettings();
    expect(settings.undoHistoryLength).toBe(50);
    expect(settings.viewportFrameCap).toBe(30);
    expect(settings.thumbnailsEnabled).toBe(true);
    expect(settings.appearance.theme).toBe("system");
    expect(settings.focusKeepPanels).toEqual({
      scene: ["viewport"],
      graph: ["graph"],
      enum: ["enum-members"],
      structure: ["structure-members"],
      "script-interface": ["script-interface-preview"],
      sprite: ["sprite-preview"],
      "sprite-animation": ["sprite-animation-preview"],
      tileset: ["tileset-preview"],
      tilemap: ["tilemap-paint"],
      material: ["material-graph"],
      "material-function": ["material-function-graph"],
      ui: ["ui-design"],
      uiLogic: ["graph"],
      "plugin-settings": ["plugin-settings-details"],
      "anim-graph": ["anim-graph-graph"],
      animGraphObject: ["anim-object-graph"],
      "behaviour-tree": ["behaviour-tree-graph"],
      audio: ["audio-preview"],
      "audio-mixer": ["audio-mixer-details"],
      "audio-channel": ["audio-channel-details"],
      "sound-attenuation": ["sound-attenuation-details"],
      "particle-emitter": ["particle-emitter-preview"],
      "particle-system": ["particle-system-preview"],
      model: ["model-preview"],
      skeleton: ["skeleton-preview"],
      animation: ["animation-preview"],
      "skybox-creator": ["skybox-creator-preview"],
      trace: ["trace-timeline"],
    });
    expect(settings.graphDefaultZoom).toBe(0.5);
    expect(settings.uiDesignerPresets).toEqual([]);
    expect(settings.debuggerDefaults.previewBuild).toBe(false);
    expect(settings.debuggerDefaults.overlayStats).toBe(true);
    expect(settings.debuggerDefaults.overlayConsole).toBe(true);
    expect(settings.debuggerDefaults.overlayInspector).toBe(true);
    expect(settings.debuggerDefaults.pauseOnPlay).toBe(false);
    expect(settings.postProcessingEnabled).toBe(true);
    expect(settings.modelImportDefaultScale).toBe(10);
    expect(settings.viewportFlySpeed).toBe(8);
    expect(settings.viewportGridSize).toBe(1);
  });

  it("fills viewportFrameCap at 30 when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.viewportFrameCap).toBe(30);
  });

  it("fills model import default scale at 10 when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.modelImportDefaultScale).toBe(10);
  });

  it("clamps model import default scale to a positive finite number", () => {
    expect(
      engineSettingsSchema.parse({ modelImportDefaultScale: 0 })
        .modelImportDefaultScale,
    ).toBeGreaterThan(0);
    expect(
      engineSettingsSchema.parse({ modelImportDefaultScale: -4 })
        .modelImportDefaultScale,
    ).toBeGreaterThan(0);
  });

  it("fills viewport fly speed and grid size when saved JSON omits them", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.viewportFlySpeed).toBe(8);
    expect(parsed.viewportGridSize).toBe(1);
  });

  it("fills UserInterface designer presets when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.uiDesignerPresets).toEqual([]);
  });

  it("clamps custom UserInterface preset sizes and insets", () => {
    const parsed = engineSettingsSchema.parse({
      uiDesignerPresets: [
        {
          id: "custom-phone",
          label: "Phone",
          width: 0,
          height: -10,
          safeArea: { left: -2, right: 4, top: -1, bottom: 8 },
        },
      ],
    });
    expect(parsed.uiDesignerPresets).toEqual([
      {
        id: "custom-phone",
        label: "Phone",
        width: 1,
        height: 1,
        safeArea: { left: 0, right: 4, top: 0, bottom: 8 },
      },
    ]);
  });

  it("fills graph default zoom when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.graphDefaultZoom).toBe(0.5);
  });

  it("defaults Preview Build off when debuggerDefaults omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.debuggerDefaults.previewBuild).toBe(false);
  });

  it("defaults overlay Stats, Console, and Inspector on when debuggerDefaults omits them", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.debuggerDefaults.overlayStats).toBe(true);
    expect(parsed.debuggerDefaults.overlayConsole).toBe(true);
    expect(parsed.debuggerDefaults.overlayInspector).toBe(true);
    expect(parsed.debuggerDefaults.pauseOnPlay).toBe(false);
  });

  it("keeps overlay chrome defaults when debuggerDefaults only has previewBuild", () => {
    const parsed = engineSettingsSchema.parse({
      debuggerDefaults: { previewBuild: true },
    });
    expect(parsed.debuggerDefaults.previewBuild).toBe(true);
    expect(parsed.debuggerDefaults.overlayStats).toBe(true);
    expect(parsed.debuggerDefaults.overlayConsole).toBe(true);
    expect(parsed.debuggerDefaults.overlayInspector).toBe(true);
    expect(parsed.debuggerDefaults.pauseOnPlay).toBe(false);
  });

  it("defaults post-processing on when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.postProcessingEnabled).toBe(true);
  });

  it("clamps graph default zoom to 0.1–1.5", () => {
    expect(engineSettingsSchema.parse({ graphDefaultZoom: 0.05 }).graphDefaultZoom).toBe(
      0.1,
    );
    expect(engineSettingsSchema.parse({ graphDefaultZoom: 3 }).graphDefaultZoom).toBe(
      1.5,
    );
  });

  it("fills focus keep-panel defaults when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.focusKeepPanels.scene).toEqual(["viewport"]);
    expect(parsed.focusKeepPanels.graph).toEqual(["graph"]);
    expect(parsed.focusKeepPanels.material).toEqual(["material-graph"]);
    expect(parsed.focusKeepPanels.ui).toEqual(["ui-design"]);
    expect(parsed.focusKeepPanels.uiLogic).toEqual(["graph"]);
    expect(parsed.focusKeepPanels["anim-graph"]).toEqual(["anim-graph-graph"]);
    expect(parsed.focusKeepPanels.animGraphObject).toEqual(["anim-object-graph"]);
    expect(parsed.focusKeepPanels["behaviour-tree"]).toEqual([
      "behaviour-tree-graph",
    ]);
    expect(parsed.focusKeepPanels["audio-mixer"]).toEqual([
      "audio-mixer-details",
    ]);
    expect(parsed.focusKeepPanels["audio-channel"]).toEqual([
      "audio-channel-details",
    ]);
    expect(parsed.focusKeepPanels["sound-attenuation"]).toEqual([
      "sound-attenuation-details",
    ]);
    expect(parsed.focusKeepPanels["particle-emitter"]).toEqual([
      "particle-emitter-preview",
    ]);
    expect(parsed.focusKeepPanels["particle-system"]).toEqual([
      "particle-system-preview",
    ]);
    expect(parsed.focusKeepPanels.model).toEqual(["model-preview"]);
    expect(parsed.focusKeepPanels.skeleton).toEqual(["skeleton-preview"]);
    expect(parsed.focusKeepPanels.animation).toEqual(["animation-preview"]);
    expect(parsed.focusKeepPanels["skybox-creator"]).toEqual([
      "skybox-creator-preview",
    ]);
  });

  it("fills new focus keep-list keys when saved JSON only has scene and graph", () => {
    const parsed = engineSettingsSchema.parse({
      focusKeepPanels: {
        scene: ["viewport", "scene-outliner"],
        graph: ["graph", "inspector"],
      },
    });
    expect(parsed.focusKeepPanels.scene).toEqual(["viewport", "scene-outliner"]);
    expect(parsed.focusKeepPanels.graph).toEqual(["graph", "inspector"]);
    expect(parsed.focusKeepPanels.material).toEqual(["material-graph"]);
    expect(parsed.focusKeepPanels.uiLogic).toEqual(["graph"]);
    expect(parsed.focusKeepPanels["script-interface"]).toEqual([
      "script-interface-preview",
    ]);
    expect(parsed.focusKeepPanels.audio).toEqual(["audio-preview"]);
  });

  it("accepts optional createdAt on recents", () => {
    const parsed = engineSettingsSchema.parse({
      recents: [
        {
          id: "opfs:Game.babproject",
          name: "Game.babproject",
          tier: "opfs",
          lastOpenedAt: "2026-08-18T12:00:00.000Z",
          createdAt: "2026-03-15T12:00:00.000Z",
        },
      ],
    });
    expect(parsed.recents[0]?.createdAt).toBe("2026-03-15T12:00:00.000Z");
  });

  it("round-trips through the memory store", async () => {
    const store = new MemoryAppSettingsStore();
    const next = engineSettingsSchema.parse({
      ...defaultEngineSettings(),
      templatesFolder: "/Templates",
      undoHistoryLength: 100,
      recents: [
        {
          id: "documents:Demo.babproject",
          name: "Demo.babproject",
          tier: "documents",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    await store.save(next);
    expect(await store.load()).toEqual(next);
  });

  it("persists through the web store", async () => {
    localStorage.clear();
    const store = new WebAppSettingsStore();
    const settings = defaultEngineSettings();
    settings.viewportFrameCap = 30;
    settings.graphDefaultZoom = 0.8;
    await store.save(settings);
    const reloaded = new WebAppSettingsStore();
    expect((await reloaded.load()).viewportFrameCap).toBe(30);
    expect((await reloaded.load()).graphDefaultZoom).toBe(0.8);
  });

  it("falls back to defaults when localStorage holds invalid JSON", async () => {
    localStorage.setItem("babylonslate:engine-settings", "{not-json");
    const store = new WebAppSettingsStore();
    expect((await store.load()).undoHistoryLength).toBe(50);
  });
});

describe("editorTextureLod", () => {
  it("defaults to balanced when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({ undoHistoryLength: 50 });
    expect(parsed.editorTextureLod).toBe("balanced");
  });

  it("accepts every level explicitly", () => {
    for (const lod of ["off", "balanced", "aggressive", "minimal", "tiny"]) {
      expect(engineSettingsSchema.parse({ editorTextureLod: lod }).editorTextureLod).toBe(lod);
    }
  });
});
