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
    expect(settings.thumbnailsEnabled).toBe(true);
    expect(settings.appearance.theme).toBe("system");
    expect(settings.focusKeepPanels).toEqual({
      scene: ["viewport"],
      graph: ["graph"],
    });
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
    await store.save(settings);
    const reloaded = new WebAppSettingsStore();
    expect((await reloaded.load()).viewportFrameCap).toBe(30);
  });

  it("falls back to defaults when localStorage holds invalid JSON", async () => {
    localStorage.setItem("babylonslate:engine-settings", "{not-json");
    const store = new WebAppSettingsStore();
    expect((await store.load()).undoHistoryLength).toBe(50);
  });
});
