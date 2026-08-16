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
    });
    expect(settings.graphDefaultZoom).toBe(0.5);
    expect(settings.uiDesignerPresets).toEqual([]);
    expect(settings.debuggerDefaults.previewBuild).toBe(false);
  });

  it("fills viewportFrameCap at 30 when saved JSON omits the field", () => {
    const parsed = engineSettingsSchema.parse({
      undoHistoryLength: 50,
    });
    expect(parsed.viewportFrameCap).toBe(30);
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
