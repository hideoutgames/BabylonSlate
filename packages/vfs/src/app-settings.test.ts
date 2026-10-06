import { describe, expect, it, vi } from "vitest";
import {
  defaultEngineSettings,
  engineSettingsSchema,
} from "./app-settings";
import { MemoryAppSettingsStore } from "./memory-app-settings";
import { WebAppSettingsStore } from "./web-app-settings";

describe("app settings", () => {
  it("keeps inline pin editing enabled for existing devices and persists the local lock", async () => {
    localStorage.setItem("babylonslate:engine-settings", JSON.stringify({ graphDefaultZoom: 0.75 }));
    const store = new WebAppSettingsStore();
    expect((await store.load()).readOnlyPinDefaults).toBe(false);
    await store.update((settings) => { settings.readOnlyPinDefaults = true; });
    expect(await new WebAppSettingsStore().load()).toMatchObject({
      readOnlyPinDefaults: true, graphDefaultZoom: 0.75,
    });
    await new WebAppSettingsStore().update((settings) => { settings.readOnlyPinDefaults = false; });
    expect((await store.load()).readOnlyPinDefaults).toBe(false);
  });

  it("adds the trace budget when loading legacy preferences without losing existing settings", async () => {
    localStorage.setItem("babylonslate:engine-settings", JSON.stringify({
      undoHistoryLength: 75,
      debuggerDefaults: { overlayConsole: false },
    }));
    const settings = await new WebAppSettingsStore().load();
    expect(settings.traceByteBudget).toBe(134_217_728);
    expect(settings.undoHistoryLength).toBe(75);
    expect(settings.debuggerDefaults.overlayConsole).toBe(false);
  });

  it("bounds trace memory and rejects non-finite or non-numeric budgets", () => {
    expect(engineSettingsSchema.parse({ traceByteBudget: 0 }).traceByteBudget).toBe(1_048_576);
    expect(engineSettingsSchema.parse({ traceByteBudget: 2_147_483_648 }).traceByteBudget).toBe(268_435_456);
    expect(engineSettingsSchema.parse({ traceByteBudget: 2_000_000.4 }).traceByteBudget).toBe(2_000_000);
    for (const traceByteBudget of [NaN, Infinity, "128", null]) {
      expect(engineSettingsSchema.safeParse({ traceByteBudget }).success).toBe(false);
    }
  });

  it("loads a legacy Drop distance default and rejects invalid limits", () => {
    expect(engineSettingsSchema.parse({}).viewportDropDistance).toBe(10_000);
    for (const viewportDropDistance of [0, -1, Infinity, NaN]) {
      expect(engineSettingsSchema.safeParse({ viewportDropDistance }).success).toBe(false);
    }
  });
  it("round-trips recent project badges and tolerates legacy recents", async () => {
    const store = new MemoryAppSettingsStore();
    await store.update((settings) => {
      settings.recents = [
        {
          id: "new", name: "New", tier: "opfs", lastOpenedAt: "2026-09-09",
          appearance: { icon: "rocket", color: "lilac", image: "data:image/png;base64,AAAA" },
          sourceControl: true,
        },
        { id: "old", name: "Old", tier: "documents", lastOpenedAt: "2026-09-08" },
      ];
    });
    const loaded = await store.load();
    expect(loaded.recents[0]?.appearance).toEqual({
      icon: "rocket", color: "lilac", image: "data:image/png;base64,AAAA",
    });
    expect(loaded.recents[1]?.appearance).toBeUndefined();
    expect(loaded.recents.map((recent) => recent.sourceControl)).toEqual([true, undefined]);
  });

  it("drops malformed recent badge images without discarding project recents", () => {
    const settings = engineSettingsSchema.parse({
      recents: [{
        id: "game", name: "Game", tier: "opfs", lastOpenedAt: "2026-09-09",
        appearance: { icon: "box", color: "mint", image: "https://example.com/image.png" },
      }],
    });
    expect(settings.recents[0]?.appearance).toEqual({ icon: "box", color: "mint" });
  });

  it.each([
    ["an empty object", {}, {}],
    [
      "partial debugger defaults",
      { debuggerDefaults: { previewBuild: true } },
      { debuggerDefaults: { previewBuild: true } },
    ],
    [
      "a partial focus keep-list",
      { focusKeepPanels: { scene: ["viewport", "scene-outliner"], graph: ["graph", "inspector"] } },
      { focusKeepPanels: { scene: ["viewport", "scene-outliner"], graph: ["graph", "inspector"] } },
    ],
  ])("fills missing keys from defaults when saved JSON is %s", (_label, saved, kept) => {
    const defaults = defaultEngineSettings();
    const keptRecord = kept as Record<string, Record<string, unknown>>;
    const expected = { ...defaults } as Record<string, unknown>;
    for (const [key, value] of Object.entries(keptRecord))
      expected[key] = { ...(defaults as Record<string, unknown>)[key] as object, ...value };
    expect(engineSettingsSchema.parse(saved)).toEqual(expected);
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

  it("clamps audio PCM ceiling and max voices", () => {
    expect(engineSettingsSchema.parse({ audioByteCeiling: 1 }).audioByteCeiling).toBe(
      32 * 1024 * 1024,
    );
    expect(
      engineSettingsSchema.parse({ audioByteCeiling: 9 * 1024 * 1024 * 1024 })
        .audioByteCeiling,
    ).toBe(2 * 1024 * 1024 * 1024);
    expect(engineSettingsSchema.parse({ audioMaxVoices: 1 }).audioMaxVoices).toBe(8);
    expect(engineSettingsSchema.parse({ audioMaxVoices: 400 }).audioMaxVoices).toBe(
      128,
    );
  });

  it("migrates the old movement increment once and persists independent grid and snap values", () => {
    const legacy = engineSettingsSchema.parse({ viewportGridSize: 4 });
    expect(legacy.viewportSnapTranslate).toBe(4);
    const changed = engineSettingsSchema.parse({ ...legacy, viewportGridSize: 8 });
    expect(changed.viewportSnapTranslate).toBe(4);
    const reopened = engineSettingsSchema.parse(JSON.parse(JSON.stringify({
      ...changed, viewportSnapTranslate: 0.5,
    })));
    expect([reopened.viewportGridSize, reopened.viewportSnapTranslate]).toEqual([8, 0.5]);
    for (const value of [0, -1, Infinity, NaN])
      expect(engineSettingsSchema.safeParse({ viewportSnapTranslate: value }).success).toBe(false);
  });

  it("clamps graph default zoom to 0.1–1.5", () => {
    expect(engineSettingsSchema.parse({ graphDefaultZoom: 0.05 }).graphDefaultZoom).toBe(
      0.1,
    );
    expect(engineSettingsSchema.parse({ graphDefaultZoom: 3 }).graphDefaultZoom).toBe(
      1.5,
    );
  });

  it("keeps keybind overrides and drops a malformed map without losing other settings", () => {
    const parsed = engineSettingsSchema.parse({
      keybinds: { "editor.saveAll": ["Mod+Shift+S"], "edit.delete": [] },
    });
    expect(parsed.keybinds).toEqual({
      "editor.saveAll": ["Mod+Shift+S"],
      "edit.delete": [],
    });
    const recovered = engineSettingsSchema.parse({
      undoHistoryLength: 12,
      keybinds: { "editor.saveAll": "Mod+S" },
    });
    expect(recovered.keybinds).toEqual({});
    expect(recovered.undoHistoryLength).toBe(12);
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

  it("keeps loading settings saved with retired keys", () => {
    const parsed = engineSettingsSchema.parse({
      templatesFolder: "/Templates",
      defaultProjectLocation: "/Projects",
      undoHistoryLength: 100,
      debuggerDefaults: { showFps: true, logLevel: "debug", overlayConsole: false },
    });
    expect(parsed.undoHistoryLength).toBe(100);
    expect(parsed.debuggerDefaults.overlayConsole).toBe(false);
  });

  it("serializes debugger, viewport, appearance, and recent updates", async () => {
    localStorage.clear();
    const stores = Array.from({ length: 4 }, () => new WebAppSettingsStore());
    await Promise.all([
      stores[0]!.update((settings) => {
        settings.debuggerDefaults.overlayConsole = false;
      }),
      stores[1]!.update((settings) => {
        settings.viewportFlySpeed = 18;
        settings.viewportGridSize = 2;
        settings.viewportSnapRotateDeg = 45;
        settings.viewportSnapScale = 0.5;
      }),
      stores[2]!.update((settings) => {
        settings.appearance.theme = "dark";
      }),
      stores[3]!.update((settings) => {
        settings.recents.unshift({
          id: "opfs:Concurrent.babproject",
          name: "Concurrent.babproject",
          tier: "opfs",
          lastOpenedAt: "2026-09-04T00:00:00.000Z",
        });
      }),
    ]);
    const settings = await new WebAppSettingsStore().load();
    expect(settings.debuggerDefaults.overlayConsole).toBe(false);
    expect([settings.viewportFlySpeed, settings.viewportGridSize]).toEqual([
      18, 2,
    ]);
    expect(settings.viewportSnapRotateDeg).toBe(45);
    expect(settings.viewportSnapScale).toBe(0.5);
    expect(settings.appearance.theme).toBe("dark");
    expect(settings.recents[0]?.id).toBe("opfs:Concurrent.babproject");
  });

  it("emits persisted settings after update", async () => {
    localStorage.clear();
    const listener = vi.fn();
    window.addEventListener("babylonslate:engine-settings", listener);
    const persisted = await new WebAppSettingsStore().update((settings) => {
      settings.appearance.theme = "light";
    });
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      ...persisted,
      theme: "light",
    });
    window.removeEventListener("babylonslate:engine-settings", listener);
  });

  it("persists through the web store", async () => {
    localStorage.clear();
    const store = new WebAppSettingsStore();
    const settings = defaultEngineSettings();
    settings.viewportFrameCap = 30;
    settings.graphDefaultZoom = 0.8;
    settings.viewportDropDistance = 25_000.5;
    settings.traceByteBudget = 201_326_592;
    await store.save(settings);
    const reloaded = new WebAppSettingsStore();
    expect((await reloaded.load()).viewportFrameCap).toBe(30);
    expect((await reloaded.load()).graphDefaultZoom).toBe(0.8);
    expect((await reloaded.load()).viewportDropDistance).toBe(25_000.5);
    expect((await reloaded.load()).traceByteBudget).toBe(201_326_592);
  });

  it("falls back to defaults when localStorage holds invalid JSON", async () => {
    localStorage.setItem("babylonslate:engine-settings", "{not-json");
    const store = new WebAppSettingsStore();
    expect((await store.load()).undoHistoryLength).toBe(50);
  });
});
